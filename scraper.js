/**
 * Scrapes the IAA search page HTML and extracts vehicle listings using Cheerio.
 * Uses Puppeteer (with stealth) to load the page in a real browser so we get
 * past Incapsula / "I'm human" checks. Still parses the HTML with Cheerio (no API).
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const axios = require('axios');
const { hasAirBagsIntact, keysPresentYes, carMatchesLocations, isOnNotBranded, hasForbiddenDamageCode, hasMechanicalIssues, hasMechInDeclarations, parseAuctionDate, isMonthDayEqual } = require('./filters');
const { enrichCarsWithDamageEstimateVerification } = require('./damage-estimate');
const { getApiKey: getGeminiKey, getOpenAIKey } = require('./gemini');

puppeteer.use(StealthPlugin());

const SEARCH_URL = process.env.IAA_SEARCH_URL || 'https://ca.iaai.com/search';
const IAA_BASE = (() => { try { return new URL(SEARCH_URL).origin; } catch { return 'https://ca.iaai.com'; } })();

/** Default left-side filters applied when warming the scrape page at server start. Run/Drive not pre-checked – filter client-side instead. */
const DEFAULT_LEFT_FILTERS = { locations: ['Ottawa'], runAndDrive: false };

/** Kenny U-Pull inventory search: Ottawa + Gatineau, All Years */
const KENNY_UPULL_BASE = 'https://kennyupull.com/auto-parts/our-inventory/';
const KENNY_BRANCH_OTTAWA = '1457182';
const KENNY_BRANCH_GATINEAU = '1457192';
const KENNY_CHECK_DELAY_MS = 800;
const DETAIL_PAGE_DELAY_MS = 600;

const log = (msg, ...args) => console.log('[scraper]', msg, ...args);

const LOGIN_URL = 'https://login.iaai.com/Identity/Account/Login?ReturnUrl=%2Fconnect%2Fauthorize%2Fcallback%3Fclient_id%3DImpactBuyerPortal%26redirect_uri%3Dhttps%253A%252F%252Fca.iaai.com%252FAccount%252FExternalLoginCallback%26response_type%3Dcode%26scope%3Dopenid%2520profile%2520email%2520phone%2520offline_access%26code_challenge%3DptK7O_tEu3eGF4MB8G8vQ1nol45dB5Kal6rZ30rLZTg%26code_challenge_method%3DS256%26state%3DOpenIdConnect.AuthenticationProperties%253DSNcGJbb0M1R5l0CPw8SF7k70PexbqUYseVtU42QqYYJSSpHEhmdl1-e2ertj1qboqjqEhJ5QCH37C90uTFo0YDkjmtUqCSlSRJYE4a3v4gnqviZscpX26GxgvVpC91ehN7gyFDsuUwqd-t0j9GgfGSXMKQ_CTKteooOOSMbFMgFRsUveHDwzGXjk_yIoiXtf0T1dBNIuStfb0LmemDWJaxthTNVmPtMpn_2TYtfszOOOpM_5tjq_k3RrBnm4HAhjJSypb7uWYmgkd_FC5mk0wB9-3XxFhkx3ywjtof8wYY1nYYZdpvuF0FvPuMTKdASa%26response_mode%3Dform_post%26nonce%3D639078037753368130.ZTNkZmM5ZjktNGVhYS00MTY3LWE3NGUtYjMzYWY0MmJmZjViOTZkNjQ3YjMtYTIxNS00NWVkLTlkNTAtYzMxMjczOGZmNTZi%26culture%3Den-us%26x-client-SKU%3DID_NET461%26x-client-ver%3D5.3.0.0&culture=en-us';

/**
 * Log in to IAA with email/password from env (IAA_EMAIL, IAA_PASSWORD).
 * Navigates directly to login page, fills form.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>} true if login succeeded, false if skipped (no creds) or failed
 */
async function loginIaa(page) {
  const email = (process.env.IAA_EMAIL || '').trim();
  const password = (process.env.IAA_PASSWORD || '').trim();
  if (!email || !password) return false;

  log('IAA credentials found; logging in...');
  try {
    log('Navigating to login page...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2000);

    const emailSel = '#Email, #Input_Email, input[name="Input.Email"]';
    await page.waitForSelector(emailSel, { timeout: 10000 });
    const passSel = '#Password, #Input_Password, input[name="Input.Password"]';
    await page.waitForSelector(passSel, { timeout: 5000 });
    await delay(500);

    await page.evaluate(({ e, p }) => {
      const emailEl = document.querySelector('#Email') || document.querySelector('#Input_Email') || document.querySelector('input[name="Input.Email"]');
      const passEl = document.querySelector('#Password') || document.querySelector('#Input_Password') || document.querySelector('input[name="Input.Password"]');
      if (emailEl) { emailEl.value = e; emailEl.dispatchEvent(new Event('input', { bubbles: true })); }
      if (passEl) { passEl.value = p; passEl.dispatchEvent(new Event('input', { bubbles: true })); }
    }, { e: email, p: password });

    await delay(300);

    const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 });
    const submitBtn = await page.$('form#account button[type="submit"], form button[type="submit"], input[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.evaluate(() => {
        const form = document.querySelector('form#account') || document.querySelector('form');
        if (form) form.submit();
      });
    }
    await navPromise;

    await delay(500);
    const url = page.url();
    const stillOnLogin = /\/account\/login|login\.iaai\.com\/Identity/i.test(url);
    if (stillOnLogin) {
      try {
        const errText = await page.evaluate(() => document.querySelector('#lblErrorMessage, .alert-error')?.innerText || '');
        log('Login failed – still on login page.', errText ? errText.trim() : '');
      } catch (_) {}
      return false;
    }
    // Wait for OAuth callback to complete – session cookies set when we land on ca.iaai.com
    try {
      await page.waitForFunction(
        () => window.location.hostname === 'ca.iaai.com',
        { timeout: 15000 }
      );
      log('Landed on ca.iaai.com, waiting for session...');
      await delay(2500); // let callback set cookies; redirects may follow
    } catch (e) {
      log('Login: did not reach ca.iaai.com – session may not be set.', e.message);
      return false;
    }
    const finalUrl = page.url();
    log('Login succeeded. URL:', finalUrl.slice(0, 90) + (finalUrl.length > 90 ? '...' : ''));
    return true;
  } catch (err) {
    if (/Execution context was destroyed/i.test(err.message || '')) {
      log('Login: page navigated during form fill. Trying to continue – you may see masked VINs.');
    } else {
      log('Login error:', err.message);
    }
    return false;
  }
}

