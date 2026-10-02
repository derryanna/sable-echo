// Screenshots of dev/preview.html at 412×915 (Android phone) into dev/shots/, plus a layout audit per shot:
// horizontal overflow, elements outside the panel, clipped text and tap targets under 36px (word chips 32px).
//
//   node dev/shot.mjs                      all shots
//   node dev/shot.mjs 04-editor            one shot
//   SHOT_WIDTH=1280 SHOT_LANG=en node dev/shot.mjs 05-view   (ad-hoc checks; files get a suffix)
//
// puppeteer-core is not a dependency of this repository: it is imported from the usual resolution path, or from
// the folder in PUPPETEER_DIR (one that has node_modules/puppeteer-core). Chrome comes from CHROME_PATH or the
// default install location.
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function loadPuppeteer() {
  try { return (await import('puppeteer-core')).default; } catch (error) {
    if (!process.env.PUPPETEER_DIR) throw new Error('puppeteer-core not found: install it or set PUPPETEER_DIR', { cause: error });
    const require = createRequire(`${process.env.PUPPETEER_DIR.replace(/[\\/]$/, '')}/`);
    return (await import(pathToFileURL(require.resolve('puppeteer-core')).href)).default;
  }
}

const CHROME = process.env.CHROME_PATH || {
  win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
}[process.platform] || '/usr/bin/google-chrome';
const width = Number(process.env.SHOT_WIDTH) || 412, height = Number(process.env.SHOT_HEIGHT) || 915;
const language = process.env.SHOT_LANG === 'en' ? 'en' : 'ru';
const suffix = `${width === 412 ? '' : `-${width}`}${language === 'en' ? '-en' : ''}`;
const preview = new URL('./preview.html', import.meta.url);
const outDir = fileURLToPath(new URL('./shots/', import.meta.url));

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Click the n-th element matching a selector inside the page (throws when it is missing). */
const click = (page, selector, index = 0) => page.evaluate((query, n) => {
  const element = document.querySelectorAll(query)[n];
  if (!element) throw new Error(`missing ${query} #${n}`);
  element.click();
}, selector, index);
/** Scroll the panel's own scroller so the element's top is near the top. scrollIntoView would also scroll the
 *  overflow-hidden panel itself once the scroller hits its end, which clips the header in the shot. */
const reveal = (page, selector) => page.evaluate(query => {
  const element = document.querySelector(query), scroller = element?.closest('.st-echo-scroll');
  if (scroller) scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
  else element?.scrollIntoView({ block: 'start' });
}, selector);

const SHOTS = [
  { name: '10-settings-phone', settings: true, width: 412 },
  { name: '11-settings-pc', settings: true, width: 1280, column: 300 },
  { name: '01-full', state: 'full' },
  { name: '02-cut', state: 'full', async steps(page) {
    await click(page, '.st-echo-w', 3);
    await click(page, '.st-echo-w', 4);
    await click(page, '[data-act="examples"]', 0);
  } },
  { name: '03-menu', state: 'full', async steps(page) { await click(page, '[data-act="keep"]', 1); } },
  { name: '04-editor', state: 'full', async steps(page) {
    await click(page, '.st-echo-bt', 0);
    await click(page, '[data-act="suggest"]');
    await pause(50);
    await reveal(page, '.st-echo-bed');
  } },
  { name: '05-view', state: 'full', async steps(page) { await click(page, '[data-act="view"]'); } },
  { name: '06-nojev', state: 'nojev' },
  { name: '07-empty', state: 'empty' },
  { name: '08-patterns-nojev', state: 'nojev', async steps(page) { await reveal(page, '[data-card="pats"]'); } },
  { name: '12-bg', state: 'full', bg: 'cover' },
];

