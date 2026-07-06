// Capture dashboard screenshots for the README with headless Chrome (Puppeteer).
// Logs in as a real user, pins a clean theme, and shoots Overview / New Project / App detail.
//
// Usage:
//   cd tools/screenshots && npm install
//   JD_URL=https://panel.example.com JD_PW='your-admin-password' JD_APP=showmelove \
//     node shoot.mjs
//
// Env:
//   JD_URL   dashboard base URL           (required)
//   JD_PW    admin password               (required)
//   JD_APP   app name for the detail shot  (default: first app found)
//   JD_OUT   output dir                    (default: ../../docs/screenshots)
//   JD_THEME justui theme id / mode        (default: github / dark)
//   JD_CHROME path to Chrome              (default: macOS Google Chrome)
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL = process.env.JD_URL;
const PW = process.env.JD_PW;
const OUT = process.env.JD_OUT || join(HERE, '..', '..', 'docs', 'screenshots');
const THEME = process.env.JD_THEME || 'github';
const MODE = process.env.JD_MODE || 'dark';
const CHROME = process.env.JD_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!URL || !PW) { console.error('set JD_URL and JD_PW'); process.exit(1); }
mkdirSync(OUT, { recursive: true });

const settle = (ms = 1000) => new Promise((r) => setTimeout(r, ms));
const clickByText = (page, re) => page.evaluate((r) => {
  const b = [...document.querySelectorAll('button')].find((x) => new RegExp(r, 'i').test(x.textContent));
  b?.click();
}, re.source);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--force-color-profile=srgb'],
  defaultViewport: { width: 1360, height: 860, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.evaluateOnNewDocument(([id, mode]) => {
  localStorage.setItem('justdeploy.theme.id', id);
  localStorage.setItem('justdeploy.theme.mode', mode);
}, [THEME, MODE]);

// login
await page.goto(URL + '/', { waitUntil: 'networkidle2' });
await page.waitForSelector('input[type=password]', { timeout: 15000 });
await page.type('input[type=password]', PW);
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.body.innerText.includes('Your fleet at a glance'), { timeout: 20000 });
await settle(1200);
await page.screenshot({ path: join(OUT, 'overview.png') });
console.log('overview.png');

// new project modal (pick a type so fields show)
await clickByText(page, /New Project/);
await page.waitForFunction(() => document.body.innerText.includes('Pick a type'), { timeout: 8000 });
await settle(500);
await clickByText(page, /AdonisJS/);
await settle(500);
await page.screenshot({ path: join(OUT, 'new-project.png') });
console.log('new-project.png');

// app detail
const app = process.env.JD_APP || await page.evaluate(() => {
  const a = document.querySelector('a[href^="/apps/"]');
  return a ? a.getAttribute('href').split('/').pop() : null;
});
if (app) {
  await page.goto(`${URL}/apps/${app}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.body.innerText.includes('Environment'), { timeout: 15000 });
  await settle(1200);
  await page.screenshot({ path: join(OUT, 'app-detail.png') });
  console.log('app-detail.png');
}

await browser.close();
console.log('done →', OUT);
