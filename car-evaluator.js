/**
 * Per-car evaluation for a single vehicle:
 *   1. IAA detail page → free Carfax VHR link + Damage Estimate PDF link
 *   2. Carfax report (rendered in a browser tab) → ownership / sales history
 *   3. Damage Estimate PDF → parts that need to be replaced
 *   4. AI (Gemini/OpenAI) → final verdict summary
 * Runs one evaluation at a time (shared browser, anti-bot friendly) and caches by stock #.
 */

const { downloadPdf, extractTextFromPdf } = require('./damage-estimate');
const { getApiKey, getOpenAIKey, generateContentWithFallback, enrichCarsWithGeminiPrice } = require('./gemini');
const { getSharedBrowser, parseDetailPageAirBagsAndRestraint, loginIaa, enrichCarsWithKennyUpullLinks } = require('./scraper');
const puppeteer = require('puppeteer-extra'); // stealth plugin already registered by scraper.js

const log = (msg, ...args) => console.log('[evaluator]', msg, ...args);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const evaluationCache = new Map(); // stockNum -> { ts, result } — kept for the life of the server process
let queueTail = Promise.resolve();

/** Evaluator-owned fallback browser (used only when the shared warm browser is unavailable). */
let evalBrowser = null;
let evalPage = null;

/**
 * Get a browser session for evaluation: prefer the shared warm (logged-in) browser;
 * otherwise launch our own, log in to IAA, and keep it warm for later evaluations.
 * @param {{ vehicleDetailsUrl?: string }} car
 */