function audit(fullPage = false) {
  const drawer = document.querySelector('.st-echo-settings') ?? document.querySelector('.st-echo-drawer'), box = drawer.getBoundingClientRect();
  const scroller = drawer.querySelector('.st-echo-scroll');
  const name = element => (element.getAttribute('aria-label') || element.textContent || element.className).trim().replace(/\s+/g, ' ').slice(0, 48);
  const visible = rect => rect.width > 0 && rect.height > 0 && (fullPage || (rect.bottom > 0 && rect.top < innerHeight));
  const result = {
    drawer: [box.x, box.y, box.width, box.height].map(Math.round),
    pageOverflowX: document.scrollingElement.scrollWidth > innerWidth,
    scrollerOverflowX: scroller ? scroller.scrollWidth > scroller.clientWidth : null,
    small: [], clipped: [], outside: [], controls: [], tall: [],
  };
  for (const element of drawer.querySelectorAll('select, input:not([type="range"]), button')) {
    const height = element.getBoundingClientRect().height;
    const measurement = { control: element.tagName.toLowerCase(), name: element.name || name(element), height: Math.round(height * 100) / 100 };
    result.controls.push(measurement);
    if (height > 44) result.tall.push(measurement);
  }
  for (const element of drawer.querySelectorAll('button, input, select, [role="button"]')) {
    // A theme checkbox is tapped through its checkbox_label row; the themed sliders' range inputs are 28px tall (SPEC §19.1).
    const target = element.matches('.checkbox_label > input[type="checkbox"]') ? element.parentElement : element;
    const rect = target.getBoundingClientRect();
    if (!visible(rect)) continue;
    const min = element.matches('.st-echo-w, .st-echo-bt, .st-echo-bx, .st-echo-sg') ? 32 : 36;
    const minHeight = element.matches('.st-echo-range-compact, .st-echo-range') ? 28 : min;
    if (rect.height < minHeight - 0.5 || rect.width < min - 0.5) result.small.push(`${name(element)} ${Math.round(rect.width)}×${Math.round(rect.height)}`);
  }
  for (const element of drawer.querySelectorAll('*')) {
    if (element instanceof SVGElement) continue;
    const rect = element.getBoundingClientRect();
    if (!visible(rect)) continue;
    if (rect.right > box.right + 0.5 || rect.left < box.left - 0.5) result.outside.push(name(element));
    const style = getComputedStyle(element);
    const clips = style.overflowX !== 'visible' || style.textOverflow === 'ellipsis';
    if (clips && style.textOverflow !== 'ellipsis' && element !== scroller && element.scrollWidth > element.clientWidth + 1) result.clipped.push(name(element));
  }
  return result;
}

const puppeteer = await loadPuppeteer();
const wanted = process.argv.slice(2);
await mkdir(outDir, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--allow-file-access-from-files'] });
let problems = 0;
try {
  for (const shot of SHOTS.filter(item => !wanted.length || wanted.includes(item.name))) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    await page.setViewport({ width: shot.width ?? width, height, deviceScaleFactor: 2, isMobile: (shot.width ?? width) < 700, hasTouch: (shot.width ?? width) < 700 });
    const url = new URL(shot.settings ? './settings.html' : preview, import.meta.url);
    if (shot.column) url.searchParams.set('column', shot.column);
    if (shot.bg) url.searchParams.set('bg', shot.bg);
    url.searchParams.set('state', shot.state);
    if (language === 'en') url.searchParams.set('lang', 'en');
    await page.goto(url.href, { waitUntil: 'load' });
    await page.waitForFunction(() => document.title === 'ready', { timeout: 15000 });
    await shot.steps?.(page);
    await pause(450);
    const file = `${outDir}${shot.name}${suffix}.png`;
    await page.screenshot({ path: file, fullPage: !!shot.settings });
    const report = await page.evaluate(audit, !!shot.settings);
    const bad = report.pageOverflowX || report.scrollerOverflowX || report.tall.length || report.small.length || report.clipped.length || report.outside.length || errors.length;
    if (bad) problems++;
    console.log(`${bad ? '!!' : 'ok'} ${shot.name}${suffix}`, JSON.stringify({ ...report, errors }));
    await page.close();
  }
} finally {
  await browser.close();
}
process.exitCode = problems ? 1 : 0;
