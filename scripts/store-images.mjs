// The pictures for the browser stores' listings (see docs/PUBLISHING.md), made from the real panel and settings page:
//   npm run store-images  ->  store/screenshot-1-tree.png ... screenshot-4-dark.png (1280x800),
//                             store/promo-440x280.png, store/marquee-1400x560.png, store/logo-300.png,
//                             store/icon-128.png (the icon inside the stores' 16 px of padding)
// The demo tabs name no browser and no other extension: the stores' listings must not.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extensionWorker, launch, openPanel, pageByTitle, sleep, startServer, waitFor } from '../test/harness.mjs';

const STORE = fileURLToPath(new URL('../store/', import.meta.url));
const ICON = fileURLToPath(new URL('../extension/icons/icon.svg', import.meta.url));
const PROFILE = process.env.STORE_PROFILE || fileURLToPath(new URL('../test/artifacts/store-profile', import.meta.url));

// [title, favicon colour, parent title (opened by a link from it)]
const TABS = [
  ['day hikes near the lake - Search', '#4285f4', null],
  ['Ridge Loop – 12 km trail guide', '#2e7d32', 'day hikes near the lake - Search'],
  ['Weather – Lake District, this weekend', '#0277bd', 'day hikes near the lake - Search'],
  ['Hourly forecast – Saturday', '#0277bd', 'Weather – Lake District, this weekend'],
  ['Day-hike packing list', '#ef6c00', 'day hikes near the lake - Search'],
  ['Inbox (3) - Mail', '#d93025', null],
  ['Flight confirmation – Booking #4821', '#0b8043', 'Inbox (3) - Mail'],
  ['Weekend in Lisbon – Things to do', '#8e24aa', 'Flight confirmation – Booking #4821'],
  ['Hotel Avenida – Lisbon – Rooms', '#00897b', 'Flight confirmation – Booking #4821'],
  ['Pull requests · my-project', '#24292f', null],
  ['Fix restore after restart #42', '#24292f', 'Pull requests · my-project'],
  ['Recipe: lemon pasta', '#c62828', null],
];
const ACTIVE = 'Hourly forecast – Saturday';

const BLUE = '#1b5fd6';
const INK = '#14213d';

