# IAA Car Scraper

Scrapes the IAA search page (ca.iaai.com/search) by loading it in a **real browser** (Puppeteer with stealth) and parsing the HTML with **Cheerio**. This gets past Incapsula / "I'm not human" checks. No IAA API—still HTML + library only.

Before scraping, the script uses the **left-side filters on the page**: **Ottawa** (Branch), **Run/Drive** (Featured Vehicles), **Passenger Car** and **SUV** (Vehicle Type), **ON-NOT BRANDED** (Province / Vehicle Brand). It waits for the results to reload after each change so the list is already filtered on the server.

## Setup

```bash
npm install
```

## Run

```bash
npm start
```

Open http://localhost:3000 to see the scraped car list.

### If you still see "I'm not human" / CAPTCHA

Run with a **visible browser** so you can solve the checkbox once:

```bash
HEADED=1 npm start
```

Then load http://localhost:3000 (or hit the scrape). A Chrome window will open; complete the "I'm human" check there. The scraper waits up to 60 seconds for the results grid to appear.

- **GET /** – Scrapes the page and renders the list (HTML).
- **GET /api/cars** – Same scrape, returns JSON.

## Environment

Optional (add to `.env`):

- `OPENAI_API_KEY` – Primary for price estimates
- `GEMINI_API_KEY` – Fallback when OpenAI is rate limited
- `IAA_EMAIL` / `IAA_PASSWORD` – Log in to IAA to see full VINs (otherwise masked)

## Stack

- **Express** – Web server
- **Puppeteer** (+ stealth plugin) – Load the page in a real browser so Incapsula allows it
- **cheerio** – Parse HTML and extract vehicle rows from the grid
