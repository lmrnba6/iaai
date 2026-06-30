require('dotenv').config();
const express = require('express');
const path = require('path');
const { scrapeCars, getWarmStatus, getCookiesForPdf } = require('./scraper');
const { enrichCarsWithGeminiPrice } = require('./gemini');
const { downloadPdf } = require('./damage-estimate');
const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.render('index', { cars: [] });
});

app.get('/api/status', (req, res) => {
  res.json(getWarmStatus());
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
  const geminiPrice = /^(1|true|yes)$/i.test(String(req.query.geminiPrice || '0').trim());
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
    let cars = await scrapeCars(options);
    if (geminiPrice && cars.length > 0) {
      console.log('[server] Fetching average price (Gemini) for', cars.length, 'vehicles...');
      await enrichCarsWithGeminiPrice(cars);
    }
    console.log('[server] Scrape done. Returning', cars.length, 'vehicles.');
    res.json({ cars, count: cars.length });
  } catch (err) {
    console.error('[server] Scrape error:', err.message);
    res.status(500).json({ error: err.message, cars: [] });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
