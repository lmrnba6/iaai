/**
 * Scrapes the IAA search page HTML and extracts vehicle listings using Cheerio.
 * Uses Puppeteer (with stealth) to load the page in a real browser so we get
 * past Incapsula / "I'm human" checks. Still parses the HTML with Cheerio (no API).
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const axios = require('axios');
const { hasAirBagsIntact, keysPresentYes, carMatchesLocations, isOnNotBranded, hasForbiddenDamageCode } = require('./filters');

puppeteer.use(StealthPlugin());

const SEARCH_URL = 'https://ca.iaai.com/search';

/** Kenny U-Pull inventory search: Ottawa + Gatineau, All Years */
const KENNY_UPULL_BASE = 'https://kennyupull.com/auto-parts/our-inventory/';
const KENNY_BRANCH_OTTAWA = '1457182';
const KENNY_BRANCH_GATINEAU = '1457192';
const KENNY_CHECK_DELAY_MS = 800;
const IAA_BASE = 'https://ca.iaai.com';
const DETAIL_PAGE_DELAY_MS = 600;

const log = (msg, ...args) => console.log('[scraper]', msg, ...args);

/** Selectors for the left-side filters on the IAA search page */
const FILTERS = {
  branchPanel: '#auctionBranchFilter',
  branchPanelToggle: 'a[href="#auctionBranchFilter"]',
  ottawaCheckbox: '[id="20|-61"]',
  ottawaLabel: 'label[for="20|-61"]',
  featuredPanel: '#filterSpecialtyVehicle-filter',
  runDriveCheckbox: '[id="41|RUN_DRIVE"]',
  runDriveLabel: 'label[for="41|RUN_DRIVE"]',
  vehicleTypePanel: '#filterVehicleType-filter',
  vehicleTypeToggle: 'a[href="#filterVehicleType-filter"]',
  passengerCarCheckbox: '[id="33|15"]',
  passengerCarLabel: 'label[for="33|15"]',
  suvCheckbox: '[id="33|18"]',
  suvLabel: 'label[for="33|18"]',
  highEndCheckbox: '[id="41|HIGH_END"]',
  highEndLabel: 'label[for="41|HIGH_END"]',
  theftRecoveryCheckbox: '[id="41|THEFT_RECOVERY"]',
  theftRecoveryLabel: 'label[for="41|THEFT_RECOVERY"]',
};

const FILTER_WAIT_MS = 3500;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Apply site filters: only requested locations (branch) when checked in filter panel, then Run/Drive, Passenger Car, SUV, High End, Theft Recovery.
 * @param {import('puppeteer').Page} page
 * @param {{ locations?: string[] }} options - branch names to select (e.g. ['Ottawa', 'Montreal East']). Only branches in this list are checked on IAA; if empty, no branch filter is applied.
 */
