/**
 * Gemini API: batched estimated min used car price in Ottawa (automatic, by mileage).
 * Uses Facebook Marketplace only for the estimate. Set GEMINI_API_KEY in your environment (e.g. in .env).
 */

const axios = require('axios');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Use a supported model: gemini-2.5-flash (stable) or gemini-2.0-flash
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
/** Max cars per batch to avoid token limits; one API call per batch */
const MAX_CARS_PER_BATCH = 10;
/** Delay in ms between AI API calls to reduce rate limit hits (set AI_CALL_DELAY_MS in .env to override) */
const AI_CALL_DELAY_MS = Math.max(0, parseInt(process.env.AI_CALL_DELAY_MS || '3000', 10) || 3000);

const log = (msg, ...args) => console.log('[gemini]', msg, ...args);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const OPENAI_BASE = 'https://api.openai.com/v1';

function getApiKey() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || '';
  return key.trim();
}
function getOpenAIKey() {
  const key = process.env.OPENAI_API_KEY || '';
  return key.trim();
}

/** Detect rate limit / quota errors so we can fall back to another provider */
function isRateLimitError(err) {
  const status = err.response?.status;
  const msg = (err.response?.data?.error?.message || err.message || '').toLowerCase();
  if (status === 429) return true;
  return /rate limit|resource exhausted|quota|too many requests|overloaded/i.test(msg);
}

/** Parse odometer string (e.g. "123,456 Km" or "76,543 mi") to km. Returns NaN if unparseable. */
function parseOdometerKm(str) {
  if (!str || typeof str !== 'string') return NaN;
  const num = parseFloat(str.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(num)) return NaN;
  if (/mi\b/i.test(str)) return num * 1.60934;
  return num;
}

/**
 * Call Gemini generateContent and return the text of the first candidate.
 * Tries MODEL first, then gemini-2.0-flash if model not found.
 * @param {string} prompt
 * @param {string} [modelOverride] - optional model to use
 * @returns {Promise<string>}
 */
async function generateContent(prompt, modelOverride = null) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set. Add it to your .env file.');
  }
  const modelsToTry = modelOverride ? [modelOverride] : [MODEL, 'gemini-2.0-flash'];
  let lastError;
  for (const modelName of modelsToTry) {
    const url = `${GEMINI_BASE}/models/${modelName}:generateContent?key=${apiKey}`;
    try {
      const { data } = await axios.post(
        url,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 4096,
            temperature: 0.3,
          },
        },
        {
          timeout: 20000,
          headers: { 'Content-Type': 'application/json' },
          validateStatus: (s) => s >= 200 && s < 500,
        }
      );
      if (data.error) {
        const msg = data.error.message || JSON.stringify(data.error);
        if (/not found|not supported/i.test(msg)) {
          lastError = new Error(msg);
          continue;
        }
        throw new Error(msg);
      }
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      return typeof text === 'string' ? text.trim() : '';
    } catch (err) {
      if (/not found|not supported/i.test(err.message || '')) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('Gemini model not available');
}

/**
 * Call OpenAI Chat Completions (e.g. gpt-4o-mini). Same prompt/response contract as Gemini.
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function generateContentOpenAI(prompt) {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const url = `${OPENAI_BASE}/chat/completions`;
  const { data } = await axios.post(
    url,
    {
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
      temperature: 0.3,
    },
    {
      timeout: 25000,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      validateStatus: (s) => s >= 200 && s < 500,
    }
  );
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.choices?.[0]?.message?.content;
  return typeof text === 'string' ? text.trim() : '';
}

/** When rate limited, try this provider first on next call (alternate) */
let preferProviderOnRateLimit = null;

/**
 * Call Gemini with PDF inline. Pass the PDF buffer directly (no text extraction).
 * @param {string} prompt
 * @param {Buffer} pdfBuffer
 * @returns {Promise<string>}
 */
async function generateContentGeminiWithPdf(prompt, pdfBuffer) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const base64 = pdfBuffer.toString('base64');
  const url = `${GEMINI_BASE}/models/${MODEL}:generateContent?key=${apiKey}`;
  const { data } = await axios.post(
    url,
    {
      contents: [{
        parts: [
          { inlineData: { mimeType: 'application/pdf', data: base64 } },
          { text: prompt },
        ],
      }],
      generationConfig: {
        maxOutputTokens: 1024,
        temperature: 0.2,
      },
    },
    {
      timeout: 60000,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: (s) => s >= 200 && s < 500,
    }
  );
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * Call OpenAI with PDF. Uses vision API (gpt-4o) for PDF input.
 * @param {string} prompt
 * @param {Buffer} pdfBuffer
 * @returns {Promise<string>}
 */
