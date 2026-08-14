const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const APP_URL = 'https://app.incounsel.app/';   // where Bubble's actual assets live
const ROOT_URL = 'https://incounsel.app/';       // the real, public, crawlable domain

// Fetched directly from the app subdomain, not the root domain. This is
// deliberate: the root domain currently has no application associated
// with it in Bubble (it was reassigned to app.incounsel.app in the
// domain-switch step), and won't correctly serve /sitemap.xml until the
// Cloudflare Worker is live and intercepting .xml requests. Fetching
// from APP_URL means this script never depends on the Worker/Routes
// being deployed yet — it works standalone, at any stage of setup.
const SITEMAP_INDEX = `${APP_URL}sitemap.xml`;
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
  `${ROOT_URL}`,       // homepage — never depend on the sitemap alone for
                       // this; Bubble's sitemap can be mid-rebuild (e.g.
                       // right after a domain change) and return 503s for
                       // a while, which should never mean the homepage
                       // silently goes missing from the static snapshot.
  `${ROOT_URL}blog-posts`,
  `${ROOT_URL}features`,
  `${ROOT_URL}pricing`,
  `${ROOT_URL}about`,
  // add any other hand-built hub/listing pages here
];

// CRITICAL — InCounsel-specific, did not exist in the clinic version:
// the app has dozens of authenticated / logged-in pages (case
// management, client portals, admin tools, onboarding wizards, etc.)
// mixed in alongside a small number of genuinely public marketing
// pages. Page naming isn't consistent enough (mixed hyphens/underscores,
// no shared prefix) to reliably EXCLUDE the private ones by pattern —
// one missed pattern and something gets scraped into public static
// HTML. So this uses an ALLOWLIST instead: only paths listed here are
// ever scraped. Anything else — including any new page added later
// without updating this list — is skipped by default. Fails safe.
//
// Paths are matched against the URL's pathname (case-insensitive,
// trailing slash ignored). Update this list as your public site grows.
const ALLOWED_PATHS = [
  '/',                 // homepage
  '/features',         // not yet live per sitemap — harmless placeholder, safe no-op until it exists
  '/pricing',
  '/about',            // not yet live per sitemap — harmless placeholder, safe no-op until it exists
  '/contact',          // not yet live per sitemap — harmless placeholder, safe no-op until it exists
  '/blog',
  '/blog-posts',
  '/terms_of_service_privacy_policy',
  '/demo',
  '/demo-onb',
  '/demo-seo',
  '/demo-blog',
  '/demo-calls',
  '/demo-docs',
  // add any other genuinely public marketing/resource/demo page here
];

function normalizePath(pathname) {
  const trimmed = pathname.toLowerCase().replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function isAllowed(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  const normalized = normalizePath(pathname);
  // Allow the listed paths, plus anything nested under /blog or
  // /blog-posts (individual post URLs won't be in ALLOWED_PATHS by name).
  if (ALLOWED_PATHS.map(normalizePath).includes(normalized)) return true;
  if (normalized.startsWith('/blog/') || normalized.startsWith('/blog-posts/')) return true;
  return false;
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

  const skipped = deduped.filter((u) => !isAllowed(u));
  if (skipped.length) {
    console.log(`Skipping ${skipped.length} URL(s) not on the public allowlist:`);
    skipped.forEach((u) => console.log(`  - ${u}`));
  }

  return deduped.filter(isAllowed);
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

  // Wipe any previous output before writing fresh content. Without this,
  // pages that get removed from ALLOWED_PATHS (or renamed) leave stale
  // HTML sitting in output/ forever — it never gets cleaned up on its
  // own, since the loop below only ever writes files, never deletes them.
  // This bit us directly: importing this repo from another project
  // carried over its old output/ folder, and stale content kept being
  // served until this was added.
  if (fs.existsSync('output')) {
    fs.rmSync('output', { recursive: true, force: true });
    console.log('Cleared previous output/ directory.');
  }

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
