// Screenshots of the side panel for the README, light and dark:
//   npm run screenshots   ->  docs/sidepanel-light.png, docs/sidepanel-dark.png

import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extensionWorker, launch, openPanel, pageByTitle, sleep, startServer, waitFor } from '../test/harness.mjs';

const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));
const PROFILE = fileURLToPath(new URL('../test/artifacts/screenshot-profile', import.meta.url));

// [title, favicon colour, parent title (opened by a link from it)]
const TABS = [
  ['vertical tree tabs - Google Search', '#4285f4', null],
  ['Tree (data structure) - Wikipedia', '#5f6368', 'vertical tree tabs - Google Search'],
  ['chrome.tabs | Chrome for Developers', '#1a73e8', 'vertical tree tabs - Google Search'],
  ['openerTabId is undefined - Stack Overflow', '#f48024', 'chrome.tabs | Chrome for Developers'],
  ['chrome.sidePanel | Chrome for Developers', '#1a73e8', 'chrome.tabs | Chrome for Developers'],
  ['Tree Style Tab – Add-ons for Firefox', '#ff7139', 'vertical tree tabs - Google Search'],
  ['Inbox (3) - Mail', '#d93025', null],
  ['Flight confirmation – Booking #4821', '#0b8043', 'Inbox (3) - Mail'],
  ['Weekend in Lisbon – Things to do', '#8e24aa', 'Flight confirmation – Booking #4821'],
  ['Hotel Avenida – Lisbon – Rooms', '#00897b', 'Flight confirmation – Booking #4821'],
  ['Pull requests · my-project', '#24292f', null],
  ['Fix restore after restart #42', '#24292f', 'Pull requests · my-project'],
];

await rm(PROFILE, { recursive: true, force: true });
await mkdir(DOCS, { recursive: true });
const { server, base } = await startServer();
const browser = await launch({ profile: PROFILE });
try {
  const { worker, extensionId } = await extensionWorker(browser);
  const urlFor = (title, color) => `${base}/?name=t${TABS.findIndex(([t]) => t === title)}`
    + `&title=${encodeURIComponent(title)}&color=${encodeURIComponent(color)}`;

  // Open every tab the way a person would: top-level ones fresh, the rest by clicking a
  // link (pointed at the right page first) with the middle button on their parent page.
  let windowId;
  for (const [title, color, parent] of TABS) {
    if (parent == null) {
      const page = await browser.newPage();
      await page.goto(urlFor(title, color));
    } else {
      const page = await pageByTitle(browser, parent);
      await page.bringToFront(); // Puppeteer cannot click in a hidden tab
      await page.$eval('#l1', (a, href) => { a.href = href; }, urlFor(title, color));
      await page.click('#l1', { button: 'middle' });
    }
    await pageByTitle(browser, title);
  }
  // Close the blank start tab and make the Stack Overflow page the active one.
  await worker.evaluate(async () => {
    const blank = (await chrome.tabs.query({})).filter((tab) => tab.url === 'about:blank');
    await chrome.tabs.remove(blank.map((tab) => tab.id));
  });
  const active = await pageByTitle(browser, 'openerTabId is undefined - Stack Overflow');
  await active.bringToFront();
  const activeTab = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]);
  windowId = activeTab.windowId;

  const panel = await openPanel(browser, worker, extensionId, windowId, { width: 320, height: 470 });
  // Collapse the pull-request tree to show what a collapsed tree looks like.
  await panel.evaluate(async (w) => {
    const [pr] = await chrome.tabs.query({ windowId: w, title: 'Pull requests · my-project' });
    await chrome.runtime.sendMessage({ type: 'setCollapsed', tabId: pr.id, collapsed: true });
  }, windowId);
  await waitFor(async () => (await panel.$$('#tree .row')).length === TABS.length - 1, 'all rows');
  // The trees' tab groups, named, once the worker has made them (it waits a few seconds after a fresh start).
  await waitFor(async () => (await panel.$$('#tree .group-name:not([hidden])')).length === 3, 'the group names', 15000);
  await sleep(500); // favicons
  for (const scheme of ['light', 'dark']) {
    await panel.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await panel.hover('#tree .row:nth-child(7) .title'); // shows a hover state and a close button
    await sleep(200);
    await panel.screenshot({ path: `${DOCS}sidepanel-${scheme}.png` });
    console.log(`docs/sidepanel-${scheme}.png`);
  }
} finally {
  await browser.close();
  server.close();
  await rm(PROFILE, { recursive: true, force: true });
}
