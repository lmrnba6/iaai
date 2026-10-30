/**
 * Damage Estimate PDF: download, verify via AI or keyword-based (BOLT_ON vs HARD_REPAIR).
 * Keeps only cars with straightforward bolt-on repairs (replace body parts).
 * Excludes hard repairs (frame damage, welding, pulling, airbag, structural).
 */

const axios = require('axios');
const { verifyRepairTypeWithAIPdf } = require('./gemini');

const log = (msg, ...args) => console.log('[damage-estimate]', msg, ...args);

const STRUCTURAL_KEYWORDS = [
  // Core Skeleton (exclude PILLAR/ROCKER alone – they match bolt-on trim: "A-Pillar garnish", "Rocker molding")
  'STRUCTURAL', 'UNIBODY', 'FRAME', 'RAIL', 'APRON',
  'FLOOR PAN', 'WHEEL HOUSE', 'ROOF', 'CENTER POST',
  'CHASSIS', 'TIE BAR', 'UPPER TIE BAR', 'CORE SUPPORT', 'STRUT TOWER',
  'DASH PANEL', 'COWL', 'REAR BODY PANEL', 'CROSSMEMBER', 'ENGINE CRADLE',
  'BODY FRONT SUPPORT', 'BODY SIDE SUPPORT', 'INNER SUPPORT',
  'SRS', 'AIRBAG', 'DEPLOYED', 'KNEE BOLSTER', 'CLOCKSPRING', 'RETRACTOR',
  'FRAME LABOR',
  // Pillar/Rocker only when structural context (section/weld/repair of actual member)
  'PILLAR SECTION', 'PILLAR WELD', 'PILLAR REPAIR',
  'ROCKER SECTION', 'ROCKER WELD', 'ROCKER REPAIR',
];

const STRUCTURAL_OPS = [
  'SET-UP', 'MEASURE', 'PULL', 'REALIGN', 'SECTION', 'STRAIGHTEN',
  'WELD', 'ROUGH PULL', 'FRAME SET', 'UNIBODY ALIGNMENT', 'PULL FOR SWAY',
  'SHEETMETAL PULL', 'PLUG WELD', 'CORRECTIVE PULL', 'SHEET METAL PULL',
];

const LABOR_RED_FLAGS = ['F', 'S', 'U'];

const TECH_MECH_KEYWORDS = [
  // Electronics & Programming
  'CALIBRATE', 'CALIBRATION', 'PROGRAM MODULE', 'POST SCAN', 'PRE SCAN',
  'DIAGNOSTIC', 'RADAR', 'ADAS', 'SENSORS', 'AIM', 'MODULE',
  // Mechanical Systems
  'ALIGNMENT', 'EVACUATE', 'RECHARGE', 'CONDENSER', 'RADIATOR',
  'SUSPENSION', 'STRUT', 'CONTROL ARM', 'WIRING HARNESS',
];

/** Extract text from PDF buffer. Always runs OCR on all PDFs; also extracts embedded text and combines. */
async function extractTextFromPdf(buffer) {
  if (!buffer || buffer.length === 0) return '';
  try {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    const textResult = await parser.getText();
    let embedded = typeof textResult.text === 'string' ? textResult.text.trim() : '';
    await parser.destroy();
    const ocrText = await extractTextFromPdfWithOcr(buffer);
    const combined = [embedded, ocrText].filter(Boolean).join('\n').trim();
    return combined || '';
  } catch (err) {
    log('PDF text extraction failed:', err.message);
    return '';
  }
}

/** Use pdf-parse getScreenshot + Tesseract OCR to extract text from scanned PDF pages. */
async function extractTextFromPdfWithOcr(buffer) {
  let parser;
  try {
    const { PDFParse } = require('pdf-parse');
    const { createWorker } = require('tesseract.js');
    parser = new PDFParse({ data: buffer });
    const result = await parser.getScreenshot({ scale: 2, first: 5 });
    const pages = result?.pages || [];
    if (pages.length === 0) return '';
    const worker = await createWorker('eng', 1, { logger: () => {} });
    const texts = [];
    for (let i = 0; i < pages.length; i++) {
      const pageData = pages[i];
      const imgBuffer = pageData?.data ?? pageData?.buffer;
      if (!imgBuffer) continue;
      const buf = Buffer.isBuffer(imgBuffer) ? imgBuffer : Buffer.from(imgBuffer);
      const { data } = await worker.recognize(buf);
      if (data?.text) texts.push(data.text.trim());
    }
    await worker.terminate();
    const combined = texts.join('\n').trim();
    log('OCR extracted', combined.length, 'chars from', pages.length, 'page(s)');
    return combined;
  } catch (err) {
    log('OCR fallback failed:', err.message);
    return '';
  } finally {
    if (parser && typeof parser.destroy === 'function') parser.destroy().catch(() => {});
  }
}

/**
 * Classify repair type from PDF text using keyword search. No AI required.
 * @param {string} text - extracted PDF text
 * @returns {{ repairType: 'BOLT_ON'|'HARD_REPAIR', partsList: string[], matchedKeyword?: string }}
 */