async function generateContentOpenAIWithPdf(prompt, pdfBuffer) {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const base64 = pdfBuffer.toString('base64');
  const url = `${OPENAI_BASE}/chat/completions`;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const { data } = await axios.post(
    url,
    {
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: `data:application/pdf;base64,${base64}` },
          },
        ],
      }],
      max_tokens: 1024,
      temperature: 0.2,
    },
    {
      timeout: 60000,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      validateStatus: (s) => s >= 200 && s < 500,
    }
  );
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.choices?.[0]?.message?.content;
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * Try OpenAI first; on rate limit or failure, try Gemini. Pass PDF directly (no parsing).
 * Alternates provider when rate limited.
 * @param {string} prompt
 * @param {Buffer} pdfBuffer
 * @returns {Promise<string>}
 */
async function generateContentWithPdfFallback(prompt, pdfBuffer) {
  const errors = [];
  const hasOpenAI = !!getOpenAIKey();
  const hasGemini = !!getApiKey();
  const order = preferProviderOnRateLimit === 'openai' ? ['gemini', 'openai'] : preferProviderOnRateLimit === 'gemini' ? ['openai', 'gemini'] : ['openai', 'gemini'];
  const providers = order.filter((p) => (p === 'openai' && hasOpenAI) || (p === 'gemini' && hasGemini));

  for (const provider of providers) {
    try {
      if (provider === 'openai') {
        const text = await generateContentOpenAIWithPdf(prompt, pdfBuffer);
        log('PDF verify: OpenAI');
        preferProviderOnRateLimit = null;
        return text;
      }
      if (provider === 'gemini') {
        const text = await generateContentGeminiWithPdf(prompt, pdfBuffer);
        log('PDF verify: Gemini');
        preferProviderOnRateLimit = null;
        return text;
      }
    } catch (err) {
      if (isRateLimitError(err)) {
        log(provider === 'openai' ? 'OpenAI rate limited, switching to Gemini...' : 'Gemini rate limited, switching to OpenAI...');
        preferProviderOnRateLimit = provider;
        errors.push({ provider, err });
      } else {
        log(provider, 'PDF error:', err.message);
        errors.push({ provider, err });
      }
    }
  }
  const msg = errors.length ? errors.map((e) => `${e.provider}: ${e.err.message}`).join('; ') : 'No API key set';
  throw new Error(msg);
}

/**
 * Try OpenAI first; on rate limit or failure, try Gemini. Alternates provider when rate limited.
 * @param {string} prompt
 * @returns {Promise<string>} raw response text
 */
async function generateContentWithFallback(prompt) {
  const errors = [];
  const hasOpenAI = !!getOpenAIKey();
  const hasGemini = !!getApiKey();
  const order = preferProviderOnRateLimit === 'openai' ? ['gemini', 'openai'] : preferProviderOnRateLimit === 'gemini' ? ['openai', 'gemini'] : ['openai', 'gemini'];
  const providers = order.filter((p) => (p === 'openai' && hasOpenAI) || (p === 'gemini' && hasGemini));

  for (const provider of providers) {
    try {
      if (provider === 'openai') {
        const text = await generateContentOpenAI(prompt);
        log('Batch: OpenAI (ChatGPT)');
        preferProviderOnRateLimit = null;
        return text;
      }
      if (provider === 'gemini') {
        const text = await generateContent(prompt);
        log('Batch: Gemini');
        preferProviderOnRateLimit = null;
        return text;
      }
    } catch (err) {
      if (isRateLimitError(err)) {
        log(provider === 'openai' ? 'OpenAI rate limited, switching to Gemini...' : 'Gemini rate limited, switching to OpenAI...');
        preferProviderOnRateLimit = provider;
        errors.push({ provider, err });
      } else throw err;
    }
  }
  const msg = errors.length ? errors.map((e) => `${e.provider}: ${e.err.message}`).join('; ') : 'No API key set (OPENAI_API_KEY or GEMINI_API_KEY)';
  throw new Error(msg);
}

const REPAIR_PROMPT = `You are an expert auto body repair estimator. I am sending you a vehicle damage estimate PDF.

Classify the repair as:
- BOLT_ON: Straightforward repair with only replacing/repairing bolt-on body parts (bumper, fender, hood, door, quarter panel, etc.). No frame damage, no structural welding, no pulling/stretching, no airbag/SRS work, no unibody repair.
- HARD_REPAIR: Any of: frame damage, structural damage, welding required, pulling/stretching, airbag/SRS deployment/repair, unibody repair, radiator support damage, suspension damage, or complex repairs beyond simple bolt-on replacement.

Reply in this exact format:
- First line: BOLT_ON or HARD_REPAIR
- If BOLT_ON: add a second line "Parts:" followed by the list of parts to replace (comma-separated), e.g. "Parts: bumper cover, fender, hood"
- If HARD_REPAIR: no additional lines needed`;