async function applySiteFilters(page, options = {}) {
  const locations = Array.isArray(options.locations) ? options.locations.map((s) => String(s).trim()).filter(Boolean) : [];
  log('Applying site filters. Branch (only if in panel selection):', locations.length ? locations.join(', ') : '(none – no branch filter)', '| Run/Drive, Passenger Car, SUV, etc....');

  const waitForGridUpdate = async () => {
    await delay(FILTER_WAIT_MS);
    try {
      await page.waitForFunction(
        () => {
          const grid = document.querySelector('#runListKendoGrid tbody');
          return grid && !grid.querySelector('.k-loading-mask');
        },
        { timeout: 10000 }
      );
    } catch {
      // ignore timeout; grid may not use loading mask
    }
  };

  try {
    // 1) Branch: only check branches that are in the filter panel selection (Ottawa, Toronto, Toronto North, Toronto West, Montreal East, Montreal West, etc.)
    if (locations.length > 0) {
      const branchToggle = await page.$(FILTERS.branchPanelToggle);
      if (branchToggle) {
        const isExpanded = await page.evaluate((el) => {
          const panel = document.querySelector('#auctionBranchFilter');
          return panel && panel.classList.contains('show');
        }, branchToggle);
        if (!isExpanded) {
          await branchToggle.click();
          await delay(500);
        }
      }
      const branchClicked = await page.evaluate((selectedLocations) => {
        const panel = document.querySelector('#auctionBranchFilter');
        if (!panel) return 0;
        const inputs = panel.querySelectorAll('input[type="checkbox"]');
        const allowed = (selectedLocations || []).map((s) => String(s).trim().toLowerCase());
        let count = 0;
        for (const input of inputs) {
          const label = panel.querySelector('label[for="' + input.id + '"]');
          const text = (label && label.textContent) ? label.textContent.trim().toLowerCase() : '';
          if (!text) continue;
          const match = allowed.some((loc) => text.indexOf(loc) !== -1);
          if (match && !input.checked) {
            if (label) label.click();
            else input.click();
            count++;
          }
        }
        return count;
      }, locations);
      if (branchClicked > 0) {
        log('Checked branch(es) on IAA:', branchClicked, '–', locations.join(', '));
        await waitForGridUpdate();
      }
    } else {
      log('No locations selected in filter panel; skipping branch filter on IAA.');
    }

    // 2) Ensure Featured Vehicles is expanded and select Run/Drive
    const runDrive = await page.$(FILTERS.runDriveCheckbox);
    if (runDrive) {
      await runDrive.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await delay(300);
      const checked = await page.evaluate((el) => el.checked, runDrive);
      if (!checked) {
        const label = await page.$(FILTERS.runDriveLabel);
        if (label) await label.click();
        else await runDrive.evaluate((el) => el.click());
        log('Checked Run/Drive.');
        await waitForGridUpdate();
      } else {
        log('Run/Drive already selected.');
      }
    } else {
      log('Run/Drive filter not found; skipping.');
    }

    // 3) Vehicle Type: expand and select Passenger Car + SUV
    const vehicleTypeToggle = await page.$(FILTERS.vehicleTypeToggle);
    if (vehicleTypeToggle) {
      const typeExpanded = await page.evaluate(() => {
        const panel = document.querySelector('#filterVehicleType-filter');
        return panel && panel.classList.contains('show');
      });
      if (!typeExpanded) {
        await vehicleTypeToggle.click();
        await delay(500);
      }
    }

    for (const { name, checkboxSel, labelSel } of [
      { name: 'Passenger Car', checkboxSel: FILTERS.passengerCarCheckbox, labelSel: FILTERS.passengerCarLabel },
      { name: 'SUV', checkboxSel: FILTERS.suvCheckbox, labelSel: FILTERS.suvLabel },
    ]) {
      const el = await page.$(checkboxSel);
      if (el) {
        await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
        await delay(200);
        const checked = await page.evaluate((e) => e.checked, el);
        if (!checked) {
          const label = await page.$(labelSel);
          if (label) await label.click();
          else await el.evaluate((e) => e.click());
          log('Checked', name + '.');
          await waitForGridUpdate();
        }
      } else {
        log(name, 'filter not found; skipping.');
      }
    }

    // 4) Featured Vehicles: High End + Theft Recovery
    for (const { name, checkboxSel, labelSel } of [
      { name: 'High End', checkboxSel: FILTERS.highEndCheckbox, labelSel: FILTERS.highEndLabel },
      { name: 'Theft Recovery', checkboxSel: FILTERS.theftRecoveryCheckbox, labelSel: FILTERS.theftRecoveryLabel },
    ]) {
      const el = await page.$(checkboxSel);
      if (el) {
        await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
        await delay(200);
        const checked = await page.evaluate((e) => e.checked, el);
        if (!checked) {
          const label = await page.$(labelSel);
          if (label) await label.click();
          else await el.evaluate((e) => e.click());
          log('Checked', name + '.');
          await waitForGridUpdate();
        }
      } else {
        log(name, 'filter not found; skipping.');
      }
    }

  } catch (err) {
    log('Error applying filters (continuing with current page):', err.message);
  }
}

