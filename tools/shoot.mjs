// Screenshot the DOM UI (HUD / controls / play-select / portrait gate) at any
// viewport, so the landscape layout can be eyeballed without launching the full
// WebGL game. The field is a CSS stand-in (see tools/ui-preview.html).
//
// Setup (once):  npm i -D playwright && npx playwright install chromium
// Usage:         node tools/shoot.mjs [screen] [out.png] [WxH]
//   screen: "play" (in-play HUD, default) | "playselect" | "portrait"
//   e.g.    node tools/shoot.mjs playselect /tmp/ps.png 844x390
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [, , screen = 'play', out = `/tmp/ui_${screen}.png`, size] = process.argv;
const dims = size || (screen === 'portrait' ? '390x844' : '844x390');
const [w, h] = dims.split('x').map(Number);
const file = pathToFileURL(resolve('tools/ui-preview.html')).href;
const url = screen === 'playselect' ? `${file}?screen=play` : file;

// Honor a pre-installed browser path if the env provides one (CI sandboxes).
const launch = {};
if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
launch.args = ['--no-sandbox', '--use-gl=swiftshader'];

const browser = await chromium.launch(launch);
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(400);
await page.screenshot({ path: out });
await browser.close();
console.log(`shot ${out} @ ${dims}`);