/**
 * Verify repair type from damage estimate PDF. Pass the PDF directly to AI (no text extraction).
 * For BOLT_ON, also extracts the parts list.
 * @param {Buffer} pdfBuffer - raw PDF bytes
 * @returns {Promise<{repairType:'BOLT_ON'|'HARD_REPAIR'|null, partsList:string[]}>}
 */
async function verifyRepairTypeWithAIPdf(pdfBuffer) {
  if (!pdfBuffer || pdfBuffer.length < 100) return { repairType: null, partsList: [] };
  try {
    const text = (await generateContentWithPdfFallback(REPAIR_PROMPT, pdfBuffer))?.trim() || '';
    const upper = text.toUpperCase();
    let repairType = null;
    if (upper.includes('BOLT_ON')) repairType = 'BOLT_ON';
    else if (upper.includes('HARD_REPAIR')) repairType = 'HARD_REPAIR';

    let partsList = [];
    if (repairType === 'BOLT_ON') {
      const partsMatch = text.match(/Parts:\s*([^\n]+)/i);
      if (partsMatch) {
        partsList = partsMatch[1]
          .split(/[,;]/)
          .map((p) => p.trim())
          .filter(Boolean);
      }
    }
    return { repairType, partsList };
  } catch (err) {
    log('Repair type verification failed:', err.message);
    return { repairType: null, partsList: [] };
  }
}

/** Extract min and average price from a line like "Ottawa: $5,000 - $7,000." -> "$5,000 - $7,000"; single price -> "$5,000" */
function extractMinAvgPrice(line) {
  if (!line || typeof line !== 'string') return '';
  const all = line.match(/\$[\d,]+/g);
  if (!all || all.length === 0) return '';
  if (all.length >= 2) return all[0] + ' - ' + all[1];
  return all[0];
}

/** Strip markdown code blocks and extra formatting from AI response */
function stripMarkdown(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/^```[\w]*\n?/g, '')
    .replace(/\n?```$/g, '')
    .replace(/\*\*/g, '')
    .trim();
}

/**
 * Parse batched Gemini response into per-index "min - avg" or single price (no city label).
 * Expects lines like "1) Ottawa: $5,000 - $7,000. Demand score: 7/10" etc.
 * Also handles "1.", "1:", "Vehicle 1:", and bare lines with $ in order.
 * @param {string} text - raw response
 * @returns {Map<number, string>} 1-based index -> "$min - $avg" or "$min"
 */
function parseBatchedPriceResponse(text) {
  const map = new Map();
  if (!text || typeof text !== 'string') return map;
  const cleaned = stripMarkdown(text);
  const lines = cleaned.split(/\n/).map((s) => s.trim()).filter(Boolean);
  const numberPrefix = /^\s*(?:\*\*)?(\d+)(?:\)|\.|:)\s*(.+)$/;
  for (const line of lines) {
    let m = line.match(numberPrefix);
    if (m) {
      const idx = parseInt(m[1], 10);
      const priceStr = extractMinAvgPrice(m[2]);
      if (priceStr && !map.has(idx)) map.set(idx, priceStr);
    } else if (/\$[\d,]+/.test(line)) {
      const priceStr = extractMinAvgPrice(line);
      if (priceStr) {
        const nextIdx = map.size + 1;
        if (!map.has(nextIdx)) map.set(nextIdx, priceStr);
      }
    }
  }
  return map;
}

/** Parse demand score 1-10 from a line like "... Demand score: 7/10" or "... score: 7" */
function extractDemandScore(line) {
  if (!line || typeof line !== 'string') return null;
  const m = line.match(/(?:demand\s*)?score:\s*(\d+)/i) || line.match(/(\d+)\s*\/\s*10\s*\.?\s*$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 10 ? n : null;
}

/**
 * Parse batched Gemini response for demand scores (1-10) per vehicle.
 * @param {string} text - raw response
 * @returns {Map<number, number>} 1-based index -> score 1-10
 */
function parseBatchedScoreResponse(text) {
  const map = new Map();
  if (!text || typeof text !== 'string') return map;
  const cleaned = stripMarkdown(text);
  const lines = cleaned.split(/\n/).map((s) => s.trim()).filter(Boolean);
  const numberPrefix = /^\s*(?:\*\*)?(\d+)(?:\)|\.|:)\s*(.+)$/;
  for (const line of lines) {
    const m = line.match(numberPrefix);
    if (m) {
      const idx = parseInt(m[1], 10);
      const score = extractDemandScore(m[2]);
      if (score != null && !map.has(idx)) map.set(idx, score);
    }
  }
  return map;
}