/** Wait for the results grid to appear (or timeout). Returns HTML. */
async function getHtmlWithBrowser(options = {}) {
  const headed = process.env.HEADED === '1' || process.env.HEADED === 'true';
  const timeoutMs = 60000; // 60s so you have time to solve CAPTCHA in headed mode

  log('Launching browser (headed:', headed, ')...');
  const browser = await puppeteer.launch({
    headless: headed ? false : 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    log('Navigating to', SEARCH_URL, '...');
    try {
      await page.goto(SEARCH_URL, {
        waitUntil: 'load',
        timeout: 60000,
      });
      log('Navigation complete.');
    } catch (gotoErr) {
      log('Navigation failed:', gotoErr.message);
      throw gotoErr;
    }

    log('Waiting for results grid (up to', timeoutMs / 1000, 's)...');
    if (headed) {
      log('Headed mode: if you see an "I\'m human" / CAPTCHA box, solve it in the browser window.');
    }

    // Wait for the vehicle grid to appear (means we're past the challenge)
    try {
      await page.waitForSelector('#runListKendoGrid tbody tr[role="row"]', {
        timeout: timeoutMs,
      });
      log('Results grid appeared.');
    } catch (e) {
      log('Grid wait failed:', e.message);
      const hasIncapsula = await page.evaluate(() =>
        document.body.innerText.includes('Incapsula') ||
        document.body.innerText.includes('not human') ||
        document.body.innerText.includes('unusual traffic')
      );
      if (hasIncapsula) {
        log('Page shows bot check. Run with HEADED=1 and solve the checkbox in the browser.');
      } else {
        log('Grid not found after', timeoutMs / 1000, 's. Taking snapshot anyway.');
      }
    }

    // Apply site filters: only requested locations (Branch) + Run/Drive, etc.
    log('Applying site filters (locations, Run/Drive, etc.)...');
    await applySiteFilters(page, options);
    const searchUrl = await page.url();
    log('URL after left filters applied:', searchUrl);
    log('Filters applied. Getting page HTML...');

    const html = await page.content();
    if (options.keepBrowserOpen) {
      log('Keeping browser open for detail-page fetches.');
      return { html, browser, page };
    }
    await browser.close();
    return html;
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

/**
 * Parse vehicle list from HTML (same as before).
 * @returns {Array<{year, make, model, vin, stockNum, ...}>}
 */
function parseCarsFromHtml(html) {
  const $ = cheerio.load(html);
  const cars = [];
  const grid = $('#runListKendoGrid');
  const gridFound = grid.length > 0;
  log('Grid #runListKendoGrid found:', gridFound);

  if (!grid.length) {
    const anyStockLink = $('a.stockLinkHeader').length;
    log('Fallback: a.stockLinkHeader in page:', anyStockLink);
    return cars;
  }

  const rows = grid.find('tbody tr[role="row"]').toArray();
  log('tbody tr[role="row"] count:', rows.length);

  let i = 0;
  while (i < rows.length) {
    const row1 = $(rows[i]);
    const row2 = rows[i + 1] ? $(rows[i + 1]) : null;
    const titleLink = row1.find('a.stockLinkHeader');
    if (!titleLink.length && !row2) break;
    if (!titleLink.length) {
      i++;
      continue;
    }

    const titleText = titleLink.text().trim();
    const detailHref = titleLink.attr('href') || '';
    const vehicleDetailsUrl = detailHref
      ? (detailHref.startsWith('http') ? detailHref : IAA_BASE + (detailHref.startsWith('/') ? '' : '/') + detailHref)
      : '';
    const parts = titleText.split(/\s+/);
    const year = parts.length > 0 ? parts[0] : '';
    const make = parts.length > 1 ? parts[1] : '';
    const model = parts.length > 2 ? parts.slice(2).join(' ') : '';

    const img = row1.find('img.gridImageStyle');
    const imageUrl = img.attr('src') || '';

    let vin = '', stockNum = '', damage = '', damageEstimate = '';
    let odometer = '', transmission = '', condition = '', engine = '', fuelType = '';
    let branch = '', location = '', brand = '', laneRun = '';
    let auctionDateTime = '';

    if (row2 && row2.length) {
      const td1 = row2.find('td.runlist-td-1');
      const td2 = row2.find('td.runlist-td-2');
      const td3 = row2.find('td.runlist-td-3');
      const buttonTd = row2.find('td').last();
      const auctionEl = buttonTd.find('.auctionDateTimeDisplay');
      if (auctionEl.length) auctionDateTime = auctionEl.first().text().trim();

      td1.find('div').each((_, el) => {
        const $el = $(el);
        const text = $el.text().trim();
        if (text.startsWith('VIN')) vin = text.replace(/^VIN\s*#?:\s*/i, '').trim();
        else if (text.startsWith('Stock')) stockNum = ($el.find('.runlist-td-value a').text().trim() || text.replace(/^Stock\s*#?:\s*/i, '').replace(/\D/g, '')).trim();
        else if (text.includes('Damage Estimate')) damageEstimate = text.replace(/Damage Estimate:\s*/i, '').trim();
        else if ($el.find('.runlist-td-width').length) damage = $el.find('.runlist-td-width').text().trim();
      });

      td2.find('div').each((_, el) => {
        const $el = $(el);
        const label = $el.find('.runlist-td-label').text().trim();
        const value = $el.find('.runlist-td-value').text().trim();
        const spanVal = $el.find('span').last().text().trim();
        if (label.includes('Transmission')) transmission = value || spanVal;
        else if (label.includes('Engine')) engine = value || spanVal;
        else if (label.includes('Fuel Type')) fuelType = value || spanVal;
        else if (!label && spanVal && ['RunAndDrive', 'Start', 'Starts'].some(s => spanVal.includes(s))) condition = spanVal;
        else if (!odometer && (value.includes('Km') || value.includes('mi') || value === 'Unknown')) odometer = value;
      });
      if (!odometer) {
        const odomSpan = td2.find('.runlist-td-value').first().text().trim();
        if (odomSpan) odometer = odomSpan;
      }

      branch = td3.find('.bpLink a').first().text().trim();
      const locSpan = td3.find('span[aria-label="Location Name"]');
      if (locSpan.length) location = locSpan.text().trim();
      const laneDiv = td3.find('div').filter((_, el) => $(el).text().includes('Lane:'));
      if (laneDiv.length) laneRun = laneDiv.text().trim();
      brand = td3.find('div').last().text().trim();
    }

    cars.push({
      year, make, model, vin, stockNum, damage, damageEstimate,
      odometer, transmission, condition, engine, fuelType,
      branch, location, brand, laneRun, imageUrl, title: titleText,
      auctionDateTime, vehicleDetailsUrl,
    });
    i += 2;
  }

  return cars;
}

/**
 * Build Kenny U-Pull inventory search URL for make/model (Ottawa + Gatineau, All Years).
 * @param {string} make
 * @param {string} model
 * @returns {string}
 */
function buildKennyUpullUrl(make, model) {
  if (!make || typeof make !== 'string') return '';
  const brand = make.trim().toLowerCase().replace(/\s+/g, '-');
  const modelSlug = (model && typeof model === 'string')
    ? model.trim().toLowerCase().replace(/\s+/g, '-')
    : '';
  const params = new URLSearchParams();
  params.set('brand', brand);
  if (modelSlug) params.set('model', modelSlug);
  params.set('model_year', 'all-years');
  params.append('branch[]', KENNY_BRANCH_OTTAWA);
  params.append('branch[]', KENNY_BRANCH_GATINEAU);
  return KENNY_UPULL_BASE + '?' + params.toString() + '#search-filters';
}

/**
 * Fetch Kenny U-Pull inventory page and parse results count (e.g. "2,026 results" or "0 results").
 * @param {string} url
 * @returns {Promise<{ hasResults: boolean, resultsCount: number }>}
 */
async function getKennyUpullResultsCount(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    const $ = cheerio.load(data);
    const resultsText = $('.results p').first().text().trim();
    const match = resultsText.match(/(\d[\d,]*)\s*results?/i);
    const count = match ? parseInt(match[1].replace(/,/g, ''), 10) : 0;
    const hasResults = Number.isFinite(count) && count > 0;
    return { hasResults, resultsCount: count };
  } catch (err) {
    log('Kenny U-Pull check failed:', url, err.message);
    return { hasResults: false, resultsCount: 0 };
  }
}

/**
 * For each car, check Kenny U-Pull inventory (make/model, Ottawa+Gatineau, All Years) and set kennyUpullLink if any results.
 * @param {Array<{make:string, model?:string}>} cars
 */
async function enrichCarsWithKennyUpullLinks(cars) {
  const urlToHasResults = new Map();
  for (let idx = 0; idx < cars.length; idx++) {
    const car = cars[idx];
    const make = (car.make || '').trim();
    const model = (car.model || '').trim();
    if (!make) continue;
    const url = buildKennyUpullUrl(make, model);
    if (!url) continue;
    if (urlToHasResults.has(url)) {
      if (urlToHasResults.get(url)) car.kennyUpullLink = url;
      continue;
    }
    await delay(KENNY_CHECK_DELAY_MS);
    const { hasResults } = await getKennyUpullResultsCount(url);
    urlToHasResults.set(url, hasResults);
    if (hasResults) {
      car.kennyUpullLink = url;
      log('Kenny U-Pull has parts:', make, model);
    }
  }
  const withLink = cars.filter((c) => c.kennyUpullLink).length;
  log('Kenny U-Pull:', withLink, 'of', cars.length, 'vehicles have inventory link.');
}

/**
 * Parse IAA vehicle details page HTML for Air Bags, Keys Present, Restraint System, Primary/Secd/Other Damages, High Pre-Bid.
 * @param {string} html
 * @returns {{ airBagsDetail: string, restraintSystem: string, keysPresent: string, primaryDamage: string, secdDamage: string, otherDamages: string, highPrebid: string }}
 */
function parseDetailPageAirBagsAndRestraint(html) {
  const $ = cheerio.load(html);
  let airBagsDetail = '';
  let restraintSystem = '';
  let keysPresent = '';
  let primaryDamage = '';
  let secdDamage = '';
  let otherDamages = '';
  let highPrebid = '';
  $('#vehicleDescriptionlistView .data-list__item').each((_, el) => {
    const $el = $(el);
    const label = $el.find('.data-list__label').text().trim();
    const value = $el.find('.data-list__value').text().trim();
    if (/Air\s*Bags?/i.test(label)) airBagsDetail = value;
    if (/Keys\s*Present/i.test(label)) keysPresent = value;
    if (/Primary\s*Damage/i.test(label)) primaryDamage = value;
    if (/Secd\.?\s*Damage/i.test(label)) secdDamage = value;
    if (/Other\s*Damages?/i.test(label)) otherDamages = value;
  });
  $('#vehicleInformationlistView .data-list__item').each((_, el) => {
    const $el = $(el);
    const label = $el.find('.data-list__label').text().trim();
    const value = $el.find('.data-list__value').text().trim();
    if (/Restraint\s*System/i.test(label)) restraintSystem = value;
  });
  // High Pre-Bid: in BID INFORMATION (main area or Pre-Bid popup). Match "High Pre-Bid" or "Current High Bid"; value often in .data-list__value or label.runlistPrebidRed/Green
  const highPreBidLabelRe = /High\s*Pre-?Bid|Current\s*High\s*Bid/i;
  const priceLikeRe = /\$[\d,]+(?:\.\d{2})?/;
  const pickPrice = (text) => {
    if (!text || typeof text !== 'string') return '';
    const t = text.trim().replace(/\s+/g, ' ');
    const m = t.match(priceLikeRe);
    return m ? m[0] : t;
  };
  // Prefer main bid area then any .data-list__item
  ['#vdp_vehicleBidInfo-AN', '#divPreBid', 'body'].forEach((scope) => {
    if (highPrebid) return;
    $(scope).find('.data-list__item').each((_, el) => {
      if (highPrebid) return;
      const $el = $(el);
      const label = $el.find('.data-list__label').text().trim();
      if (!highPreBidLabelRe.test(label)) return;
      let value = $el.find('.data-list__value').text().trim();
      if (!value) value = $el.find('label.runlistPrebidRed, label.runlistPrebidGreen').text().trim();
      if (value) highPrebid = pickPrice(value);
    });
  });
  return { airBagsDetail, restraintSystem, keysPresent, primaryDamage, secdDamage, otherDamages, highPrebid };
}

/**
 * Fetch each car's IAA detail page and set airBagsDetail, restraintSystem, keysPresent.
 * Uses Puppeteer page when provided (same session as search = full HTML); otherwise axios (often blocked).
 * @param {Array<{vehicleDetailsUrl?: string}>} cars
 * @param {import('puppeteer').Page} [page] - same browser session as search page; use for detail fetches so IAA serves full HTML
 */
async function enrichCarsWithDetailPageData(cars, page) {
  const total = cars.length;
  const useBrowser = !!page;

  for (let idx = 0; idx < total; idx++) {
    const car = cars[idx];
    const url = car.vehicleDetailsUrl;
    const stock = car.stockNum || car.title || ('car#' + (idx + 1));
    if (!url) {
      log('Detail skip [' + (idx + 1) + '/' + total + ']: no URL for', stock);
      continue;
    }
    await delay(DETAIL_PAGE_DELAY_MS);
    log('Detail fetch [' + (idx + 1) + '/' + total + ']:', stock, useBrowser ? '(browser)' : '(axios)', url);
    try {
      let data = '';
      if (useBrowser) {
        const gotoRes = await page.goto(url, { waitUntil: 'load', timeout: 20000 });
        if (gotoRes && gotoRes.status() >= 200 && gotoRes.status() < 400) {
          await delay(800);
          // Wait for BID INFORMATION / High Pre-Bid to appear (may be loaded by JS)
          try {
            await page.waitForFunction(
              () => {
                const el = document.getElementById('vdp_vehicleBidInfo-AN');
                if (el && (el.innerText || '').includes('High Pre-Bid')) return true;
                return !!document.querySelector('.vdp_vehicleBidInfo-bid-Data-list');
              },
              { timeout: 3000 }
            );
          } catch {
            // ignore; capture HTML anyway
          }
          await delay(400);
          data = await page.content();
        }
      } else {
        const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        const res = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': ua }, maxRedirects: 5, validateStatus: (s) => s >= 200 && s < 400 });
        data = typeof res.data === 'string' ? res.data : '';
      }
      const dataLen = data.length;
      const { airBagsDetail, restraintSystem, keysPresent, primaryDamage, secdDamage, otherDamages, highPrebid } = parseDetailPageAirBagsAndRestraint(data);
      car.airBagsDetail = airBagsDetail;
      car.restraintSystem = restraintSystem;
      car.keysPresent = keysPresent;
      car.primaryDamage = primaryDamage;
      car.secdDamage = secdDamage;
      car.otherDamages = otherDamages;
      car.highPrebid = highPrebid;
      const hasDesc = data.indexOf('vehicleDescriptionlistView') !== -1;
      const hasInfo = data.indexOf('vehicleInformationlistView') !== -1;
      // log(
      //   'Detail OK [' + (idx + 1) + '/' + total + '] len=' + dataLen + ' desc=' + (hasDesc ? 'Y' : 'n') + ' info=' + (hasInfo ? 'Y' : 'n') + ' | Air Bags=' + (airBagsDetail || '(empty)') + ' Keys=' + (keysPresent || '(empty)') + ' Restraint=' + (restraintSystem || '(empty)').slice(0, 35)
      // );
      if (!airBagsDetail && !keysPresent && !restraintSystem && dataLen < 5000) {
        log('Detail parse empty for', stock, '– page may be login/redirect or selectors missing');
      }
    } catch (err) {
      log('Detail FAIL [' + (idx + 1) + '/' + total + ']', stock, '–', err.message);
    }
  }
  const withDetail = cars.filter((c) => c.airBagsDetail != null && c.airBagsDetail !== '').length;
  log('Detail pages: Air Bags / Restraint set for', withDetail, 'of', cars.length, 'vehicles.');
}

/**
 * Fetch the search page via browser and parse vehicles.
 * @returns {Promise<Array<{year, make, model, vin, stockNum, ..., kennyUpullLink?}>>}
 */
async function scrapeCars(options = {}) {
  const locations = Array.isArray(options.locations) ? options.locations.map((s) => String(s).trim()).filter(Boolean) : [];
  log('Starting scrape (browser):', SEARCH_URL, '| locations:', locations.length ? locations.join(', ') : '(none – all branches)');

  let html;
  let browser = null;
  let page = null;
  try {
    const result = await getHtmlWithBrowser({ locations, keepBrowserOpen: true });
    if (typeof result === 'string') {
      html = result;
    } else {
      html = result.html;
      browser = result.browser;
      page = result.page;
    }
  } catch (err) {
    log('Browser fetch failed:', err.message);
    throw err;
  }

  try {
    const htmlLen = typeof html === 'string' ? html.length : 0;
    log('HTML length:', htmlLen);

    let cars = parseCarsFromHtml(html);
    log('Scrape finished. Vehicles extracted:', cars.length);

    const beforeBranchBrand = cars.length;
    cars = cars.filter((c) => carMatchesLocations(c, locations) && isOnNotBranded(c));
    log('After branch (selected locations) and brand=ON-NOT BRANDED or QC-AUCUN STATUT:', cars.length, 'of', beforeBranchBrand, 'vehicles.');

    if (Array.isArray(options.makes) && options.makes.length > 0) {
      const allowedMakes = options.makes.map((m) => String(m).trim().toLowerCase()).filter(Boolean);
      const beforeMakes = cars.length;
      cars = cars.filter((c) => {
        const make = (c.make || '').trim().toLowerCase();
        const title = (c.title || '').toLowerCase();
        return allowedMakes.some((m) => make === m || title.includes(m));
      });
      log('After make filter (' + options.makes.join(', ') + '):', cars.length, 'of', beforeMakes, 'vehicles.');
    }

    const beforeTrans = cars.length;
    cars = cars.filter((c) => /auto/i.test((c.transmission || '').trim()));
    log('After transmission=Auto only:', cars.length, 'of', beforeTrans, 'vehicles.');

    if (cars.length > 0) {
      log('First vehicle:', cars[0].year, cars[0].make, cars[0].model, '| Branch:', cars[0].branch, '| Trans:', cars[0].transmission);
    }

    if (cars.length > 0) {
      log('Fetching vehicle detail pages via same browser session (Air Bags, Keys, Restraint)...');
      await enrichCarsWithDetailPageData(cars, page);
    }

    // Log why each car is excluded before applying the final filter
    const beforeDetailFilter = cars.length;
    let excludedCount = 0;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      const stock = c.stockNum || c.title || ('car#' + (i + 1));
      const airBagsOk = hasAirBagsIntact(c);
      const keysOk = keysPresentYes(c);
      const noForbiddenDamage = !hasForbiddenDamageCode(c);
      if (airBagsOk && keysOk && noForbiddenDamage) continue;
      excludedCount++;
      const reasons = [];
      if (!airBagsOk) reasons.push("Air Bags='" + (c.airBagsDetail || '(empty)') + "' (need INTACT)");
      if (!keysOk) reasons.push("Keys Present='" + (c.keysPresent || '(empty)') + "' (need Yes)");
      if (!noForbiddenDamage) reasons.push("forbidden damage: Primary='" + (c.primaryDamage || '') + "' Secd='" + (c.secdDamage || '') + "' Other='" + (c.otherDamages || '') + "'");
      log('Excluded [' + (i + 1) + '/' + beforeDetailFilter + ']', stock, '–', reasons.join('; '));
    }
    if (excludedCount > 0) {
      log('Excluded', excludedCount, 'of', beforeDetailFilter, 'vehicles (see reasons above).');
    }

    cars = cars.filter(
      (c) => hasAirBagsIntact(c) && keysPresentYes(c) && !hasForbiddenDamageCode(c)
    );
    log('Keeping only cars with Air Bags=INTACT, Keys=Yes, no forbidden damage codes:', cars.length, 'of', beforeDetailFilter, 'vehicles.');

    if (cars.length > 0) {
      log('Checking Kenny U-Pull inventory (Ottawa + Gatineau) for verified make/model...');
      await enrichCarsWithKennyUpullLinks(cars);
    }

    return cars;
  } finally {
    if (browser) {
      log('Closing browser.');
      await browser.close().catch(() => {});
    }
  }
}

module.exports = { scrapeCars, SEARCH_URL, getHtmlWithBrowser, parseCarsFromHtml };
