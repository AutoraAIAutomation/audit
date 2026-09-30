#!/usr/bin/env node
// A4 fit check for an audit page, run by the "Audit page writer" routine before it pushes.
// Renders the page the way .github/workflows/pdf.yml does (puppeteer, print media, A4, no margins), measures every
// <section class="page"> and lists any that is taller than one A4 sheet, which would spill onto an extra PDF page.
// Heights depend on the web fonts. Where fonts.googleapis.com is blocked (the routine's cloud sandbox), the same Google
// Fonts families are installed from npm (Fontsource) and served in its place, so the measurement still uses the real fonts.
// Exit 0: every page fits. Exit 2: at least one page runs over. Exit 1: the check itself failed.
// Usage (from the repo root): NODE_PATH=/tmp/fit/node_modules node .github/scripts/fit-check.cjs <folder>/index.html [out.pdf]
// Needs puppeteer (npm i puppeteer@23 in /tmp/fit), or puppeteer-core plus CHROME_PATH. FIT_DIR (default /tmp/fit) is
// where font packages get installed; FIT_FONTS=fontsource forces the npm fonts (for testing).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
let puppeteer;
try { puppeteer = require('puppeteer'); } catch (e) { puppeteer = require('puppeteer-core'); }
const A4_MM = 297, SLACK_MM = 0.5;
const FIT_DIR = process.env.FIT_DIR || '/tmp/fit';

// Google Fonts families named in the page's <link href="https://fonts.googleapis.com/css...">.
function googleFamilies(html) {
  const out = new Set();
  for (const m of html.matchAll(/https:\/\/fonts\.googleapis\.com\/css2?\?[^"'\s>]+/g)) {
    const url = m[0].replace(/&amp;/g, '&');
    for (const part of url.split(/[?&]/)) {
      if (part.startsWith('family=')) for (const fam of decodeURIComponent(part.slice(7)).split('|')) out.add(fam.split(':')[0].replace(/\+/g, ' ').trim());
    }
  }
  return [...out].filter(Boolean);
}

async function googleReachable(html) {
  const m = html.match(/https:\/\/fonts\.googleapis\.com\/css2?\?[^"'\s>]+/);
  if (!m) return true;
  try {
    const r = await fetch(m[0].replace(/&amp;/g, '&'), { signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch (e) { return false; }
}

// @font-face rules with the font files inlined, from @fontsource-variable/<slug> or else @fontsource/<slug> (latin subset).
function fontsourceCss(families) {
  let css = '';
  const missing = [];
  for (const family of families) {
    const slug = family.toLowerCase().replace(/\s+/g, '-');
    let rules = '';
    for (const pkg of [`@fontsource-variable/${slug}`, `@fontsource/${slug}`]) {
      const dir = path.join(FIT_DIR, 'node_modules', pkg, 'files');
      if (!fs.existsSync(dir)) {
        try { execSync(`npm i --no-audit --no-fund --silent ${pkg}`, { cwd: FIT_DIR, stdio: 'ignore', timeout: 120000 }); } catch (e) { continue; }
      }
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.woff2') && f.startsWith(`${slug}-latin-`) && !f.includes('latin-ext'));
      const face = (file, style, weight) => {
        const data = fs.readFileSync(path.join(dir, file)).toString('base64');
        return `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${data}) format('woff2');}\n`;
      };
      if (pkg.startsWith('@fontsource-variable/')) {
        for (const style of ['normal', 'italic']) { // 'full' carries every axis (opsz, SOFT...), 'wght' only weight
          const f = files.find(x => x === `${slug}-latin-full-${style}.woff2`) || files.find(x => x === `${slug}-latin-wght-${style}.woff2`);
          if (f) rules += face(f, style, '100 1000');
        }
      } else {
        for (const f of files) {
          const m = f.match(/-latin-(\d+)-(normal|italic)\.woff2$/);
          if (m) rules += face(f, m[2], m[1]);
        }
      }
      if (rules) break;
    }
    if (rules) css += rules; else missing.push(family);
  }
  return { css, missing };
}

(async () => {
  const [file, pdfOut] = process.argv.slice(2);
  if (!file) { console.error('usage: fit-check.cjs <page.html> [out.pdf]'); process.exit(1); }
  const html = fs.readFileSync(file, 'utf8');
  const families = googleFamilies(html);
  let fonts = 'google', missing = [], localCss = '';
  if (families.length && (process.env.FIT_FONTS === 'fontsource' || !(await googleReachable(html)))) {
    ({ css: localCss, missing } = fontsourceCss(families));
    fonts = localCss ? 'fontsource' : 'none';
  }
  const opts = { args: ['--no-sandbox', '--disable-setuid-sandbox'] };
  if (process.env.CHROME_PATH) opts.executablePath = process.env.CHROME_PATH;
  const browser = await puppeteer.launch(opts);
  const page = await browser.newPage();
  const failed = [];
  if (localCss) {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      if (u.startsWith('https://fonts.googleapis.com/')) return req.respond({ status: 200, contentType: 'text/css', body: localCss });
      if (u.startsWith('https://fonts.gstatic.com/')) return req.abort();
      return req.continue();
    });
  }
  page.on('requestfailed', r => failed.push(r.url().slice(0, 100)));
  await page.goto('file://' + path.resolve(file), { waitUntil: 'networkidle0', timeout: 90000 });
  await page.emulateMediaType('print');
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await new Promise(r => setTimeout(r, 1500));
  const pages = await page.evaluate(() => [...document.querySelectorAll('section.page')].map((el, i) => {
    const h = el.querySelector('h1, h2, h3');
    return { page: i + 1, mm: Math.round(el.getBoundingClientRect().height * 25.4 / 96 * 10) / 10,
             title: h ? h.textContent.trim().replace(/\s+/g, ' ').slice(0, 60) : '' };
  }));
  const loaded = await page.evaluate(() => [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/['"]/g, '')));
  let pdfPages = null;
  if (pdfOut) {
    const buf = await page.pdf({ path: pdfOut, format: 'A4', printBackground: true, preferCSSPageSize: true,
                                 margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    pdfPages = (Buffer.from(buf).toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length;
  }
  await browser.close();
  const fontsFailed = families.filter(f => missing.includes(f) || !loaded.includes(f));
  const over = pages.filter(p => p.mm > A4_MM + SLACK_MM);
  for (const p of pages) {
    console.log(`${String(p.page).padStart(2)}  ${p.mm.toFixed(1).padStart(6)} mm  ${p.mm > A4_MM + SLACK_MM ? 'OVER' : 'ok  '}  ${p.title}`);
  }
  console.log(JSON.stringify({ sections: pages.length, pdf_pages: pdfPages, pages_over: over.map(p => p.page), fonts,
                               fonts_failed: fontsFailed, requests_failed: fonts === 'fontsource' ? [] : failed.slice(0, 5) }));
  process.exit(over.length || (pdfPages && pdfPages > pages.length) ? 2 : 0);
})().catch(e => { console.error('fit-check failed: ' + ((e && e.message) || e)); process.exit(1); });