/** A 1280x800 (or other) picture: a title, a line, points on the left, and a picture of the panel on the right. */
function slide({ title, text, points, image, imageWidth = 400, dark = false, width = 1280, height = 800 }) {
  const bg = dark ? 'linear-gradient(135deg, #10192e, #1e2a44)' : 'linear-gradient(135deg, #eef3fd, #dfe8fb)';
  const fg = dark ? '#e8eefc' : INK;
  const soft = dark ? '#b8c4de' : '#3d4b66';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: ${bg};
      font-family: "Segoe UI", system-ui, sans-serif; color: ${fg}; display: flex; align-items: center; gap: 64px;
      padding: 0 80px; }
    .words { flex: 1; }
    h1 { margin: 0 0 18px; font-size: 46px; line-height: 1.15; font-weight: 700; letter-spacing: -0.5px; }
    p { margin: 0 0 26px; font-size: 22px; line-height: 1.45; color: ${soft}; }
    ul { margin: 0; padding: 0; list-style: none; }
    li { position: relative; margin: 0 0 14px; padding-left: 30px; font-size: 20px; line-height: 1.4; }
    li::before { content: ''; position: absolute; left: 4px; top: 10px; width: 10px; height: 10px; border-radius: 50%;
      background: ${dark ? '#8ab4ff' : BLUE}; }
    .shot { flex: none; border-radius: 14px; overflow: hidden; box-shadow: 0 18px 50px rgba(10, 30, 70, ${dark ? 0.6 : 0.25}),
      0 0 0 1px rgba(10, 30, 70, 0.08); }
    .shot img { display: block; width: ${imageWidth}px; }
  </style></head><body>
    <div class="words"><h1>${title}</h1><p>${text}</p><ul>${points.map((point) => `<li>${point}</li>`).join('')}</ul></div>
    <div class="shot"><img src="${image}"></div>
  </body></html>`;
}

const png = (buffer) => `data:image/png;base64,${Buffer.from(buffer).toString('base64')}`;

await rm(PROFILE, { recursive: true, force: true });
await mkdir(STORE, { recursive: true });
const { server, base } = await startServer();
const browser = await launch({ profile: PROFILE });
try {
  const { worker, extensionId } = await extensionWorker(browser);
  const urlFor = (title, color) => `${base}/?name=t${TABS.findIndex(([t]) => t === title)}`
    + `&title=${encodeURIComponent(title)}&color=${encodeURIComponent(color)}`;

  // Open every tab the way a person would: top-level ones fresh, the rest by a middle-click on a link of their parent.
  for (const [title, color, parent] of TABS) {
    if (parent == null) {
      const page = await browser.newPage();
      await page.goto(urlFor(title, color));
    } else {
      const page = await pageByTitle(browser, parent);
      await page.bringToFront();
      await page.$eval('#l1', (a, href) => { a.href = href; }, urlFor(title, color));
      await page.click('#l1', { button: 'middle' });
    }
    await pageByTitle(browser, title);
  }
  await worker.evaluate(async () => {
    const blank = (await chrome.tabs.query({})).filter((tab) => tab.url === 'about:blank');
    await chrome.tabs.remove(blank.map((tab) => tab.id));
  });
  const active = await pageByTitle(browser, ACTIVE);
  await active.bringToFront();
  const { windowId } = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]);

  const panel = await openPanel(browser, worker, extensionId, windowId, { width: 340, height: 560 });
  await panel.setViewport({ width: 340, height: 560, deviceScaleFactor: 2 });
  await panel.evaluate(async (w) => {
    const [pr] = await chrome.tabs.query({ windowId: w, title: 'Pull requests · my-project' });
    await chrome.runtime.sendMessage({ type: 'setCollapsed', tabId: pr.id, collapsed: true });
  }, windowId);
  await waitFor(async () => (await panel.$$('#tree .row')).length === TABS.length - 1, 'all rows');
  await waitFor(async () => (await panel.$$('#tree .group-name:not([hidden])')).length === 3, 'the group names', 15000);
  await sleep(800); // favicons

  const shots = {};
  for (const scheme of ['light', 'dark']) {
    await panel.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await panel.hover('#tree .row:nth-child(2) .title');
    await sleep(250);
    shots[scheme] = png(await panel.screenshot());
  }
  // The right-click menu of a tab, with the tree's colours and its group's name: the panel taller, for the menu.
  await panel.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await panel.setViewport({ width: 340, height: 720, deviceScaleFactor: 2 });
  await sleep(300);
  await panel.click('#tree .row:nth-child(6) .title', { button: 'right' });
  await sleep(400);
  shots.menu = png(await panel.screenshot());
  await panel.keyboard.press('Escape');

  // The settings page.
  const options = await browser.newPage();
  await options.setViewport({ width: 560, height: 640, deviceScaleFactor: 2 });
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.waitForSelector('#settings input:checked');
  await options.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  shots.options = png(await options.screenshot({ fullPage: true }));

  const canvas = await browser.newPage();
  const render = async (html, file, width, height) => {
    await canvas.setViewport({ width, height, deviceScaleFactor: 1 });
    await canvas.setContent(html, { waitUntil: 'load' });
    await canvas.screenshot({ path: `${STORE}${file}`, clip: { x: 0, y: 0, width, height } });
    console.log(`store/${file}`);
  };
  await render(slide({
    title: 'Your tabs, as a tree',
    text: 'Every tab you open from a link sits under the page you opened it from, beside the page you are reading.',
    points: ['Collapse a tree to tuck it away', 'Drag a tab with all the tabs under it', 'Search by title or address'],
    image: shots.light,
  }), 'screenshot-1-tree.png', 1280, 800);
  await render(slide({
    title: 'A colour and a tab group for every tree',
    text: 'Each tree gets a colour of its own and becomes a tab group, named after its top page.',
    points: ['Rename or recolour it from the right-click menu', 'Collapse a tree, and its group collapses too',
      'Move a tree to a new window in one click'],
    image: shots.menu,
    imageWidth: 330,
  }), 'screenshot-2-groups.png', 1280, 800);
  await render(slide({
    title: 'Group your tabs your way',
    text: 'One group per tree, per innermost subtree, per page or per branch, or no groups at all.',
    points: ['Your own tab groups left alone, or regrouped', 'Changes apply at once'],
    image: shots.options,
    imageWidth: 470,
  }), 'screenshot-3-settings.png', 1280, 800);
  await render(slide({
    title: 'Light or dark, and kept for you',
    text: 'It follows your browser\'s theme, and keeps your trees when the browser restarts or a window comes back.',
    points: ['Keyboard control of the whole tree', 'No account, no tracking: what it keeps stays in your browser'],
    image: shots.dark,
    dark: true,
  }), 'screenshot-4-dark.png', 1280, 800);

  // The small promotional tile and the marquee.
  const icon = await readFile(ICON, 'utf8');
  const iconData = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(icon)}`;
  const tile = (width, height, iconSize, titleSize, textSize, image) => `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; display: flex; align-items: center;
      gap: ${Math.round(width / 22)}px; padding: 0 ${Math.round(width / 14)}px; box-sizing: border-box;
      background: linear-gradient(135deg, #4c8dff, #1b5fd6); font-family: "Segoe UI", system-ui, sans-serif; color: #fff; }
    img.icon { width: ${iconSize}px; height: ${iconSize}px; filter: drop-shadow(0 6px 14px rgba(0, 20, 60, .35)); }
    h1 { margin: 0 0 8px; font-size: ${titleSize}px; font-weight: 700; line-height: 1.1; }
    p { margin: 0; font-size: ${textSize}px; opacity: .92; line-height: 1.35; }
    .words { flex: 1; }
    .shot { border-radius: 14px; overflow: hidden; box-shadow: 0 18px 50px rgba(0, 20, 60, .35); }
    .shot img { display: block; width: 300px; }
  </style></head><body>
    <img class="icon" src="${iconData}"><div class="words"><h1>Vertical Tree Tabs</h1>
    <p>Your tabs as a tree, each one under the page you opened it from.</p></div>
    ${image ? `<div class="shot"><img src="${image}"></div>` : ''}
  </body></html>`;
  await render(tile(440, 280, 96, 30, 16, null), 'promo-440x280.png', 440, 280);
  await render(tile(1400, 560, 150, 60, 28, shots.light), 'marquee-1400x560.png', 1400, 560);

  // The logo (300x300) and the store icon: the artwork within 16 px of transparent padding, as the stores ask.
  const icons = await canvas.evaluate(async (source) => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
    await image.decode();
    const draw = (size, inner) => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      // The artwork is the 120 px rounded square of the 128 px drawing: scale it to `inner` and centre it.
      const scale = inner / 120;
      const drawn = 128 * scale;
      c.getContext('2d').drawImage(image, (size - drawn) / 2, (size - drawn) / 2, drawn, drawn);
      return c.toDataURL('image/png').split(',')[1];
    };
    return { logo: draw(300, 300 * 120 / 128), icon: draw(128, 96) };
  }, icon);
  await writeFile(`${STORE}logo-300.png`, Buffer.from(icons.logo, 'base64'));
  console.log('store/logo-300.png');
  await writeFile(`${STORE}icon-128.png`, Buffer.from(icons.icon, 'base64'));
  console.log('store/icon-128.png');
} finally {
  await browser.close();
  server.close();
  await rm(PROFILE, { recursive: true, force: true });
}
