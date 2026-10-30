require('dotenv').config();
const express = require('express');
const path = require('path');
const { scrapeCars, getWarmStatus, getCookiesForPdf, warmScrapePage } = require('./scraper');
const { enrichCarsWithGeminiPrice } = require('./gemini');
const { downloadPdf } = require('./damage-estimate');
const { evaluateCarQueued } = require('./car-evaluator');
const app = express();
const PORT = process.env.PORT || 3003;

// Server-side memory storage for scraped cars
let storedCars = [];
let storedCarsTimestamp = null;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.render('index', { cars: [] });
});

app.get('/api/status', (req, res) => {
  res.json(getWarmStatus());
});

app.get('/api/memory-status', (req, res) => {
  res.json({
    hasData: storedCars.length > 0,
    count: storedCars.length,
    timestamp: storedCarsTimestamp
  });
});

/** Proxy Damage Estimate PDF download (IAA requires auth cookies). */
app.get('/api/pdf', async (req, res) => {
  const url = (req.query.url || '').trim();
  if (!url || (!url.startsWith('https://') && !url.startsWith('http://'))) {
    return res.status(400).send('Invalid or missing url');
  }
  if (!url.includes('iaai.com') && !url.includes('iaa.com')) {
    return res.status(400).send('Only IAA PDF URLs allowed');
  }
  try {
    const cookies = await getCookiesForPdf();
    const buffer = await downloadPdf(url, cookies);
    if (!buffer || buffer.length < 100) {
      return res.status(404).send('PDF not found or session expired. Run a scrape first.');
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="damage-estimate.pdf"');
    res.send(buffer);
  } catch (err) {
    console.error('[server] PDF proxy error:', err.message);
    res.status(500).send(err.message || 'Failed to fetch PDF');
  }
});

app.get('/api/cars', async (req, res) => {
  const locationsParam = (req.query.locations && String(req.query.locations).trim()) || '';
  const locations = locationsParam
    ? locationsParam.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const makesParam = (req.query.makes && String(req.query.makes).trim()) || '';
  const makes = makesParam ? makesParam.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const yearFrom = (req.query.yearFrom && String(req.query.yearFrom).trim()) || '';
  const yearTo = (req.query.yearTo && String(req.query.yearTo).trim()) || '';
  const maxKmParam = (req.query.maxKm && String(req.query.maxKm).trim()) || '';
  const maxKm = maxKmParam ? (Number(maxKmParam) || null) : null;
  const auctionFrom = (req.query.auctionFrom && String(req.query.auctionFrom).trim()) || '';
  const engineMinParam = (req.query.engineMin && String(req.query.engineMin).trim()) || '';
  const engineMaxParam = (req.query.engineMax && String(req.query.engineMax).trim()) || '';
  const engineMin = engineMinParam ? (Number(engineMinParam) || null) : null;
  const engineMax = engineMaxParam ? (Number(engineMaxParam) || null) : null;
  const carDetail = /^(1|true|yes)$/i.test(String(req.query.carDetail || '1').trim());
  const kennyUpull = /^(1|true|yes)$/i.test(String(req.query.kennyUpull || '1').trim());
  const geminiPrice = /^(1|true|yes)$/i.test(String(req.query.geminiPrice || '1').trim());
  const damageEstimateVerify = /^(1|true|yes)$/i.test(String(req.query.damageEstimateVerify || '0').trim());
  const damageEstimateMode = (req.query.damageEstimateMode || 'ai').toLowerCase();
  const options = { locations, makes, carDetail, kennyUpull, geminiPrice, damageEstimateVerify, damageEstimateMode: damageEstimateMode === 'keyword' ? 'keyword' : 'ai' };
  if (yearFrom) options.yearFrom = yearFrom;
  if (yearTo) options.yearTo = yearTo;
  if (maxKm != null && Number.isFinite(maxKm)) options.maxKm = maxKm;
  if (engineMin != null && Number.isFinite(engineMin)) options.engineMin = engineMin;
  if (engineMax != null && Number.isFinite(engineMax)) options.engineMax = engineMax;
  if (auctionFrom) options.auctionFrom = auctionFrom;
  console.log('[server] GET /api/cars - starting scrape...', locations.length ? 'locations: ' + locations.join(', ') : 'all', 'carDetail:', carDetail, 'kennyUpull:', kennyUpull, 'geminiPrice:', geminiPrice, 'damageEstimateVerify:', damageEstimateVerify);
  try {
    const cars = await scrapeCars(options);
    if (geminiPrice && cars.length > 0) {
      console.log('[server] Fetching average price (Gemini) for', cars.length, 'vehicles...');
      await enrichCarsWithGeminiPrice(cars);
    }
    console.log('[server] Scrape done. Returning', cars.length, 'vehicles.');
    // Store cars in server memory
    storedCars = cars;
    storedCarsTimestamp = new Date().toISOString();
    console.log('[server] Stored', storedCars.length, 'cars in memory at', storedCarsTimestamp);
    res.json({ cars, count: cars.length });
  } catch (err) {
    console.error('[server] Scrape error:', err.message);
    res.status(500).json({ error: err.message, cars: [] });
  }
});

app.get('/api/cars-from-memory', (req, res) => {
  if (storedCars.length === 0) {
    return res.status(404).json({ error: 'No data in memory. Run a scrape first.', cars: [] });
  }
  console.log('[server] Returning', storedCars.length, 'cars from memory (scraped at', storedCarsTimestamp + ')');
  res.json({ cars: storedCars, count: storedCars.length, timestamp: storedCarsTimestamp });
});

/** Per-car evaluation: Carfax VHR + Damage Estimate PDF + AI verdict. */
app.get('/api/evaluate-car', async (req, res) => {
  const stock = String(req.query.stock || '').trim();
  const refresh = /^(1|true|yes)$/i.test(String(req.query.refresh || '').trim());
  if (!stock) return res.status(400).json({ error: 'Missing stock parameter' });
  const car = storedCars.find((c) => String(c.stockNum || '').trim() === stock);
  if (!car) return res.status(404).json({ error: 'Car not found in memory. Run a scrape first.' });
  console.log('[server] GET /api/evaluate-car - stock', stock, refresh ? '(refresh)' : '');
  try {
    const result = await evaluateCarQueued(car, { refresh });
    res.json({ result });
  } catch (err) {
    console.error('[server] Evaluate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('[server] Warming scrape page in the background (IAA login + default filters)...');
  warmScrapePage().catch((err) => {
    console.error('[server] Warm page failed:', err.message, '– scrapes will launch their own browser.');
  });
});