function verifyRepairTypeByKeywords(text) {
  if (!text || typeof text !== 'string' || text.length < 50) return { repairType: null, partsList: [] };
  const upper = text.toUpperCase();

  for (const kw of STRUCTURAL_KEYWORDS) {
    if (upper.includes(kw)) return { repairType: 'HARD_REPAIR', partsList: [], matchedKeyword: kw };
  }
  for (const op of STRUCTURAL_OPS) {
    if (upper.includes(op)) return { repairType: 'HARD_REPAIR', partsList: [], matchedKeyword: op };
  }
  for (const code of LABOR_RED_FLAGS) {
    const re = new RegExp('(?:LABOR|LBR|TYPE|OPER)\\s*[:\\s]*\\b' + code + '\\b', 'i');
    if (re.test(upper)) return { repairType: 'HARD_REPAIR', partsList: [], matchedKeyword: 'Labor:' + code };
  }
  // CCC/estimate format: -S, -F, -U as structural/frame/unibody codes (e.g. "L Frt Body Front Support Assy -S")
  if (/\-[FSU]\b/.test(upper) || /\b\([FSU]\)\b/.test(upper)) {
    return { repairType: 'HARD_REPAIR', partsList: [], matchedKeyword: 'LaborCode:-S/-F/-U' };
  }
  return { repairType: 'BOLT_ON', partsList: [] };
}

/** Download PDF with cookies, return buffer or null */
async function downloadPdf(url, cookies) {
  try {
    const cookieHeader = Array.isArray(cookies)
      ? cookies.map((c) => `${c.name}=${c.value}`).join('; ')
      : '';
    const { data } = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
        Cookie: cookieHeader,
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    return Buffer.isBuffer(data) ? data : Buffer.from(data);
  } catch (err) {
    log('PDF download failed:', err.message);
    return null;
  }
}

/**
 * Verify repair type from damage estimate PDF. Uses AI or keyword-based per mode.
 * @param {{ damageEstimatePdfUrl?: string }} car
 * @param {Array<{name:string,value:string}>} cookies - from page.cookies()
 * @param {{ delayMs?: number, mode?: 'ai'|'keyword' }} options
 * @returns {Promise<{repairType:'BOLT_ON'|'HARD_REPAIR'|null, partsList:string[], matchedKeyword?: string}>}
 */
async function verifyCarDamageEstimate(car, cookies, options = {}) {
  const url = (car.damageEstimatePdfUrl || '').trim();
  if (!url) return null;

  const buffer = await downloadPdf(url, cookies);
  if (!buffer || buffer.length < 100) return null;

  const delayMs = Math.max(0, options.delayMs || 2000);
  if (options.delayMs) await new Promise((r) => setTimeout(r, delayMs));

  const mode = (options.mode || 'ai').toLowerCase();
  if (mode === 'keyword') {
    const text = await extractTextFromPdf(buffer);
    const result = verifyRepairTypeByKeywords(text);
    return result;
  }
  const { repairType, partsList } = await verifyRepairTypeWithAIPdf(buffer);
  return { repairType, partsList };
}

/**
 * Enrich cars with damage estimate verification. Sets car.damageEstimateRepairType = 'BOLT_ON' | 'HARD_REPAIR' | null.
 * Filters to keep only BOLT_ON when filterBoltOnOnly is true.
 * @param {Array<object>} cars
 * @param {{ page: import('puppeteer').Page, filterBoltOnOnly?: boolean, delayMs?: number, mode?: 'ai'|'keyword' }} options
 */
async function enrichCarsWithDamageEstimateVerification(cars, options = {}) {
  const { page, filterBoltOnOnly = true, delayMs = 2000, mode = 'ai' } = options || {};
  if (!page) {
    log('No page for cookies; skipping damage estimate verification.');
    return cars;
  }

  const withPdf = cars.filter((c) => (c.damageEstimatePdfUrl || '').trim());
  if (withPdf.length === 0) {
    log('No cars with Damage Estimate PDF; skipping.');
    return cars;
  }

  let cookies = [];
  try {
    cookies = await page.cookies();
  } catch (err) {
    log('Could not get cookies:', err.message);
    return cars;
  }

  log('Verifying', withPdf.length, 'Damage Estimate PDFs (' + mode + ' mode)...');
  for (let i = 0; i < withPdf.length; i++) {
    const car = withPdf[i];
    const stock = car.stockNum || car.title || ('car#' + (i + 1));
    try {
      const result = await verifyCarDamageEstimate(car, cookies, { delayMs: i > 0 ? delayMs : 0, mode });
      car.damageEstimateRepairType = result?.repairType ?? result;
      car.damageEstimatePartsList = Array.isArray(result?.partsList) ? result.partsList : [];
      car.damageEstimateMatchedKeyword = result?.matchedKeyword || null;
      const extra = result?.matchedKeyword ? ' (' + result.matchedKeyword + ')' : (car.damageEstimatePartsList.length ? '(' + car.damageEstimatePartsList.length + ' parts)' : '');
      log(stock, '→', car.damageEstimateRepairType || '(no result)', extra);
    } catch (err) {
      log(stock, '→ error:', err.message);
      car.damageEstimateRepairType = null;
      car.damageEstimatePartsList = [];
    }
  }

  if (filterBoltOnOnly) {
    const before = cars.length;
    const kept = cars.filter((c) => {
      const hasPdf = !!(c.damageEstimatePdfUrl || '').trim();
      if (!hasPdf) return true; // No damage estimate report → keep
      if (c.damageEstimateRepairType === 'HARD_REPAIR') return false; // Verified hard repair → exclude
      return true; // BOLT_ON, or null/undefined (verification failed or skipped) → keep
    });
    const removed = before - kept.length;
    if (removed > 0) {
      log('Excluded', removed, 'cars (HARD_REPAIR). Keeping', kept.length);
    }
    return kept;
  }
  return cars;
}

module.exports = {
  downloadPdf,
  extractTextFromPdf,
  verifyCarDamageEstimate,
  enrichCarsWithDamageEstimateVerification,
};