/** Selectors for the left-side filters on the IAA search page */
const FILTERS = {
  branchPanel: '#auctionBranchFilter',
  branchPanelToggle: 'a[href="#auctionBranchFilter"]',
  ottawaCheckbox: '[id="20|-61"]',
  ottawaLabel: 'label[for="20|-61"]',
  featuredPanel: '#filterSpecialtyVehicle-filter',
  vehicleAttributePanel: '#filterVehicleAttribute-filter',
  vehicleAttributePanelToggle: 'a[href="#filterVehicleAttribute-filter"]',
  runDriveCheckbox: '[id="41|RUN_DRIVE"]',
  runDriveLabel: 'label[for="41|RUN_DRIVE"]',
  vehicleTypePanel: '#filterVehicleType-filter',
  vehicleTypeToggle: 'a[href="#filterVehicleType-filter"]',
  passengerCarCheckbox: '[id="33|15"]',
  passengerCarLabel: 'label[for="33|15"]',
  suvCheckbox: '[id="33|18"]',
  suvLabel: 'label[for="33|18"]',
  lightTruckCheckbox: '[id="33|10"]',
  lightTruckLabel: 'label[for="33|10"]',
  highEndCheckbox: '[id="41|HIGH_END"]',
  highEndLabel: 'label[for="41|HIGH_END"]',
  theftRecoveryCheckbox: '[id="41|THEFT_RECOVERY"]',
  theftRecoveryLabel: 'label[for="41|THEFT_RECOVERY"]',
  yearPanelToggle: 'a[href="#YearFilter"]',
  yearPanel: '#YearFilter',
  yearFilterFrom: '#YearFilterFrom',
  yearFilterTo: '#YearFilterTo',
  yearFilterApply: '#filterVehicleYear-ApplyYear',
};

const FILTER_WAIT_MS = 3500;
const PAGINATION_PAGE_DELAY_MS = 1500;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Shared browser and page kept warm after server start (default left filters applied). */
let sharedBrowser = null;
let sharedPage = null;
let warmPromise = null;
/** True while warmScrapePage() is running (applying default filters). */
let warmInProgress = false;
/** Last applied left-side filter state (locations) so we only apply changes when using the warm page. */
let lastAppliedLocations = null;

/** Returns { ready: boolean, warming: boolean } for the status API. */
function getWarmStatus() {
  return { ready: !!sharedPage, warming: warmInProgress };
}

/** Get cookies from shared page for PDF download proxy. Returns [] if no page. */
async function getCookiesForPdf() {
  if (!sharedPage || sharedPage.isClosed()) return [];
  try {
    return await sharedPage.cookies();
  } catch (err) {
    log('getCookiesForPdf failed:', err.message);
    return [];
  }
}

/** Wait for the Kendo grid to finish loading (no loading mask). */
async function waitForGridReady(page) {
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
    // ignore timeout
  }
}

/**
 * Warm the scrape page at server start: open IAA search and apply default left-side filters
 * (Run/Drive, Ottawa, Passenger Car, SUV, Light Truck). Subsequent scrapes use this page.
 * Safe to call multiple times; only runs once.
 * @returns {Promise<{ browser: import('puppeteer').Browser, page: import('puppeteer').Page }>}
 */
