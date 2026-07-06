# Dashboard screenshots

Regenerates the README screenshots (`docs/screenshots/*.png`) by driving the live dashboard
with headless Chrome — logs in as a real user, pins a clean theme, and shoots the Overview,
New Project modal, and an app detail page.

```sh
cd tools/screenshots
npm install                       # puppeteer-core (uses your system Chrome, no download)
JD_URL=https://panel.example.com JD_PW='admin-password' node shoot.mjs
```

Env: `JD_URL`, `JD_PW` (required); `JD_APP` (detail-page app, default first app), `JD_OUT`
(default `../../docs/screenshots`), `JD_THEME`/`JD_MODE` (default `github`/`dark`),
`JD_CHROME` (default macOS Chrome path).

Uses `puppeteer-core` against your installed Chrome — no bundled Chromium download.
