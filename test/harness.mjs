// Shared helpers for driving the extension in a real Chromium (end-to-end test, screenshots).

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findChrome } from '../scripts/find-chrome.mjs';

export const EXTENSION = fileURLToPath(new URL('../extension', import.meta.url));

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(check, what, timeout = 10000) {
  const start = Date.now();
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const escape = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A coloured letter as an SVG favicon. */
function favicon(color, letter) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='4' fill='${color}'/>`
    + `<text x='8' y='12' font-family='Arial' font-size='11' font-weight='700' fill='white' text-anchor='middle'>${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Local pages: /?name=X is titled X (or &title=) and links to X.1 ... X.6 in new tabs,
 * to X.same in the same tab, and opens X.js with window.open.
 */
export async function startServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/') {
      response.writeHead(404).end();
      return;
    }
    const name = (url.searchParams.get('name') ?? 'root').replace(/[^\w.-]/g, '');
    const title = url.searchParams.get('title') ?? name;
    const color = url.searchParams.get('color');
    const icon = color ? `<link rel="icon" href="${favicon(color, escape(title[0]))}">` : '';
    const links = Array.from({ length: 6 }, (_, i) =>
      `<p><a id="l${i + 1}" href="/?name=${name}.${i + 1}" target="_blank">${name}.${i + 1}</a></p>`).join('');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>${icon}
      <h1>${escape(title)}</h1>${links}
      <p><a id="same" href="/?name=${name}.same">same tab</a></p>
      <button id="open" onclick="window.open('/?name=${name}.js')">window.open</button>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

export function launch({ profile, args = [], headless = true }) {
  return puppeteer.launch({
    executablePath: findChrome(),
    headless,
    userDataDir: profile,
    enableExtensions: true,
    pipe: true, // with the flag below, allows Extensions.loadUnpacked (see reloadExtension)
    defaultViewport: null,
    protocolTimeout: 30000,
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--enable-unsafe-extension-debugging',
      ...args,
    ],
  });
}

/**
 * Reload the extension the way the reload button on chrome://extensions does: install the
 * same folder again. (chrome.runtime.reload() just unloads an extension that was loaded
 * with --load-extension.)
 */
export async function reloadExtension(browser) {
  const session = await browser.target().createCDPSession();
  try {
    await session.send('Extensions.loadUnpacked', { path: EXTENSION });
  } finally {
    await session.detach();
  }
}

/**
 * The extension's service worker; pass the targets of the workers there were before (one, or a list) to
 * wait for a new one. A worker that a reload replaced can stay listed as a target that answers nothing.
 */
export async function extensionWorker(browser, previous = null) {
  const old = new Set([previous ?? []].flat());
  const target = await browser.waitForTarget(
    (t) => !old.has(t) && t.type() === 'service_worker' && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(t.url()),
    { timeout: 15000 },
  );
  return { target, worker: await target.worker(), extensionId: new URL(target.url()).host };
}

export async function pageByTitle(browser, title) {
  return waitFor(async () => {
    for (const page of await browser.pages()) {
      if ((await page.title().catch(() => '')) === title) return page;
    }
    return null;
  }, `a page titled ${title}`);
}

/** The page of startServer's /?name=`name`, once it has loaded (found by URL: quicker than by title). */
export async function pageNamed(browser, base, name) {
  const url = `${base}/?name=${name}`;
  const target = await browser.waitForTarget((t) => t.url() === url, { timeout: 10000 });
  const page = await target.page();
  await page.waitForSelector('#open'); // the end of the page
  return page;
}

/** Open the side panel page for `windowId` in a window of its own and return its page. */
export async function openPanel(browser, worker, extensionId, windowId, { width = 340, height = 560 } = {}) {
  const url = `chrome-extension://${extensionId}/sidepanel.html?windowId=${windowId}`;
  // Only the new window's page: right after an extension reload a panel page from before it can still be
  // listed with the same URL, about to become Edge's New Tab page.
  const before = new Set(browser.targets());
  await worker.evaluate((u, w, h) => chrome.windows.create({ url: u, width: w, height: h }), url, width + 16, height + 80);
  const target = await browser.waitForTarget((t) => !before.has(t) && t.url() === url, { timeout: 10000 });
  const panel = await target.page();
  await panel.setViewport({ width, height });
  await panel.waitForSelector('#tree');
  return panel;
}