async function ensureBrowser(car) {
  const shared = getSharedBrowser();
  if (shared.browser && shared.page && !shared.page.isClosed()) return shared;
  if (evalBrowser && evalPage && !evalPage.isClosed() && evalBrowser.isConnected()) {
    return { browser: evalBrowser, page: evalPage };
  }
  log('No shared warm browser; launching a logged-in evaluation browser...');
  const headed = process.env.HEADED === '1' || process.env.HEADED === 'true';
  evalBrowser = await puppeteer.launch({
    headless: headed ? false : 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  evalPage = await evalBrowser.newPage();
  await evalPage.setViewport({ width: 1280, height: 800 });
  await evalPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  const hasLogin = !!(process.env.IAA_EMAIL || '').trim() && !!(process.env.IAA_PASSWORD || '').trim();
  if (hasLogin) {
    const ok = await loginIaa(evalPage);
    log('Evaluation browser login:', ok ? 'OK' : 'FAILED (report links may be hidden)');
  } else {
    log('No IAA credentials (IAA_EMAIL/IAA_PASSWORD); continuing unauthenticated.');
  }
  // Make sure the IAA site cookies exist in this session (needed for detail pages + PDF downloads)
  let home = 'https://ca.iaai.com/';
  try {
    if (car && car.vehicleDetailsUrl) home = new URL(car.vehicleDetailsUrl).origin + '/';
  } catch (e) { /* keep default */ }
  await evalPage.goto(home, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  return { browser: evalBrowser, page: evalPage };
}

/** Run evaluations one at a time; results are cached in memory until refresh is requested. */
function evaluateCarQueued(car, options = {}) {
  const stock = String(car && car.stockNum || car && car.vin || '').trim() || 'unknown';
  const cached = evaluationCache.get(stock);
  if (cached && !options.refresh) {
    log(stock, '→ cached result');
    return Promise.resolve(cached.result);
  }
  const run = queueTail.then(() => evaluateCar(car, options));
  queueTail = run.catch(() => {});
  return run.then((result) => {
    evaluationCache.set(stock, { ts: Date.now(), result });
    return result;
  });
}

/** Open the IAA detail page in a fresh tab and extract report links + declarations. Logs in first if needed. */
async function fetchDetailInfo(browser, car) {
  const url = (car.vehicleDetailsUrl || '').trim();
  if (!url) throw new Error('This car has no IAA detail page URL (run a scrape first).');
  const hasLogin = !!(process.env.IAA_EMAIL || '').trim() && !!(process.env.IAA_PASSWORD || '').trim();
  let tab = null;
  try {
    tab = await browser.newPage();
    const loadAndParse = async () => {
      await tab.goto(url, { waitUntil: 'load', timeout: 30000 });
      try {
        await tab.waitForSelector('a[href*="vhr.carfax.ca"]', { timeout: 10000 });
      } catch (e) { /* Carfax link may not exist */ }
      try {
        await tab.waitForSelector('a[href*="GetPdf"]', { timeout: 5000 });
      } catch (e) { /* Damage estimate link may not exist */ }
      await delay(800);
      const html = await tab.content();
      return parseDetailPageAirBagsAndRestraint(html);
    };
    let parsed = await loadAndParse();
    if (!parsed.carfaxReportUrl && hasLogin) {
      log('No Carfax link found; trying IAA login in the evaluation tab...');
      const ok = await loginIaa(tab);
      log('Evaluation tab login:', ok ? 'OK' : 'failed');
      if (ok) parsed = await loadAndParse();
    }
    return parsed;
  } finally {
    if (tab) tab.close().catch(() => {});
  }
}

/** Open the free Carfax VHR in a fresh tab, wait for the report to render, return its text. */
async function fetchCarfaxText(browser, url) {
  let tab = null;
  try {
    tab = await browser.newPage();
    await tab.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await tab.goto(url, { waitUntil: 'load', timeout: 60000 });
    // The report is a JS app: wait until real content replaces the "Collecting data..." splash
    await tab.waitForFunction(() => {
      const t = (document.body && document.body.innerText) || '';
      return t.length > 2500 && !/Collecting data from thousands of sources/i.test(t);
    }, { timeout: 90000 }).catch(() => {});
    await delay(1500);
    const text = await tab.evaluate(() => (document.body && document.body.innerText) || '');
    const trimmed = String(text).trim();
    if (trimmed.length < 200) {
      return { ok: false, error: 'Carfax page did not render (only ' + trimmed.length + ' chars)' };
    }
    return { ok: true, textLength: trimmed.length, text: trimmed.slice(0, 60000) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (tab) tab.close().catch(() => {});
  }
}

/** Best-effort parts list from damage estimate text: lines containing REPLACE. */
function extractReplaceParts(text) {
  if (!text) return [];
  const seen = new Set();
  const parts = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.length > 120) continue;
    if (!/\bREPL(ACE)?\b/i.test(line)) continue;
    const clean = line.replace(/^\W+/, '').replace(/\s+/g, ' ').replace(/\$[\d,.]+/g, '').replace(/\.{2,}/g, '.').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    parts.push(clean);
    if (parts.length >= 40) break;
  }
  return parts;
}

/** Parse the first JSON object out of an AI reply (tolerates fences and prose around it). */
function parseJsonLoose(text) {
  if (!text) return null;
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) return { parseError: true, raw: t.slice(0, 2000) };
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch (err) {
    return { parseError: true, raw: t.slice(0, 2000) };
  }
}

/** Ask Gemini/OpenAI for the final verdict combining Carfax + damage estimate. */
async function aiVerdict(car, s) {
  const carfaxText = (s.carfax && s.carfax.ok && s.carfax.text) ? s.carfax.text.slice(0, 30000) : '(no Carfax report available)';
  const pdfText = (s.damage && s.damage.ok && s.damage.text) ? s.damage.text.slice(0, 12000) : '(no damage estimate available)';
  const prompt = `You are a used-car evaluation expert helping a Canadian auto auction buyer (IAA).

Vehicle: ${car.year || ''} ${car.make || ''} ${car.model || ''} | VIN: ${car.vin || 'n/a'} | Stock: ${car.stockNum || 'n/a'}
Odometer: ${car.odometer || 'n/a'} | Damage: ${car.damage || car.primaryDamage || 'n/a'} | Declarations: ${car.declarations || 'n/a'}
Auction date: ${car.auctionDateTime || 'n/a'}

TASKS:
1. From the CARFAX REPORT below: how many previous owners did the vehicle have, and how many times was it SOLD / did ownership change BEFORE the auction date above? List each sale/transfer event with date and a short description. Note accident/damage records, odometer issues, and red flags (branded title, repeated quick resales = flipper/curbsider pattern).
2. From the DAMAGE ESTIMATE below: list the parts that need to be REPLACED (not repaired), and note any structural/frame/airbag work.
3. Verdict: 2-4 plain sentences for a parts/resale buyer - is this car a good buy, and what should be checked?

Reply with ONLY valid JSON (no markdown fences, no extra text) in exactly this shape:
{"previousOwners": 0, "timesSoldBeforeAuction": 0, "salesHistory": [{"date": "", "event": ""}], "accidentRecords": 0, "redFlags": [""], "partsToChange": [""], "structuralWork": "", "verdict": ""}

CARFAX REPORT:
${carfaxText}

DAMAGE ESTIMATE:
${pdfText}`;
  const raw = await generateContentWithFallback(prompt);
  return parseJsonLoose(raw);
}

/** Evaluate one car end-to-end. Never touches the warm search page (uses fresh tabs). */
async function evaluateCar(car) {
  const startedAt = Date.now();
  const hasIaaLogin = !!(process.env.IAA_EMAIL || '').trim() && !!(process.env.IAA_PASSWORD || '').trim();
  const { browser, page: sessionPage } = await ensureBrowser(car);
  const result = {
    stockNum: (car.stockNum || '').trim(),
    vin: (car.vin || '').trim(),
    title: (car.title || '').trim(),
    auctionDateTime: car.auctionDateTime || '',
    carfaxUrl: (car.carfaxReportUrl || '').trim(),
    damageEstimatePdfUrl: (car.damageEstimatePdfUrl || '').trim(),
    carfax: null,
    damage: null,
    ai: null,
    error: null,
  };
  let detailTab = null;
  try {
    if (!browser) throw new Error('No browser available for evaluation.');

    // 1) Ensure we have the report links (fetch detail page in a fresh tab if needed)
    if (!result.carfaxUrl || !result.damageEstimatePdfUrl) {
      log(result.stockNum || '(no stock)', 'fetching detail page for report links...');
      const detail = await fetchDetailInfo(browser, car);
      result.carfaxUrl = result.carfaxUrl || detail.carfaxReportUrl;
      result.damageEstimatePdfUrl = result.damageEstimatePdfUrl || detail.damageEstimatePdfUrl;
      if (detail.declarations && !car.declarations) car.declarations = detail.declarations;
      if (detail.airBagsDetail && !car.airBagsDetail) car.airBagsDetail = detail.airBagsDetail;
      if (detail.keysPresent && !car.keysPresent) car.keysPresent = detail.keysPresent;
      if (detail.restraintSystem && !car.restraintSystem) car.restraintSystem = detail.restraintSystem;
    }

    // Vehicle facts from the detail page (air bags status, keys, restraint, declarations)
    result.airBags = (car.airBagsDetail || '').trim();
    result.keysPresent = (car.keysPresent || '').trim();
    result.restraintSystem = (car.restraintSystem || '').trim();
    result.declarations = (car.declarations || '').trim();

    // 2) Carfax report
    if (result.carfaxUrl) {
      log(result.stockNum, 'loading Carfax report...');
      result.carfax = await fetchCarfaxText(browser, result.carfaxUrl);
      if (result.carfax.ok) {
        result.carfaxPreview = result.carfax.text.slice(0, 4000);
        delete result.carfax.text;
        log(result.stockNum, 'Carfax OK:', result.carfax.textLength, 'chars');
      } else {
        log(result.stockNum, 'Carfax failed:', result.carfax.error);
      }
    } else {
      result.carfax = { ok: false, error: hasIaaLogin
        ? 'No Carfax link found on the detail page (login may have failed — check the server log)'
        : 'IAA login required: add IAA_EMAIL and IAA_PASSWORD to your .env — the free Carfax link and full VIN need an IAA buyer account' };
    }

    // 3) Damage estimate PDF → parts to replace
    if (result.damageEstimatePdfUrl) {
      log(result.stockNum, 'downloading damage estimate PDF...');
      let cookies = [];
      if (sessionPage && !sessionPage.isClosed()) {
        try { cookies = await sessionPage.cookies(); } catch (err) { /* ignore */ }
      }
      const buffer = await downloadPdf(result.damageEstimatePdfUrl, cookies);
      if (buffer && buffer.length > 100) {
        const pdfText = await extractTextFromPdf(buffer);
        result.damage = {
          ok: true,
          textLength: pdfText.length,
          partsToChange: extractReplaceParts(pdfText),
          textPreview: pdfText.slice(0, 3000),
        };
        log(result.stockNum, 'Damage estimate OK:', pdfText.length, 'chars,', result.damage.partsToChange.length, 'REPLACE lines');
      } else {
        result.damage = { ok: false, error: 'PDF download failed (session may have expired — re-run the scrape)' };
      }
    } else {
      result.damage = { ok: false, error: hasIaaLogin
        ? 'No Damage Estimate PDF link on the detail page'
        : 'No Damage Estimate PDF link — may require IAA login (add IAA_EMAIL and IAA_PASSWORD to your .env)' };
    }

    // 4) AI verdict (optional)
    if (getApiKey() || getOpenAIKey()) {
      log(result.stockNum, 'asking AI for the verdict...');
      try {
        result.ai = await aiVerdict(car, {
          carfax: result.carfax && result.carfax.ok ? { ok: true, text: result.carfaxPreview } : { ok: false },
          damage: result.damage && result.damage.ok ? { ok: true, text: result.damage.textPreview } : { ok: false },
        });
      } catch (err) {
        result.ai = { error: 'AI summary failed: ' + err.message };
      }
    } else {
      result.ai = { error: 'No OPENAI_API_KEY or GEMINI_API_KEY set — showing raw data only' };
    }

    // Raw previews were only needed for the AI verdict — keep the API response lean
    delete result.carfaxPreview;
    if (result.damage) delete result.damage.textPreview;

    // 5) FB Marketplace minimum price (Ottawa) — reuse the scrape-time estimate when present
    if (getApiKey() || getOpenAIKey()) {
      let price = (car.averagePriceByCity || '').trim();
      if (!price) {
        log(result.stockNum, 'estimating FB Marketplace minimum price...');
        try {
          await enrichCarsWithGeminiPrice([car]);
          price = (car.averagePriceByCity || '').trim();
        } catch (err) {
          log(result.stockNum, 'price estimate failed:', err.message);
        }
      }
      result.marketMinPrice = price;
      result.demandScore = car.geminiDemandScore != null ? car.geminiDemandScore : null;
    }

    // 6) Kenny U-Pull inventory check (Ottawa + Gatineau) — run now if the scrape didn't
    if (!car.kennyUpullMatch) {
      log(result.stockNum, 'checking Kenny U-Pull inventory...');
      try {
        await enrichCarsWithKennyUpullLinks([car]);
      } catch (err) {
        log(result.stockNum, 'Kenny U-Pull check failed:', err.message);
      }
    }
    result.kennyUpullMatch = car.kennyUpullMatch || null;
    result.kennyUpullLink = (car.kennyUpullLink || '').trim();
  } catch (err) {
    result.error = err.message;
    log('FAILED', result.stockNum || '(no stock)', '–', err.message);
  } finally {
    if (detailTab) detailTab.close().catch(() => {});
  }
  result.tookMs = Date.now() - startedAt;
  return result;
}

module.exports = { evaluateCarQueued };
