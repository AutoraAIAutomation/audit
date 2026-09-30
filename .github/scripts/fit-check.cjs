#!/usr/bin/env node
// A4 fit check for an audit page, run by the "Audit page writer" routine before it pushes.
// Renders the page the way .github/workflows/pdf.yml does (puppeteer, print media, A4, no margins), measures every
// <section class="page"> and lists any that is taller than one A4 sheet, which would spill onto an extra PDF page.
// Exit 0: every page fits. Exit 2: at least one page runs over. Exit 1: the check itself failed.
// Usage (from the repo root): NODE_PATH=/tmp/fit/node_modules node .github/scripts/fit-check.cjs <folder>/index.html [out.pdf]
// Needs puppeteer (npm i puppeteer@23 in /tmp/fit), or puppeteer-core plus CHROME_PATH.
const path = require('path');
let puppeteer;
try { puppeteer = require('puppeteer'); } catch (e) { puppeteer = require('puppeteer-core'); }
const A4_MM = 297, SLACK_MM = 0.5;

(async () => {
  const [file, pdfOut] = process.argv.slice(2);
  if (!file) { console.error('usage: fit-check.cjs <page.html> [out.pdf]'); process.exit(1); }
  const opts = { args: ['--no-sandbox', '--disable-setuid-sandbox'] };
  if (process.env.CHROME_PATH) opts.executablePath = process.env.CHROME_PATH;
  const browser = await puppeteer.launch(opts);
  const page = await browser.newPage();
  const failed = [];
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
  const fontsFailed = await page.evaluate(() => [...document.fonts].filter(f => f.status === 'error').map(f => f.family));
  let pdfPages = null;
  if (pdfOut) {
    const buf = await page.pdf({ path: pdfOut, format: 'A4', printBackground: true, preferCSSPageSize: true,
                                 margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    pdfPages = (Buffer.from(buf).toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length;
  }
  await browser.close();
  const over = pages.filter(p => p.mm > A4_MM + SLACK_MM);
  for (const p of pages) {
    console.log(`${String(p.page).padStart(2)}  ${p.mm.toFixed(1).padStart(6)} mm  ${p.mm > A4_MM + SLACK_MM ? 'OVER' : 'ok  '}  ${p.title}`);
  }
  console.log(JSON.stringify({ sections: pages.length, pdf_pages: pdfPages, pages_over: over.map(p => p.page),
                               fonts_failed: [...new Set(fontsFailed)], requests_failed: failed.slice(0, 5) }));
  process.exit(over.length || (pdfPages && pdfPages > pages.length) ? 2 : 0);
})().catch(e => { console.error('fit-check failed: ' + ((e && e.message) || e)); process.exit(1); });
