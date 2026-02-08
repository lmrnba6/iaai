const express = require('express');
const path = require('path');
const { scrapeCars } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.render('index', { cars: [] });
});

app.get('/api/cars', async (req, res) => {
  const locationsParam = (req.query.locations && String(req.query.locations).trim()) || '';
  const locations = locationsParam
    ? locationsParam.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const makesParam = (req.query.makes && String(req.query.makes).trim()) || '';
  const makes = makesParam ? makesParam.split(',').map((s) => s.trim()).filter(Boolean) : [];
  console.log('[server] GET /api/cars - starting scrape...', locations.length ? 'locations: ' + locations.join(', ') : 'all', makes.length ? 'makes: ' + makes.join(', ') : 'all makes');
  try {
    const cars = await scrapeCars({ locations, makes });
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