async function warmScrapePage() {
  if (warmPromise) return warmPromise;
  warmInProgress = true;
  warmPromise = (async () => {
    const headed = process.env.HEADED === '1' || process.env.HEADED === 'true';
    const timeoutMs = 60000;
    log('Warming scrape page: launching browser...');
    const browser = await puppeteer.launch({
      headless: headed ? false : 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    const hasLogin = !!(process.env.IAA_EMAIL || '').trim() && !!(process.env.IAA_PASSWORD || '').trim();
    if (hasLogin) {
      const ok = await loginIaa(page);
      if (!ok) log('Warm page: login failed, continuing unauthenticated (Damage Estimate may be hidden).');
    }
    log('Warming: navigating to', SEARCH_URL, '...');
    await page.goto(SEARCH_URL, { waitUntil: 'load', timeout: 60000 });
    log('Warming: waiting for results grid...');
    await page.waitForSelector('#runListKendoGrid tbody tr[role="row"]', { timeout: timeoutMs }).catch(() => {});
    log('Warming: applying default left filters (Run/Drive, Ottawa, Passenger Car, SUV, Light Truck)...');
    await applySiteFilters(page, DEFAULT_LEFT_FILTERS, null);
    lastAppliedLocations = (DEFAULT_LEFT_FILTERS.locations || []).slice();
    sharedBrowser = browser;
    sharedPage = page;
    warmInProgress = false;
    log('Scrape page ready with default filters applied.');
    return { browser, page };
  })().catch((err) => {
    warmPromise = null;
    warmInProgress = false;
    log('Warm failed:', err.message);
    throw err;
  });
  return warmPromise;
}

/** Parse odometer string (e.g. "123,456 Km" or "76,543 mi") to km. Returns NaN if unparseable. */
function parseOdometerKm(str) {
  if (!str || typeof str !== 'string') return NaN;
  const num = parseFloat(str.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(num)) return NaN;
  if (/mi\b/i.test(str)) return num * 1.60934;
  return num;
}

/** Parse engine displacement in liters from engine string (e.g. "2.5L I-4 DI, DOHC" -> 2.5). Returns NaN if unparseable. */
function parseEngineL(str) {
  if (!str || typeof str !== 'string') return NaN;
  const m = str.match(/(\d+(?:\.\d+)?)\s*L/i);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Get year (1st part) and make (2nd part) from car title for filtering.
 * Title format is expected to be "Year Make Model..." e.g. "2021 Honda Civic".
 * Year is only taken from title if the first part is 4 digits.
 * @param {{ title?: string, year?: string, make?: string }} car
 * @returns {{ year: string, make: string }}
 */
function getYearAndMakeFromTitle(car) {
  const title = (car.title || '').trim();
  const parts = title.split(/\s+/).filter(Boolean);
  const first = parts.length > 0 ? parts[0] : '';
  const year = /^\d{4}$/.test(first) ? first : (car.year || '').trim();
  const make = parts.length > 1 ? parts[1] : (car.make || '').trim();
  return { year, make };
}

/**
 * Apply site filters: branch (locations) and optionally Run/Drive, Passenger Car, SUV, Light Truck.
 * When previousLocations is provided (incremental mode on warm page), only applies location changes and skips other filters.
 * @param {import('puppeteer').Page} page
 * @param {{ locations?: string[] }} options - branch names to select.
 * @param {string[] | null} previousLocations - last applied locations; when set, only branch delta is applied (smart/incremental).
 */
async function applySiteFilters(page, options = {}, previousLocations = null) {
  const locations = Array.isArray(options.locations) ? options.locations.map((s) => String(s).trim()).filter(Boolean) : [];
  const incremental = Array.isArray(previousLocations);

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
    // 1) Branch: full set when !incremental; when incremental only uncheck/check what changed
    const prevSet = incremental ? new Set(previousLocations.map((s) => String(s).trim().toLowerCase())) : null;
    const wantSet = new Set(locations.map((s) => String(s).trim().toLowerCase()));
    const toUncheck = incremental ? previousLocations.filter((s) => !wantSet.has(String(s).trim().toLowerCase())) : [];
    const toCheck = incremental ? locations.filter((s) => !prevSet.has(String(s).trim().toLowerCase())) : locations;
    const branchHasChange = incremental ? (toUncheck.length > 0 || toCheck.length > 0) : locations.length > 0;

    if (branchHasChange || (!incremental && locations.length > 0)) {
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
      const branchClicked = incremental
        ? await page.evaluate((payload) => {
            const panel = document.querySelector('#auctionBranchFilter');
            if (!panel) return 0;
            const inputs = panel.querySelectorAll('input[type="checkbox"]');
            const uncheckLower = (payload.toUncheck || []).map((s) => String(s).trim().toLowerCase());
            const checkLower = (payload.toCheck || []).map((s) => String(s).trim().toLowerCase());
            let count = 0;
            for (const input of inputs) {
              const label = panel.querySelector('label[for="' + input.id + '"]');
              const text = (label && label.textContent) ? label.textContent.trim().toLowerCase() : '';
              if (!text) continue;
              const shouldUncheck = uncheckLower.some((loc) => text.indexOf(loc) !== -1);
              const shouldCheck = checkLower.some((loc) => text.indexOf(loc) !== -1);
              if (shouldUncheck && input.checked) {
                if (label) label.click();
                else input.click();
                count++;
              } else if (shouldCheck && !input.checked) {
                if (label) label.click();
                else input.click();
                count++;
              }
            }
            return count;
          }, { toUncheck, toCheck })
        : await page.evaluate((selectedLocations) => {
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
              if (!match && input.checked) {
                if (label) label.click();
                else input.click();
                count++;
              }
            }
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
        if (incremental) log('Applied location changes only:', toUncheck.length, 'unchecked,', toCheck.length, 'checked.');
        else log('Checked branch(es) on IAA:', branchClicked, '–', locations.join(', '));
        await waitForGridUpdate();
      }
    } else if (!incremental && locations.length === 0) {
      log('No locations selected in filter panel; skipping branch filter on IAA.');
    }

    // 1b) Year filter on page: fill Year From/To inputs and click Apply Year
    const yearFrom = options.yearFrom != null ? String(options.yearFrom).trim() : '';
    const yearTo = options.yearTo != null ? String(options.yearTo).trim() : '';
    if (yearFrom || yearTo) {
      const yearToggle = await page.$(FILTERS.yearPanelToggle);
      if (yearToggle) {
        const yearExpanded = await page.evaluate(() => {
          const panel = document.querySelector('#YearFilter');
          return panel && (panel.classList.contains('show') || panel.classList.contains('in'));
        });
        if (!yearExpanded) {
          await yearToggle.click();
          await delay(500);
        }
      }
      const yearApplied = await page.evaluate((payload) => {
        const fromEl = document.getElementById('YearFilterFrom');
        const toEl = document.getElementById('YearFilterTo');
        const applyBtn = document.getElementById('filterVehicleYear-ApplyYear');
        if (!applyBtn) return false;
        if (fromEl && payload.yearFrom) {
          fromEl.value = payload.yearFrom;
          fromEl.dispatchEvent(new Event('input', { bubbles: true }));
          fromEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (toEl && payload.yearTo) {
          toEl.value = payload.yearTo;
          toEl.dispatchEvent(new Event('input', { bubbles: true }));
          toEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        applyBtn.click();
        return true;
      }, { yearFrom: yearFrom || undefined, yearTo: yearTo || undefined });
      if (yearApplied) {
        log('Applied year filter on page:', yearFrom || '(any)', 'to', yearTo || '(any)');
        await waitForGridUpdate();
      }
    }

    if (incremental) {
      // Warm page: locations delta already applied; skip Run/Drive, Vehicle Type
      return;
    }

    // 2) Expand Vehicle Attribute panel (contains Run/Drive) if collapsed
    const vehicleAttrToggle = await page.$(FILTERS.vehicleAttributePanelToggle);
    if (vehicleAttrToggle) {
      const attrExpanded = await page.evaluate(() => {
        const panel = document.querySelector('#filterVehicleAttribute-filter');
        return panel && panel.classList.contains('show');
      });
      if (!attrExpanded) {
        await vehicleAttrToggle.click();
        await delay(500);
        log('Expanded Vehicle Attribute panel.');
      }
    }

    // 3) Select Run/Drive only when runAndDrive option is true (default: off – filter client-side)
    const runAndDrive = options.runAndDrive === true;
    if (runAndDrive) {
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
    } else {
      log('Run/Drive not selected (filter client-side instead).');
    }

    // 4) Vehicle Type: expand and select Passenger Car + SUV + Light Truck
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
      { name: 'Light Truck', checkboxSel: FILTERS.lightTruckCheckbox, labelSel: FILTERS.lightTruckLabel },
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

  let browser;
  let page;
  let usedShared = false;

  // Use warm page if available and still connected
  if (sharedPage && sharedBrowser) {
    try {
      if (!sharedPage.isClosed()) {
        browser = sharedBrowser;
        page = sharedPage;
        usedShared = true;
        log('Using warm scrape page. Applying only filter changes (locations delta)...');
        await applySiteFilters(page, options, lastAppliedLocations);
        lastAppliedLocations = (options.locations && options.locations.length > 0) ? options.locations.slice() : [];
      }
    } catch (e) {
      log('Warm page no longer valid:', e.message);
      sharedBrowser = null;
      sharedPage = null;
      warmPromise = null;
      lastAppliedLocations = null;
    }
  }

  if (!usedShared) {
    log('Launching browser (headed:', headed, ')...');
    browser = await puppeteer.launch({
      headless: headed ? false : 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    try {
      page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      const hasLogin = !!(process.env.IAA_EMAIL || '').trim() && !!(process.env.IAA_PASSWORD || '').trim();
      if (hasLogin) {
        const ok = await loginIaa(page);
        if (!ok) log('Continuing without login (may see masked VINs).');
      }

      log('Navigating to', SEARCH_URL, '...');
      try {
        await page.goto(SEARCH_URL, {
          waitUntil: 'load',
          timeout: 60000,
        });
        log('Navigation complete.');
      } catch (gotoErr) {
        log('Navigation failed:', gotoErr.message);
        if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(gotoErr.message || '')) {
          log('DNS could not resolve the host. Check internet connection and try: ping ca.iaai.com . Override URL with IAA_SEARCH_URL in .env if needed.');
        }
        throw gotoErr;
      }

      log('Waiting for results grid (up to', timeoutMs / 1000, 's)...');
      if (headed) {
        log('Headed mode: if you see an "I\'m human" / CAPTCHA box, solve it in the browser window.');
      }

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

      log('Applying site filters (locations, Run/Drive, etc.)...');
      await applySiteFilters(page, options);
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
  }
    const searchUrl = await page.url();
    log('URL after left filters applied:', searchUrl);
    log('Filters applied. Getting page HTML...');

    const html = await page.content();
    const allHtml = [html];

    // Detect pagination: Kendo pager has select with page options or .k-pager-numbers a[data-page]
    const totalPages = await page.evaluate(() => {
      const pager = document.querySelector('.k-pager-wrap[data-role="pager"], [data-role="pager"]');
      if (!pager) return 1;
      const select = pager.querySelector('select[aria-label="Page select"], select.k-dropdown');
      if (select) {
        const options = select.querySelectorAll('option');
        let maxPage = 1;
        options.forEach((opt) => {
          const v = parseInt(opt.value, 10);
          if (!isNaN(v) && v > maxPage) maxPage = v;
        });
        return maxPage;
      }
      const links = pager.querySelectorAll('.k-pager-numbers a.k-link[data-page], .k-pager-numbers .k-link[data-page], .k-pager-numbers [data-page]');
      let max = 1;
      links.forEach((el) => {
        const v = parseInt(el.getAttribute('data-page'), 10);
        if (!isNaN(v) && v > max) max = v;
      });
      return max;
    }).catch(() => 1);

    if (totalPages > 1) {
      log('Pagination detected:', totalPages, 'pages. Fetching remaining pages...');
      const separator = searchUrl.includes('?') ? '&' : '?';
      for (let p = 2; p <= totalPages; p++) {
        const pageUrl = searchUrl + separator + 'page=' + p;
        log('Navigating to page', p, 'of', totalPages, '...');
        await delay(PAGINATION_PAGE_DELAY_MS);
        try {
          await page.goto(pageUrl, { waitUntil: 'load', timeout: 20000 });
          await waitForGridReady(page);
          const pageHtml = await page.content();
          allHtml.push(pageHtml);
          log('Page', p, 'HTML collected.');
        } catch (err) {
          log('Failed to load page', p, ':', err.message);
        }
      }
      log('Collected HTML from', allHtml.length, 'pages.');
    }

    if (options.keepBrowserOpen) {
      log('Keeping browser open for detail-page fetches.');
      return { html, allHtml, browser, page, usedShared };
    }
    if (!usedShared) await browser.close();
    return html;
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
    let auctionDateTime = '', highPrebid = '';

    if (row2 && row2.length) {
      const td1 = row2.find('td.runlist-td-1');
      const td2 = row2.find('td.runlist-td-2');
      const td3 = row2.find('td.runlist-td-3');
      const buttonTd = row2.find('td').last();
      const auctionEl = buttonTd.find('.auctionDateTimeDisplay');
      if (auctionEl.length) auctionDateTime = auctionEl.first().text().trim();
      const highPreBidDiv = buttonTd.find('span[aria-label="High Pre-Bid"]').closest('div');
      if (highPreBidDiv.length) {
        const text = highPreBidDiv.text().trim();
        const m = text.match(/\$[\d,]+(?:\.\d{2})?/);
        if (m) highPrebid = m[0];
      }

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
        else if (!label && spanVal && ['RunAndDrive', 'Start', 'Starts', 'Stationary'].some(s => spanVal.includes(s))) condition = spanVal;
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
      auctionDateTime, vehicleDetailsUrl, highPrebid,
    });
    i += 2;
  }

  return cars;
}

/**
 * Model slug for Kenny U-Pull: first token by space only, so "CR-V" stays "cr-v", "Civic Si" -> "civic".
 * @param {string} model
 * @returns {string}
 */
function modelSlugForKenny(model) {
  if (!model || typeof model !== 'string') return '';
  const first = model.trim().split(/\s+/)[0] || '';
  return first.toLowerCase().replace(/\s+/g, '-');
}

/**
 * Build Kenny U-Pull inventory search URL (Ottawa + Gatineau).
 * @param {string} make
 * @param {string} model - full model string; only the part before space/hyphen is used
 * @param {string|number|null} modelYear - e.g. '2024' for exact year, or null/'all-years' for all years
 * @returns {string}
 */
function buildKennyUpullUrl(make, model, modelYear = null) {
  if (!make || typeof make !== 'string') return '';
  const brand = make.trim().toLowerCase().replace(/\s+/g, '-');
  const modelSlug = modelSlugForKenny(model);
  const params = new URLSearchParams();
  params.set('brand', brand);
  if (modelSlug) params.set('model', modelSlug);
  params.set('model_year', modelYear != null && String(modelYear).trim() !== '' ? String(modelYear).trim() : 'all-years');
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
 * For each car, check Kenny U-Pull: exact year first, then all years. Set kennyUpullLink and kennyUpullMatch ('exact' | 'all-years' | 'none').
 * Model is normalized to the part before first space or hyphen for the URL.
 * @param {Array<{make:string, model?:string, year?:string}>} cars
 */
async function enrichCarsWithKennyUpullLinks(cars) {
  const urlToResult = new Map(); // url -> { hasResults }
  for (let idx = 0; idx < cars.length; idx++) {
    const car = cars[idx];
    const make = (car.make || '').trim();
    const model = (car.model || '').trim();
    const year = (car.year || '').trim();
    const modelSlug = modelSlugForKenny(model);
    if (!make) {
      car.kennyUpullMatch = 'none';
      continue;
    }
    const urlExact = year && /^\d{4}$/.test(year) ? buildKennyUpullUrl(make, modelSlug, year) : null;
    const urlAll = buildKennyUpullUrl(make, modelSlug, null);

    if (urlExact) {
      if (!urlToResult.has(urlExact)) {
        await delay(KENNY_CHECK_DELAY_MS);
        log('Kenny U-Pull verify (exact year):', make, modelSlug, year, '|', urlExact);
        const result = await getKennyUpullResultsCount(urlExact);
        urlToResult.set(urlExact, result.hasResults);
      }
      if (urlToResult.get(urlExact)) {
        car.kennyUpullLink = urlExact;
        car.kennyUpullMatch = 'exact';
        log('Kenny U-Pull: exact year', year, '|', car.stockNum || car.title, '|', urlExact);
        continue;
      }
    }

    if (!urlToResult.has(urlAll)) {
      await delay(KENNY_CHECK_DELAY_MS);
      log('Kenny U-Pull verify (all years):', make, modelSlug, '|', urlAll);
      const result = await getKennyUpullResultsCount(urlAll);
      urlToResult.set(urlAll, result.hasResults);
    }
    if (urlToResult.get(urlAll)) {
      car.kennyUpullLink = urlAll;
      car.kennyUpullMatch = 'all-years';
      log('Kenny U-Pull: all years |', car.stockNum || car.title, '|', urlAll);
    } else {
      car.kennyUpullMatch = 'none';
      car.kennyUpullLink = urlExact || urlAll;
    }
  }
  const exactCount = cars.filter((c) => c.kennyUpullMatch === 'exact').length;
  const allYearsCount = cars.filter((c) => c.kennyUpullMatch === 'all-years').length;
  const noneCount = cars.filter((c) => c.kennyUpullMatch === 'none').length;
  log('Kenny U-Pull: exact:', exactCount, '| all-years:', allYearsCount, '| none:', noneCount, 'of', cars.length);
}

/**
 * Parse IAA vehicle details page HTML for Air Bags, Keys Present, Restraint System, Primary/Secd/Other Damages, High Pre-Bid.
 * @param {string} html
 * @returns {{ airBagsDetail: string, restraintSystem: string, keysPresent: string, primaryDamage: string, secdDamage: string, otherDamages: string, declarations: string, highPrebid: string, damageEstimatePdfUrl: string }}
 */
function parseDetailPageAirBagsAndRestraint(html) {
  const $ = cheerio.load(html);
  let airBagsDetail = '';
  let restraintSystem = '';
  let keysPresent = '';
  let primaryDamage = '';
  let secdDamage = '';
  let otherDamages = '';
  let declarations = '';
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
    if (/Declarations/i.test(label)) declarations = value;
  });
  $('#vehicleInformationlistView .data-list__item').each((_, el) => {
    const $el = $(el);
    const label = $el.find('.data-list__label').text().trim();
    const value = $el.find('.data-list__value').text().trim();
    if (/Restraint\s*System/i.test(label)) restraintSystem = value;
  });
  let damageEstimatePdfUrl = '';
  let damageEstimateAmount = '';
  const priceLikeRe = /\$[\d,]+(?:\.\d{2})?/;
  const tryDamageEstimate = (scope) => {
    $(scope).find('.data-list__item').each((_, el) => {
      const $el = $(el);
      const label = $el.find('.data-list__label').text().trim();
      if (!/Damage\s*Estimate/i.test(label)) return;
      if (!damageEstimatePdfUrl) {
        const href = $el.find('a[href*="GetPdf"]').attr('href');
        if (href) damageEstimatePdfUrl = href.startsWith('http') ? href : IAA_BASE + (href.startsWith('/') ? '' : '/') + href;
      }
      if (!damageEstimateAmount) {
        const amountSpan = $el.find('.displayValueWithPDF, .data-list__value');
        const text = amountSpan.text().trim();
        const m = text.match(priceLikeRe);
        if (m) damageEstimateAmount = m[0];
      }
    });
  };
  tryDamageEstimate('#reportAndDownloadsListView');
  tryDamageEstimate('#vdp-reports');
  if (!damageEstimatePdfUrl || !damageEstimateAmount) tryDamageEstimate('body'); // fallback: reports may be in other container
  // High Pre-Bid: in BID INFORMATION (main area or Pre-Bid popup). Match "High Pre-Bid" or "Current High Bid"; value often in .data-list__value or label.runlistPrebidRed/Green
  const highPreBidLabelRe = /High\s*Pre-?Bid|Current\s*High\s*Bid/i;
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
  return { airBagsDetail, restraintSystem, keysPresent, primaryDamage, secdDamage, otherDamages, declarations, highPrebid, damageEstimatePdfUrl, damageEstimateAmount };
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
          // Wait for Vehicle Reports & Estimates (Damage Estimate PDF) - may load async
          try {
            await page.waitForSelector('a[href*="GetPdf"]', { timeout: 5000 });
          } catch {
            // no Damage Estimate link; capture HTML anyway
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
      const { airBagsDetail, restraintSystem, keysPresent, primaryDamage, secdDamage, otherDamages, declarations, highPrebid, damageEstimatePdfUrl, damageEstimateAmount } = parseDetailPageAirBagsAndRestraint(data);
      car.airBagsDetail = airBagsDetail;
      car.declarations = declarations;
      car.damageEstimatePdfUrl = damageEstimatePdfUrl;
      if (damageEstimateAmount) car.damageEstimate = damageEstimateAmount;
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
  let allHtml;
  let browser = null;
  let page = null;
  let usedShared = false;
  try {
    const result = await getHtmlWithBrowser({
      locations,
      keepBrowserOpen: true,
      yearFrom: options.yearFrom,
      yearTo: options.yearTo,
    });
    if (typeof result === 'string') {
      html = result;
      allHtml = null;
    } else {
      html = result.html;
      allHtml = result.allHtml || null;
      browser = result.browser;
      page = result.page;
      usedShared = result.usedShared === true;
    }
  } catch (err) {
    log('Browser fetch failed:', err.message);
    throw err;
  }

  try {
    let cars;
    if (allHtml && allHtml.length > 0) {
      cars = [];
      const seen = new Set();
      for (let i = 0; i < allHtml.length; i++) {
        const pageCars = parseCarsFromHtml(allHtml[i]);
        log('Page', i + 1, ':', pageCars.length, 'vehicles.');
        for (const c of pageCars) {
          const key = (c.stockNum || c.vehicleDetailsUrl || c.vin || c.title || '').trim() || ('row-' + cars.length);
          if (seen.has(key)) continue;
          seen.add(key);
          cars.push(c);
        }
      }
      log('Scrape finished. Vehicles extracted (all pages, deduped):', cars.length);
    } else {
      const htmlLen = typeof html === 'string' ? html.length : 0;
      log('HTML length:', htmlLen);
      cars = parseCarsFromHtml(html);
      log('Scrape finished. Vehicles extracted:', cars.length);
    }
    if (cars.length > 0) {
      const sampleVin = (cars[0].vin || '').trim();
      const loginHint = !sampleVin ? '' : /\*/.test(sampleVin) ? '(masked → not logged in)' : '(full → login OK)';
      log('Sample VIN:', sampleVin || '(none)', loginHint);
    }

    const beforeBranchBrand = cars.length;
    cars = cars.filter((c) => carMatchesLocations(c, locations));
    log('After branch (selected locations):', cars.length, 'of', beforeBranchBrand, 'vehicles.');

    if (Array.isArray(options.makes) && options.makes.length > 0) {
      const allowedMakes = options.makes.map((m) => String(m).trim().toLowerCase()).filter(Boolean);
      const beforeMakes = cars.length;
      cars = cars.filter((c) => {
        const { make } = getYearAndMakeFromTitle(c);
        const makeLower = make.toLowerCase();
        const titleLower = (c.title || '').toLowerCase();
        return allowedMakes.some((m) => makeLower === m || titleLower.includes(m));
      });
      log('After make filter (from title 2nd part: ' + options.makes.join(', ') + '):', cars.length, 'of', beforeMakes, 'vehicles.');
    }

    const beforeTrans = cars.length;
    cars = cars.filter((c) => /auto/i.test((c.transmission || '').trim()));
    log('After transmission=Auto only:', cars.length, 'of', beforeTrans, 'vehicles.');

    const beforeMech = cars.length;
    cars = cars.filter((c) => !hasMechanicalIssues(c));
    if (beforeMech !== cars.length) log('After excluding mechanical/mech damage (e.g. Possible Mech):', cars.length, 'of', beforeMech, 'vehicles.');

    // Apply filter-panel criteria (date/year, km, engine range, auction date) BEFORE visiting any detail page
    const yearFrom = options.yearFrom != null ? String(options.yearFrom).trim() : '';
    const yearTo = options.yearTo != null ? String(options.yearTo).trim() : '';
    const maxKm = options.maxKm != null && Number.isFinite(Number(options.maxKm)) ? Number(options.maxKm) : null;
    const engineMin = options.engineMin != null && Number.isFinite(Number(options.engineMin)) ? Number(options.engineMin) : null;
    const engineMax = options.engineMax != null && Number.isFinite(Number(options.engineMax)) ? Number(options.engineMax) : null;
    const auctionFrom = options.auctionFrom != null ? String(options.auctionFrom).trim() : '';
    const auctionFromTs = auctionFrom ? (() => {
      const s = auctionFrom;
      const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00').getTime() : new Date(s).getTime();
      return Number.isFinite(t) ? t : null;
    })() : null;

    if (yearFrom || yearTo || maxKm != null || engineMin != null || engineMax != null || auctionFromTs != null) {
      const beforePanel = cars.length;
      if (yearFrom) {
        cars = cars.filter((c) => {
          const { year } = getYearAndMakeFromTitle(c);
          return year && year >= yearFrom;
        });
        log('After year from (from title 1st part)', yearFrom + ':', cars.length, 'vehicles.');
      }
      if (yearTo) {
        cars = cars.filter((c) => {
          const { year } = getYearAndMakeFromTitle(c);
          return year && year <= yearTo;
        });
        log('After year to (from title 1st part)', yearTo + ':', cars.length, 'vehicles.');
      }
      if (maxKm != null) {
        cars = cars.filter((c) => {
          const km = parseOdometerKm(c.odometer);
          return !Number.isNaN(km) && km <= maxKm;
        });
        log('After max km', maxKm + ':', cars.length, 'vehicles.');
      }
      if (engineMin != null || engineMax != null) {
        cars = cars.filter((c) => {
          const engineL = parseEngineL(c.engine);
          if (Number.isNaN(engineL)) return false;
          if (engineMin != null && engineL < engineMin) return false;
          if (engineMax != null && engineL > engineMax) return false;
          return true;
        });
        log('After engine range', (engineMin != null ? engineMin + 'L' : '') + (engineMin != null && engineMax != null ? '–' : '') + (engineMax != null ? engineMax + 'L' : '') + ':', cars.length, 'vehicles.');
      }
      if (auctionFromTs != null) {
        const filterD = new Date(auctionFromTs);
        const filterMonth = filterD.getMonth();
        const filterDay = filterD.getDate();
        log('Auction date filter: exact date only (year ignored):', filterMonth + 1, '/', filterDay);
        cars = cars.filter((c) => {
          const raw = c.auctionDateTime || '';
          const ts = parseAuctionDate(raw);
          const pass = isMonthDayEqual(ts, filterMonth, filterDay);
          const carDateStr = Number.isFinite(ts) ? (new Date(ts).getMonth() + 1) + '/' + new Date(ts).getDate() : '(invalid)';
          log('  car', c.stockNum || c.title || '?', '| raw auctionDateTime=', JSON.stringify(raw), '| month/day=', carDateStr, '| pass=', pass);
          return pass;
        });
        log('After auction date (exact match):', auctionFrom + ':', cars.length, 'vehicles.');
      }
      log('Filter panel (date, km, engine, make, location, auction date) applied. Detail pages will be fetched for', cars.length, 'of', beforePanel, 'vehicles.');
    }

    // Verification (car detail, Kenny U-Pull, Gemini price) runs ONLY after all panel filters
    // so we never fetch detail pages or run Kenny U-Pull / Gemini for cars excluded by date, km, year, etc.
    const vehiclesForVerification = cars.length;
    log('All panel filters applied. Running verification (car detail, Kenny U-Pull; Gemini on server) only on', vehiclesForVerification, 'vehicles.');

    if (cars.length > 0) {
      log('First vehicle:', cars[0].year, cars[0].make, cars[0].model, '| Branch:', cars[0].branch, '| Trans:', cars[0].transmission);
    }

    const enableCarDetail = options.carDetail !== false;
    const enableKennyUpull = options.kennyUpull !== false;
    const enableDamageEstimateVerify = options.damageEstimateVerify !== false;
    const damageEstimateMode = (options.damageEstimateMode || 'ai').toLowerCase();
    const needsDetailPages = enableCarDetail || (enableDamageEstimateVerify && cars.length > 0);

    if (needsDetailPages && cars.length > 0) {
      // Re-login if session was lost (e.g. warm page never logged in, or session expired)
      const currentUrl = page.url?.() || '';
      const onLoginPage = /login\.iaai\.com|\/account\/login/i.test(currentUrl);
      const hasLogin = !!(process.env.IAA_EMAIL || '').trim() && !!(process.env.IAA_PASSWORD || '').trim();
      if (onLoginPage && hasLogin) {
        log('Session lost (on login page). Re-logging in before detail fetches...');
        const ok = await loginIaa(page);
        if (ok) log('Re-login succeeded.');
      }
      const fetchReason = enableCarDetail ? 'Air Bags, Keys, Restraint' : 'Damage Est. PDF URL';
      log('Fetching vehicle detail pages (' + fetchReason + ')...');
      await enrichCarsWithDetailPageData(cars, page);
    } else if (!needsDetailPages && cars.length > 0) {
      log('Car detail and Damage Est. disabled – skipping detail page fetch.');
    }

    if (enableCarDetail) {
      // Log why each car is excluded before applying the final filter
      const beforeDetailFilter = cars.length;
      let excludedCount = 0;
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        const stock = c.stockNum || c.title || ('car#' + (i + 1));
        const airBagsOk = hasAirBagsIntact(c);
        const keysOk = keysPresentYes(c);
        const noForbiddenDamage = !hasForbiddenDamageCode(c);
        const noMechInDeclarations = !hasMechInDeclarations(c);
        if (airBagsOk && keysOk && noForbiddenDamage && noMechInDeclarations) continue;
        excludedCount++;
        const reasons = [];
        if (!airBagsOk) reasons.push("Air Bags='" + (c.airBagsDetail || '(empty)') + "' (need INTACT)");
        if (!keysOk) reasons.push("Keys Present='" + (c.keysPresent || '(empty)') + "' (need Yes)");
        if (!noForbiddenDamage) reasons.push("forbidden damage: Primary='" + (c.primaryDamage || '') + "' Secd='" + (c.secdDamage || '') + "' Other='" + (c.otherDamages || '') + "'");
        if (!noMechInDeclarations) reasons.push("Declarations has mech: '" + (c.declarations || '').slice(0, 80) + "'");
        log('Excluded [' + (i + 1) + '/' + beforeDetailFilter + ']', stock, '–', reasons.join('; '));
      }
      if (excludedCount > 0) {
        log('Excluded', excludedCount, 'of', beforeDetailFilter, 'vehicles (see reasons above).');
      }

      cars = cars.filter(
        (c) => hasAirBagsIntact(c) && keysPresentYes(c) && !hasForbiddenDamageCode(c) && !hasMechInDeclarations(c)
      );
      log('Keeping only cars with Air Bags=INTACT, Keys=Yes, no forbidden damage, no mech in Declarations:', cars.length, 'of', beforeDetailFilter, 'vehicles.');
    }

    if (enableKennyUpull && cars.length > 0) {
      log('Checking Kenny U-Pull inventory (Ottawa + Gatineau) for verified make/model...');
      await enrichCarsWithKennyUpullLinks(cars);
    } else if (!enableKennyUpull && cars.length > 0) {
      log('Kenny U-Pull verification disabled – skipping inventory check.');
    }

    const hasAIKeys = !!(getGeminiKey() || getOpenAIKey());
    const needsAIForDamage = damageEstimateMode !== 'keyword';
    const runDamageEstimateVerify = enableDamageEstimateVerify && page && (needsAIForDamage ? hasAIKeys : true);
    if (runDamageEstimateVerify && cars.length > 0) {
      log('Verifying Damage Estimate PDFs (' + damageEstimateMode + ' mode)...');
      cars = await enrichCarsWithDamageEstimateVerification(cars, {
        page,
        filterBoltOnOnly: false,
        delayMs: 2000,
        mode: damageEstimateMode,
      });
      log('Damage estimate verification done:', cars.length, 'vehicles.');
    } else if (enableDamageEstimateVerify && cars.length > 0 && needsAIForDamage && !hasAIKeys) {
      log('Damage Estimate verification skipped – AI mode requires OpenAI or Gemini API key.');
    }

    return cars;
  } finally {
    if (browser && !usedShared) {
      log('Closing browser.');
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  scrapeCars,
  getWarmStatus,
  getCookiesForPdf,
};