/**
 * Enrich cars with estimated min price in Ottawa (Gemini). Uses Facebook Marketplace only; UI displays only the min price.
 * @param {Array<{year?: string, make?: string, model?: string, odometer?: string}>} cars
 */
async function enrichCarsWithGeminiPrice(cars) {
  const hasAnyKey = getOpenAIKey() || getApiKey();
  if (!hasAnyKey) {
    log('No price API key set (OPENAI_API_KEY or GEMINI_API_KEY); skipping.');
    cars.forEach((c) => { c.averagePriceByCity = ''; c.geminiDemandScore = null; });
    return;
  }
  cars.forEach((c) => { c.averagePriceByCity = ''; c.geminiDemandScore = null; });
  const withMake = cars.filter((c) => {
    const y = (c.year || '').trim();
    const m = (c.make || '').trim();
    const title = (c.title || '').trim();
    return (y && m) || (title && title.length > 5);
  });
  if (withMake.length === 0) return;
  for (let start = 0; start < withMake.length; start += MAX_CARS_PER_BATCH) {
    const batch = withMake.slice(start, start + MAX_CARS_PER_BATCH);
    const lines = batch.map((car, i) => {
      const num = start + i + 1;
      let year = (car.year || '').trim();
      let make = (car.make || '').trim();
      let model = (car.model || '').trim();
      if (!year || !make) {
        const parts = (car.title || '').trim().split(/\s+/).filter(Boolean);
        if (parts.length >= 1 && /^\d{4}$/.test(parts[0])) year = parts[0];
        if (parts.length >= 2) make = parts[1];
        if (parts.length >= 3) model = parts.slice(2).join(' ');
      }
      const km = parseOdometerKm(car.odometer);
      const kmStr = Number.isFinite(km) ? `, ~${Math.round(km).toLocaleString()} km` : '';
      return `${num}) ${year} ${make} ${model}${kmStr}, automatic`;
    });
    const vehicleList = lines.join('\n');
    const prompt = `For each vehicle below, estimate the used car market minimum price in CAD in Ottawa. Use only Facebook Marketplace. Base your estimate only on make, model, year, and mileage (km). All vehicles are automatic transmission. Reply with exactly one line per vehicle in the same order. Format: "1) Ottawa: $X,XXX" (minimum price) or "1) Ottawa: $X,XXX - $X,XXX" (min and average). Example: "1) Ottawa: $5,000 - $6,500"\n\nVehicles:\n${vehicleList}`;
    try {
      if (start > 0) await delay(AI_CALL_DELAY_MS);
      let text;
      try {
        text = await generateContentWithFallback(prompt);
      } catch (fallbackErr) {
        if (getSerpApiKey()) {
          log('Fallback: using SerpAPI (search) for price/demand.');
          text = await generateContentFromSerpAPI(batch, start);
        } else throw fallbackErr;
      }
      const parsed = parseBatchedPriceResponse(text);
      const scoreMap = parseBatchedScoreResponse(text);
      const parsedCount = parsed.size;
      if (parsedCount === 0 && text) {
        log('Parse fallback: AI response format may differ. First 300 chars:', text.slice(0, 300));
      }
      batch.forEach((car, i) => {
        const idx = start + i + 1;
        car.averagePriceByCity = parsed.get(idx) || '';
        const s = scoreMap.get(idx);
        car.geminiDemandScore = s != null ? s : null;
      });
      log('Batch', Math.floor(start / MAX_CARS_PER_BATCH) + 1, ':', batch.length, 'vehicles, parsed', parsedCount, 'prices.');
    } catch (err) {
      log('Batch error:', err.message);
      batch.forEach((c) => { c.averagePriceByCity = ''; c.geminiDemandScore = null; });
    }
  }
  const withPrice = cars.filter((c) => (c.averagePriceByCity || '').trim()).length;
  log('Average price (Gemini, Ottawa, Facebook only):', withPrice, 'of', cars.length, 'vehicles.');
}

module.exports = { enrichCarsWithGeminiPrice, getApiKey, getOpenAIKey, verifyRepairTypeWithAIPdf, generateContentWithFallback };
