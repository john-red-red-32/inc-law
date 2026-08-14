const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SITEMAP_INDEX = 'https://incounsel.app/sitemap.xml';
const APP_URL = 'https://app.incounsel.app/';   // where Bubble's actual assets live
const ROOT_URL = 'https://incounsel.app/';       // the real, public, crawlable domain
const TEST_MODE = false;

// Pages that exist and are meant to be browsed without a specific data
// entry (e.g. the full blog listing) never appear in Bubble's sitemap,
// since they're not tied to a database "Thing". Add them here by hand
// so they still get scraped alongside everything else.
//
// NOTE: /blog-posts currently has no content yet (builder unfinished) —
// leaving it in this list is harmless, it'll just snapshot whatever's
// there today (likely a near-empty page) and get overwritten with real
// content on the next scheduled run once the display page is fixed.
const EXTRA_URLS = [
  `${ROOT_URL}blog-posts`,
  `${ROOT_URL}features`,
  `${ROOT_URL}pricing`,
  `${ROOT_URL}about`,
  // add any other hand-built hub/listing pages here
];

// CRITICAL — InCounsel-specific, did not exist in the clinic version:
// authenticated / logged-in surfaces (client portals, case dashboards,
// matter workspaces) must NEVER be captured as public static HTML.
// Bubble's sitemap.xml should not normally list these (it's generated
// from public "Thing" pages), but this filter is a hard backstop in
// case a dashboard/portal page ever gets indexed or added to EXTRA_URLS
// by mistake. Adjust these patterns to match your actual private-page
// URL structure before the first real run.
const EXCLUDE_PATTERNS = [
  /\/dashboard/i,
  /\/portal/i,
  /\/case[/-]/i,
  /\/matter[/-]/i,
  /\/account/i,
  /\/settings/i,
  /\/login/i,
  /\/app[/-]/i,   // adjust/remove if this collides with a real public page
];

function isExcluded(url) {
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(url));
}

async function getUrlsFromSitemap(url) {
  const res = await fetch(url);
  const xml = await res.text();
  console.log(`  Status ${res.status} for ${url} — response starts with: ${xml.slice(0, 150).replace(/\n/g, ' ')}`);
  const matches = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
  return matches;
}

async function getAllPageUrls() {
  if (TEST_MODE) {
    return [APP_URL];
  }
  const topLevel = await getUrlsFromSitemap(SITEMAP_INDEX);
  let allUrls = [];
  for (const entry of topLevel) {
    if (entry.endsWith('.xml')) {
      console.log('Reading child sitemap:', entry);
      const childUrls = await getUrlsFromSitemap(entry);
      allUrls = allUrls.concat(childUrls);
    } else {
      allUrls.push(entry);
    }
  }
  allUrls = allUrls.concat(EXTRA_URLS);

  const deduped = [...new Set(allUrls)];

  const excluded = deduped.filter(isExcluded);
  if (excluded.length) {
    console.log(`Excluding ${excluded.length} authenticated/private URL(s) from scrape:`);
    excluded.forEach((u) => console.log(`  - ${u}`));
  }

  return deduped.filter((u) => !isExcluded(u));
}

function cleanHtml(html) {
  // 1. Bots never run JS — every script is dead weight, strip it all.
  let cleaned = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

  // 2. Rewrite every absolute reference to the app subdomain back to the
  //    real, public root domain — fixes canonical tags, og:url,
  //    twitter:*, JSON-LD schema URL, and internal nav/page links.
  cleaned = cleaned.split(APP_URL).join(ROOT_URL);

  // 3. Icons use a relative /static/ path that only resolves correctly
  //    against Bubble's actual app domain.
  cleaned = cleaned.replace(/href="\/static\//g, `href="${APP_URL}static/`);

  // 4. Remaining relative links resolve against the crawlable root domain.
  cleaned = cleaned.replace('<head>', `<head><base href="${ROOT_URL}">`);
  return cleaned;
}

async function run() {
  const urls = await getAllPageUrls();
  console.log(`Found ${urls.length} pages to scrape.`);

  const browser = await chromium.launch();
  const page = await browser.newPage();

  let count = 0;
  for (const url of urls) {
    count++;
    console.log(`[${count}/${urls.length}] Fetching:`, url);
    try {
      // These pages are visited using their real, App-hosted equivalent
      // so Bubble's dynamic logic actually loads them, then saved under
      // the public root-domain path.
      const fetchUrl = url.startsWith(ROOT_URL) ? url.replace(ROOT_URL, APP_URL) : url;
      await page.goto(fetchUrl, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(5000);

      const rawHtml = await page.content();
      const html = cleanHtml(rawHtml);

      const publicUrl = url.startsWith(APP_URL) ? url.replace(APP_URL, ROOT_URL) : url;

      // Decode percent-encoded characters (em-dash, ®, +, etc.) so the
      // saved filename uses the real characters — matching exactly what
      // Cloudflare Pages will look for when a browser requests the page.
      // Without this, special characters get saved as literal "%XX"
      // sequences, the file never gets found, and Cloudflare silently
      // falls back to serving the homepage instead.
      const urlPath = decodeURIComponent(new URL(publicUrl).pathname);
      const outPath = urlPath === '/' ? 'output/index.html' : `output${urlPath}/index.html`;

      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, html);
    } catch (err) {
      console.log(`  Failed: ${url} — ${err.message}`);
    }
  }

  await browser.close();
  console.log('Done.');
}

run();
