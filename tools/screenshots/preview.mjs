// Local preview: seed a throwaway JUSTDEPLOY_HOME, serve the built dashboard, and screenshot
// the New Project modal + an empty project canvas. Verification only — not committed data.
import puppeteer from 'puppeteer-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'jd-preview-'));
process.env.JUSTDEPLOY_HOME = HOME;
process.env.PORT = '4998';
process.env.NODE_OPTIONS = '--disable-warning=ExperimentalWarning';

const auth = await import('../../src/auth.js');
const db = await import('../../src/db.js');
const now = () => new Date('2026-07-12T10:00:00Z').toISOString();

const database = db.open();
auth.setAdminPassword(database, 'preview123');
db.setSetting(database, 'base_domain', 'apps.example.com');
// A project with services, plus an empty one to shoot the empty-canvas state.
db.createProject(database, 'shop', now());
db.createProject(database, 'blog', now()); // empty on purpose
db.upsertApp(database, { name: 'storefront', type: 'nextjs', repo: 'me/storefront', domain: 'shop.example.com', serve: 'container', project: 'shop', created_at: now() });
db.upsertApp(database, { name: 'api', type: 'adonis', repo: 'me/api', domain: 'api.example.com', serve: 'container', project: 'shop', created_at: now() });
db.addResource(database, 'shop-db', 'postgres', 'postgres://x', 5433, now(), 'shop');
db.setEnv(database, 'api', 'DB_HOST', '${{shop-db.PGHOST}}');
db.setEnv(database, 'storefront', 'API_URL', 'https://${{api.domain}}');

const { start } = await import('../../src/dashboard.js');
start({ port: 4998 });
await new Promise((r) => setTimeout(r, 400));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--no-sandbox', '--force-color-profile=srgb'],
  defaultViewport: { width: 1200, height: 820, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => { localStorage.setItem('justdeploy.theme.id', 'github'); localStorage.setItem('justdeploy.theme.mode', 'dark'); });
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

await page.goto('http://127.0.0.1:4998/', { waitUntil: 'networkidle2' });
await page.waitForSelector('input[type=password]', { timeout: 15000 });
await page.type('input[type=password]', 'preview123');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.body.innerText.includes('Projects'), { timeout: 20000 });
await settle(900);

// New Project modal
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /New Project/i.test(b.textContent))?.click());
await page.waitForFunction(() => document.body.innerText.includes('A project groups related services'), { timeout: 8000 });
await settle(500);
await page.type('input.field', 'payments');
await settle(300);
await page.screenshot({ path: '/tmp/modal.png' });
console.log('modal.png');

// Empty project canvas
await page.goto('http://127.0.0.1:4998/projects/blog', { waitUntil: 'networkidle2' });
await page.waitForFunction(() => document.body.innerText.includes('no services yet') || document.body.innerText.includes('No services'), { timeout: 8000 }).catch(() => {});
await settle(700);
await page.screenshot({ path: '/tmp/empty-canvas.png' });
console.log('empty-canvas.png');

await browser.close();
process.exit(0);
