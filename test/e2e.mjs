// End-to-end check in a real Chromium with the extension loaded.
//   npm run test:e2e
// Needs Chrome for Testing or Chromium (see scripts/find-chrome.mjs); runs headless.

import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  extensionWorker, launch, openPanel, pageNamed, reloadExtension, sleep, startServer, waitFor,
} from './harness.mjs';

const ARTIFACTS = fileURLToPath(new URL('./artifacts/', import.meta.url));
const PROFILE = process.env.E2E_PROFILE || `${ARTIFACTS}profile`;
const SNAPSHOT_SETTLE_MS = 1500; // the worker saves its snapshot 1 s after the last change

const isTestPage = (title) => /^A(\.|$)/.test(title ?? '');

let passed = 0;
async function step(name, body) {
  const start = Date.now();
  await body();
  console.log(`ok ${++passed} - ${name} (${Date.now() - start} ms)`);
}

/** Poll until get() deep-equals expected; on timeout fail with a diff. */
async function eventually(get, expected, what, timeout = 10000) {
  const start = Date.now();
  let actual;
  do {
    actual = await get();
    if (isDeepStrictEqual(actual, expected)) return;
    await sleep(100);
  } while (Date.now() - start < timeout);
  assert.deepEqual(actual, expected, what);
}

// Errors the extension logs (worker or panel) fail the run even if every check passed.
// Only the extension's own scripts count: when the extension reloads, Edge replaces the
// panel's tab with its New Tab page, whose errors are not ours.
const loggedErrors = [];
const ours = (url) => (url ?? '').startsWith(`chrome-extension://${extensionId}/`);
function collectErrors(source, label) {
  source.on('console', (message) => {
    if (message.type() === 'error' && ours(message.location()?.url)) loggedErrors.push(`${label}: ${message.text()}`);
  });
  source.on('pageerror', (error) => {
    if (ours(source.url())) loggedErrors.push(`${label}: ${error.message}`);
  });
  return source;
}

/** launch() again with the same profile: the browser just closed may hold on to it for a moment. */
async function relaunch(options) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await launch(options);
    } catch (error) {
      if (attempt === 5 || !/already running/.test(error.message)) throw error;
      await sleep(2000);
    }
  }
}

await rm(PROFILE, { recursive: true, force: true });
await mkdir(ARTIFACTS, { recursive: true });
const { server, base } = await startServer();
let browser = await launch({ profile: PROFILE });
let { worker, extensionId } = await extensionWorker(browser);
collectErrors(worker, 'worker');
// E2E_GROUPS=off runs the checks with the browser's tab groups off (the setting `groups`, see groups.js; the default is
// trees). The steps about the groups set what they need, and put this back after them. (Not innermost: the colour
// steps check whole trees' shades.)
const GROUPS = process.env.E2E_GROUPS || 'trees';
if (!['trees', 'off'].includes(GROUPS)) throw new Error(`E2E_GROUPS must be trees or off, not ${GROUPS}`);
if (GROUPS !== 'trees') await worker.evaluate((groups) => chrome.storage.local.set({ settings: { groups, ownGroups: 'leave' } }), GROUPS);

const inWorker = (fn, ...args) => worker.evaluate(fn, ...args);
/** Reload the extension and take its new worker (see extensionWorker). */
async function reload() {
  const replaced = browser.targets().filter((t) => t.type() === 'service_worker');
  await reloadExtension(browser);
  ({ worker } = await extensionWorker(browser, replaced));
}
const allTabs = () => inWorker(() => chrome.tabs.query({}));
const storedNodes = async () => (await inWorker(() => chrome.storage.session.get('tree'))).tree?.nodes ?? {};
const storedLeaving = async () => (await inWorker(() => chrome.storage.session.get('tree'))).tree?.leaving ?? null;
/** [parent, collapsed] of each tab of `ids` in the saved snapshot, what a reload or a restart rebuilds the tree from. */
async function savedNodes(ids) {
  const { snapshot } = await inWorker(() => chrome.storage.local.get('snapshot'));
  const saved = new Map((snapshot?.windows ?? []).flatMap((w) => w.tabs).map((t) => [t.id, [t.parent, t.collapsed]]));
  return ids.map((id) => saved.get(id) ?? null);
}
// Pages can take a while to load on a busy machine.
const idOf = (title) => waitFor(async () => (await allTabs()).find((t) => t.title === title)?.id, `tab ${title}`, 30000);

/** { title: parent title or null } for the test pages, from the worker's stored tree. */
async function storedParents() {
  const [tabs, nodes] = await Promise.all([allTabs(), storedNodes()]);
  const titles = new Map(tabs.map((t) => [t.id, t.title]));
  const parents = {};
  for (const tab of tabs.filter((t) => isTestPage(t.title))) {
    const parent = nodes[tab.id]?.parent ?? null;
    parents[tab.title] = parent == null ? null : titles.get(parent) ?? `#${parent}`;
  }
  return parents;
}

/** { title: colour } of the tabs that have a tree colour: remembered ones in (), handed-down ones in []. */
async function storedColors() {
  const [tabs, nodes] = await Promise.all([allTabs(), storedNodes()]);
  const colors = {};
  for (const tab of tabs) {
    const node = nodes[tab.id];
    if (node?.color) colors[tab.title] = node.color;
    else if (node?.lastColor) colors[tab.title] = `(${node.lastColor})`;
    else if (node?.heir) colors[tab.title] = `[${node.heir}]`;
  }
  return colors;
}

/** Every normal window's tab groups: [title, colour, collapsed, [the titles of its tabs]], by the first tab's title. */
async function allGroups() {
  return (await inWorker(async () => {
    const [groups, tabs] = await Promise.all([chrome.tabGroups.query({}), chrome.tabs.query({ windowType: 'normal' })]);
    tabs.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    return groups.map((group) => [group.title, group.color, group.collapsed, tabs.filter((t) => t.groupId === group.id).map((t) => t.title)]);
  })).sort((a, b) => (a[3][0] ?? '').localeCompare(b[3][0] ?? ''));
}

/**
 * allGroups() once every group has its look from the worker (a new group shows the browser's for a moment): two reads
 * 1.3 s apart the same, every group named. After 10 s, the last read.
 */
async function settledGroups() {
  let last = JSON.stringify(await allGroups());
  for (const end = Date.now() + 10000; Date.now() < end;) {
    await sleep(1300);
    const now = JSON.stringify(await allGroups());
    if (now === last && JSON.parse(now).every(([title]) => title !== '')) return JSON.parse(now);
    last = now;
  }
  return JSON.parse(last);
}

async function nativeOrder(windowId) {
  const tabs = await inWorker((w) => chrome.tabs.query({ windowId: w }), windowId);
  return tabs.sort((a, b) => a.index - b.index).map((t) => t.title).filter(isTestPage);
}

async function panelRows(panel) {
  const rows = await panel.$$eval('#tree .row', (els) => els.map((el) => ({
    title: el.querySelector('.title').textContent,
    level: Number(el.getAttribute('aria-level')),
    collapsed: el.classList.contains('collapsed'),
    count: el.querySelector('.count').textContent,
  })));
  return rows.filter((row) => isTestPage(row.title));
}

/** { title: parent title or null } read back from the panel's row levels. */
async function panelParents(panel) {
  const parents = {};
  const path = [];
  for (const row of await panelRows(panel)) {
    path.length = row.level - 1;
    parents[row.title] = path.at(-1) ?? null;
    path.push(row.title);
  }
  return parents;
}

/** The stored tree once the worker's writes are done: two reads 300 ms apart are the same. */
async function settledTree() {
  const read = async () => JSON.stringify((await inWorker(() => chrome.storage.session.get('tree'))).tree);
  let last = await read();
  for (;;) {
    await sleep(300);
    const now = await read();
    if (now === last) return JSON.parse(last);
    last = now;
  }
}

/**
 * The panel leaves out the tabs `ids` while the stored tree says that they are leaving for window
 * `to` (null: one not made yet), and draws them again once it no longer says so. Written here once
 * the worker's own writes are done.
 */
async function leavesOut(panel, ids, to, what) {
  const stored = await settledTree();
  const rows = async () => Promise.all(ids.map(async (id) => !!(await panel.$(`#tab-${id}`))));
  const all = (shown) => ids.map(() => shown);
  assert.deepEqual(await rows(), all(true), what);
  await inWorker((tree, tabs, w) => chrome.storage.session.set({ tree: { ...tree, leaving: { tabs, windowId: w } } }), stored, ids, to);
  await eventually(rows, all(false), `${what} while the stored tree says it is leaving`);
  await inWorker((tree) => chrome.storage.session.set({ tree }), stored);
  await eventually(rows, all(true), `${what} once the stored tree no longer says so`);
}

/**
 * The next read of every window's tabs by the worker itself (not by this script) waits until
 * letColorPassGo: the colour pass's (see scheduleColors), as it would while tabs keep changing.
 */
async function holdColorPass() {
  await inWorker(() => {
    const query = chrome.tabs.query;
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    globalThis.heldRead = { held: false, release, restore: () => { chrome.tabs.query = query; } };
    chrome.tabs.query = (info, ...rest) => {
      if (Object.keys(info ?? {}).length || !/\/background\.js:/.test(new Error().stack)) return query.call(chrome.tabs, info, ...rest);
      chrome.tabs.query = query;
      globalThis.heldRead.held = true;
      return released.then(() => query.call(chrome.tabs, info, ...rest));
    };
  });
}

async function letColorPassGo() {
  await inWorker(() => {
    globalThis.heldRead?.restore();
    globalThis.heldRead?.release();
  });
}

const colorIn = (page, id) => page.$eval(`#tab-${id}`, (el) => el.dataset.color ?? null).catch(() => null);

/**
 * Record the colour that each panel of `watched` ([panel, tab id] pairs, one tab per panel) draws
 * its tab in, each time it changes. Returns a function that reads the records.
 */
async function watchColors(watched) {
  for (const [page, id] of watched) {
    await page.evaluate((id) => {
      globalThis.drawn = [];
      const note = () => {
        const color = document.getElementById(`tab-${id}`)?.dataset.color ?? null;
        if (globalThis.drawn.at(-1) !== color) globalThis.drawn.push(color);
      };
      note();
      new MutationObserver(note).observe(document.getElementById('tree'), { subtree: true, childList: true, attributes: true });
    }, id);
  }
  return () => Promise.all(watched.map(([page]) => page.evaluate(() => globalThis.drawn)));
}

/** `parents` without the titles not in `present`, their children moved up to the nearest present ancestor. */
function withoutMissing(parents, present) {
  const result = {};
  for (const title of Object.keys(parents).filter((t) => present.has(t))) {
    let parent = parents[title];
    while (parent != null && !present.has(parent)) parent = parents[parent] ?? null;
    result[title] = parent;
  }
  return result;
}

/** Fire an HTML drag from one row onto another row (or, with targetId null, the empty area). */
async function dragInPanel(panel, sourceId, targetId, fraction, { ctrl = false } = {}) {
  await panel.evaluate((source, target, y, ctrlKey) => {
    const from = document.getElementById(`tab-${source}`);
    const to = document.getElementById(target == null ? 'scroller' : `tab-${target}`);
    const dataTransfer = new DataTransfer();
    const rect = to.getBoundingClientRect();
    const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height * y };
    const fire = (el, type, extra = {}) =>
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, ...extra }));
    fire(from, 'dragstart', { ctrlKey });
    fire(to, 'dragover', point);
    fire(to, 'drop', point);
    fire(from, 'dragend');
  }, sourceId, targetId, fraction, ctrl);
}

let windowId;
let panel;

try {
  await step('tabs opened from a page become its children, however they are opened', async () => {
    const a = await browser.newPage();
    await a.goto(`${base}/?name=A`);
    await a.click('#l1'); // target=_blank: opens in the foreground
    await idOf('A.1');
    await a.bringToFront();
    await a.click('#l2', { button: 'middle' });
    await a.keyboard.down('Control');
    await a.click('#l3');
    await a.keyboard.up('Control');
    await a.click('#open'); // window.open()
    await Promise.all(['A.2', 'A.3', 'A.js'].map(idOf));

    const a1 = await pageNamed(browser, base, 'A.1');
    await a1.bringToFront();
    await a1.click('#l1', { button: 'middle' });
    await a1.click('#l2', { button: 'middle' });
    await Promise.all(['A.1.1', 'A.1.2'].map(idOf));

    await eventually(storedParents, {
      A: null, 'A.1': 'A', 'A.1.1': 'A.1', 'A.1.2': 'A.1', 'A.2': 'A', 'A.3': 'A', 'A.js': 'A',
    }, 'stored tree');
  });

  await step('a new tab that was not opened from a link stays top-level', async () => {
    // Like Ctrl+T or the New Tab button, which Chrome gives the active tab as "opener".
    await (await pageNamed(browser, base, 'A.1')).bringToFront();
    const page = await browser.newPage();
    await page.goto(`${base}/?name=B`);
    const id = await idOf('B');
    await sleep(300);
    assert.equal((await storedNodes())[id]?.parent, null);
    await page.close();
  });

  windowId = (await inWorker(() => chrome.tabs.query({ title: 'A' })))[0].windowId;
  panel = collectErrors(await openPanel(browser, worker, extensionId, windowId), 'panel');

  await step('the panel draws the same tree', async () => {
    await eventually(() => panelParents(panel), {
      A: null, 'A.1': 'A', 'A.1.1': 'A.1', 'A.1.2': 'A.1', 'A.2': 'A', 'A.3': 'A', 'A.js': 'A',
    }, 'panel tree');
  });

  /** A row's tree colour, its own shade, the shades of its guide lines, and whether chip and count show it. */
  const paintOf = async (title) => panel.$eval(`#tab-${await idOf(title)}`, (el) => {
    const probe = document.body.appendChild(document.createElement('i'));
    probe.style.color = el.style.getPropertyValue('--own') || 'transparent';
    const own = getComputedStyle(probe).color;
    probe.remove();
    const filled = (selector) => getComputedStyle(el.querySelector(selector)).backgroundColor === own;
    return {
      color: el.dataset.color ?? null,
      own: el.style.getPropertyValue('--own'),
      lines: [...el.style.getPropertyValue('--lines').matchAll(/--tree-[a-z]+-\d/g)].map((m) => m[0]),
      chip: el.classList.contains('parent') ? filled('.twisty') : null,
      count: el.classList.contains('collapsed') ? filled('.count') : null,
    };
  });

  await step('a tree is drawn in its colour, and a subtree in the next shade of it', async () => {
    await eventually(async () => (await storedColors()).A, 'blue', 'stored colour of A'); // a fresh profile's first tree
    await eventually(() => paintOf('A'), { color: 'blue', own: 'var(--tree-blue-0)', lines: [], chip: true, count: null }, 'A');
    await eventually(() => paintOf('A.1'), { color: 'blue', own: 'var(--tree-blue-1)', lines: ['--tree-blue-0'], chip: true, count: null }, 'A.1');
    await eventually(() => paintOf('A.1.1'), { color: 'blue', own: 'var(--tree-blue-2)', lines: ['--tree-blue-0', '--tree-blue-1'], chip: null, count: null }, 'A.1.1');
  });

  await step('a new tree takes a colour no other tree has; closing its top tab passes the colour on', async () => {
    // In A's window: colours are per window (browser.newPage() would open in the panel's).
    await inWorker((w, url) => chrome.tabs.create({ windowId: w, url }), windowId, `${base}/?name=K`);
    const k = await pageNamed(browser, base, 'K');
    await k.bringToFront();
    await k.click('#l1', { button: 'middle' });
    const k1 = await pageNamed(browser, base, 'K.1');
    await k1.bringToFront();
    await k1.click('#l1', { button: 'middle' });
    await idOf('K.1.1');
    await eventually(async () => (await storedColors()).K, 'orange', 'colour of the K tree');
    await k.close();
    await eventually(async () => (await storedColors())['K.1'], 'orange', 'colour of K.1 after K closed');
    await eventually(async () => (await paintOf('K.1')).own, 'var(--tree-orange-0)', 'K.1 row');
  });

  await step('the tree colour can be picked from the right-click menu', async () => {
    await panel.click(`#tab-${await idOf('K.1.1')} .title`, { button: 'right' });
    await panel.click('#menu .swatch[aria-label="Green"]');
    await eventually(async () => (await storedColors())['K.1'], 'green', 'colour of K.1');
    await eventually(() => paintOf('K.1.1'), { color: 'green', own: 'var(--tree-green-1)', lines: ['--tree-green-0'], chip: null, count: null }, 'K.1.1 row');
    await inWorker(async () => chrome.tabs.remove((await chrome.tabs.query({})).filter((t) => /^K(\.|$)/.test(t.title)).map((t) => t.id)));
  });

  await step('navigating inside a tab keeps its place', async () => {
    const a2 = await pageNamed(browser, base, 'A.2');
    await a2.bringToFront();
    await Promise.all([a2.waitForNavigation(), a2.click('#same')]);
    await eventually(storedParents, {
      A: null, 'A.1': 'A', 'A.1.1': 'A.1', 'A.1.2': 'A.1', 'A.2.same': 'A', 'A.3': 'A', 'A.js': 'A',
    }, 'stored tree');
  });

  await step('collapsing hides the subtree, shows its size and activates the collapsed tab', async () => {
    const idA = await idOf('A');
    await panel.click(`#tab-${idA} .twisty`);
    await eventually(
      async () => (await panelRows(panel)).map((r) => [r.title, r.collapsed, r.count]),
      [['A', true, '6']],
      'collapsed rows',
    );
    const [active] = await inWorker((w) => chrome.tabs.query({ windowId: w, active: true }), windowId);
    assert.equal(active.title, 'A');
    assert.deepEqual(await paintOf('A'), { color: 'blue', own: 'var(--tree-blue-0)', lines: [], chip: true, count: true });
  });

  await step('activating a hidden tab expands its ancestors', async () => {
    const id = await idOf('A.1.1');
    await inWorker((i) => chrome.tabs.update(i, { active: true }), id);
    await eventually(async () => (await panelRows(panel)).length, 7, 'visible rows');
    // The keyboard focus follows it, even when the panel draws it before the worker has expanded the trees above it.
    const focus = () => panel.$eval('#tree', (el) => [Number(el.querySelector('.row.focused')?.dataset.id), el.getAttribute('aria-activedescendant')]);
    await eventually(focus, [id, `tab-${id}`], 'the keyboard focus on A.1.1');
  });

  await step('closing a parent with a middle click moves its children up', async () => {
    await panel.click(`#tab-${await idOf('A.1')} .title`, { button: 'middle' });
    const expected = { A: null, 'A.1.1': 'A', 'A.1.2': 'A', 'A.2.same': 'A', 'A.3': 'A', 'A.js': 'A' };
    await eventually(storedParents, expected, 'stored tree');
    await eventually(() => panelParents(panel), expected, 'panel tree');
  });

  await step('dropping a tab onto another nests it and moves the real tab after it', async () => {
    await dragInPanel(panel, await idOf('A.js'), await idOf('A.3'), 0.5);
    await eventually(storedParents, {
      A: null, 'A.1.1': 'A', 'A.1.2': 'A', 'A.2.same': 'A', 'A.3': 'A', 'A.js': 'A.3',
    }, 'stored tree');
    await eventually(async () => {
      const order = await nativeOrder(windowId);
      return order[order.indexOf('A.3') + 1];
    }, 'A.js', 'tab after A.3');
  });

  await step('dropping on the top edge of a tab puts the whole subtree before it', async () => {
    await dragInPanel(panel, await idOf('A.3'), await idOf('A'), 0.1);
    const expected = { 'A.3': null, 'A.js': 'A.3', A: null, 'A.1.1': 'A', 'A.1.2': 'A', 'A.2.same': 'A' };
    await eventually(storedParents, expected, 'stored tree');
    await eventually(async () => (await nativeOrder(windowId)).slice(0, 3), ['A.3', 'A.js', 'A'], 'native order');
    await eventually(() => panelParents(panel), expected, 'panel tree');
    // A.3 heads a tree of its own now: it gets a colour no tree has, and A keeps blue.
    await eventually(async () => { const c = await storedColors(); return [c['A.3'], c.A]; }, ['orange', 'blue'], 'colours');
  });

  await step('dropping below the list moves a tab to the end, at the top level', async () => {
    await dragInPanel(panel, await idOf('A.1.2'), null, 0.98);
    await eventually(async () => (await storedParents())['A.1.2'], null, 'parent of A.1.2');
    await eventually(async () => (await nativeOrder(windowId)).at(-1), 'A.1.2', 'last tab');
  });

  await step('"New tab as child" from the context menu opens a child tab', async () => {
    const parentId = await idOf('A.2.same');
    const known = new Set((await allTabs()).map((t) => t.id));
    await panel.click(`#tab-${parentId} .title`, { button: 'right' });
    await panel.click('#menu button::-p-text(New tab as child)');
    const child = await waitFor(async () => (await allTabs()).find((t) => !known.has(t.id)), 'the new tab');
    await eventually(async () => (await storedNodes())[child.id]?.parent, parentId, 'parent of the new tab');
    await inWorker((id) => chrome.tabs.remove(id), child.id);
  });

  await step('"Duplicate" puts the copy next to the original, after its subtree', async () => {
    const original = await idOf('A.3'); // top-level, with child A.js
    const known = new Set((await allTabs()).map((t) => t.id));
    await panel.click(`#tab-${original} .title`, { button: 'right' });
    await panel.click('#menu button::-p-text(Duplicate)');
    const copy = await waitFor(async () => (await allTabs()).find((t) => !known.has(t.id)), 'the copy');
    await eventually(async () => (await storedNodes())[copy.id]?.parent ?? null, null, 'parent of the copy');
    const childId = await idOf('A.js');
    await eventually(async () => {
      const ids = (await inWorker((w) => chrome.tabs.query({ windowId: w }), windowId))
        .sort((a, b) => a.index - b.index).map((t) => t.id);
      return ids[ids.indexOf(childId) + 1];
    }, copy.id, 'tab after the original subtree');
    await inWorker((id) => chrome.tabs.remove(id), copy.id);
  });

  await step('keyboard focus stays in place when the focused tab closes', async () => {
    // G heads G.1 and G.2 and stays the active tab. ↓ to G.1, then the Menu key and Close tab.
    await inWorker((w, url) => chrome.tabs.create({ windowId: w, url }), windowId, `${base}/?name=G`);
    const g = await pageNamed(browser, base, 'G');
    await g.bringToFront();
    await g.click('#l1', { button: 'middle' });
    await g.click('#l2', { button: 'middle' });
    const [idG1, idG2] = [await idOf('G.1'), await idOf('G.2')];
    const rowIds = () => panel.$$eval('#tree .row', (els) => els.map((el) => Number(el.dataset.id)));
    await waitFor(async () => {
      const ids = await rowIds();
      return ids.includes(idG1) && ids.indexOf(idG2) === ids.indexOf(idG1) + 1;
    }, 'the rows of G.1 and G.2');
    const focused = () => panel.$eval('#tree', (el) => [Number(el.querySelector('.row.focused')?.dataset.id), el.getAttribute('aria-activedescendant')]);
    // A redraw between the arrow keys and the close notes where the focused row is, and then the
    // check cannot tell; the keys themselves (Home, the arrows, Escape) do not redraw. So every
    // attempt first redraws with the focus on the first row (the panel redraws on resize), then
    // waits until the panel has not redrawn for a while (every redraw sets aria-activedescendant
    // here), and goes again should it redraw on G.1 before the close. The panel also redraws by
    // itself, as 250 ms after it held back a new tab that had no node yet (NEW_TAB_GRACE_MS).
    await panel.evaluate(() => {
      globalThis.redrawn = [];
      new MutationObserver((records) => {
        for (const record of records) globalThis.redrawn.push(record.target.getAttribute('aria-activedescendant'));
      }).observe(document.getElementById('tree'), { attributeFilter: ['aria-activedescendant'] });
    });
    const redraws = () => panel.evaluate(() => globalThis.redrawn.length);
    const quiet = async () => {
      for (let last = await redraws(), now, k = 0; k < 25; k++, last = now) {
        await sleep(400);
        if ((now = await redraws()) === last) return;
      }
    };
    const onG1Since = (mark) => panel.evaluate((m, row) => globalThis.redrawn.slice(m).filter((v) => v === row).length, mark, `tab-${idG1}`);
    await panel.bringToFront();
    await panel.focus('#tree');
    let mark;
    for (let attempt = 1; ; attempt++) {
      await panel.keyboard.press('Home');
      await panel.evaluate(() => dispatchEvent(new Event('resize'))); // a redraw with the focus on the first row
      await quiet();
      await panel.keyboard.press('Home');
      for (let i = (await rowIds()).indexOf(idG1); i > 1; i--) await panel.keyboard.press('ArrowDown');
      mark = await redraws();
      await panel.keyboard.press('ArrowDown'); // onto G.1: one record, from setFocus
      assert.deepEqual(await focused(), [idG1, `tab-${idG1}`], 'focus on G.1');
      await panel.keyboard.press('ContextMenu');
      await panel.waitForSelector('#menu:not([hidden])');
      await panel.keyboard.press('End');
      if ((await onG1Since(mark)) === 1 || attempt === 5) break;
      await panel.keyboard.press('Escape'); // redrawn meanwhile: again
    }
    await panel.keyboard.press('Enter');
    await eventually(focused, [idG2, `tab-${idG2}`], 'focus once G.1 has closed: on G.2, which took its place');
    if ((await onG1Since(mark)) !== 1) console.log('     (redrawn between the arrow keys and the close: this run could not tell)');
    await inWorker(async () => chrome.tabs.remove((await chrome.tabs.query({})).filter((t) => /^G(\.|$)/.test(t.title)).map((t) => t.id)));
  });

  await step('a pinned tab leaves the tree and its children step up until it is unpinned', async () => {
    const idA = await idOf('A');
    await inWorker((id) => chrome.tabs.update(id, { pinned: true }), idA);
    await waitFor(() => panel.$(`#pinned .pin[data-id="${idA}"]`), 'the pinned icon');
    await eventually(async () => (await panelParents(panel))['A.2.same'], null, 'A.2.same while A is pinned');
    await inWorker((id) => chrome.tabs.update(id, { pinned: false }), idA);
    await eventually(async () => (await panelParents(panel))['A.2.same'], 'A', 'A.2.same after unpinning');
    await eventually(async () => (await storedColors()).A, 'blue', 'colour of A after unpinning');
  });

  const sendFromPanel = (message) => panel.evaluate((m) => chrome.runtime.sendMessage(m), message);
  const windowOf = async (title) => (await allTabs()).find((t) => t.title === title)?.windowId;

  await step('a subtree can be moved into another window, under a tab there', async () => {
    const other = await inWorker(async (url) => (await chrome.windows.create({ url })).id, `${base}/?name=C`);
    await sendFromPanel({ type: 'move', tabId: await idOf('A.3'), windowId: other, targetId: await idOf('C'), position: 'lastChild' });
    await eventually(storedParents, {
      'A.3': 'C', 'A.js': 'A.3', A: null, 'A.1.1': 'A', 'A.2.same': 'A', 'A.1.2': null,
    }, 'stored tree');
    assert.deepEqual([await windowOf('A.3'), await windowOf('A.js')], [other, other]);
    // C heads a tree there, in that window's first colour; A.3 remembers its own.
    await eventually(async () => { const c = await storedColors(); return [c.C, c['A.3']]; }, ['blue', '(orange)'], 'colours');
  });

  await step('a tree moved to another window keeps its colour there, unless a tree there has it', async () => {
    const other = await windowOf('C'); // C's tree is blue
    // Two blue trees in A's window and a purple one: the panel moves D, a drag in the tab strip
    // moves E and F.
    for (const [name, color] of [['D', 'blue'], ['E', 'blue'], ['F', 'purple']]) {
      await inWorker((w, url) => chrome.tabs.create({ windowId: w, url }), windowId, `${base}/?name=${name}`);
      const page = await pageNamed(browser, base, name);
      await page.bringToFront();
      await page.click('#l1', { button: 'middle' });
      await idOf(`${name}.1`);
      await sendFromPanel({ type: 'setTreeColor', tabId: await idOf(name), color });
      await eventually(async () => (await storedColors())[name], color, `colour of ${name}`);
    }
    const [idD, idD1] = [await idOf('D'), await idOf('D.1')];
    await leavesOut(panel, [idD, idD1], other, 'D in A\'s panel');
    // The worker settles D's colour for C's window before it moves the tabs, and says until they
    // are there that they are leaving A's window; it moves them straight to their place (see moveTree).
    const arrival = await panel.evaluate(async (message) => {
      const { tree } = await chrome.storage.session.get('tree');
      let node = tree?.nodes?.[message.tabId];
      let arrived = false;
      const markers = []; // what each write says, from the first that changes D until D arrives
      chrome.storage.session.onChanged.addListener((changes) => {
        const now = changes.tree?.newValue;
        if (!now || arrived) return;
        const next = now.nodes?.[message.tabId];
        if (markers.length || JSON.stringify(next) !== JSON.stringify(node)) markers.push(now.leaving ?? null);
        node = next;
      });
      const attached = new Promise((resolve) => {
        chrome.tabs.onAttached.addListener(function listener(tabId, info) {
          if (tabId !== message.tabId) return;
          arrived = true;
          chrome.tabs.onAttached.removeListener(listener);
          resolve({ color: node?.color ?? null, markers, index: info.newPosition });
        });
      });
      await chrome.runtime.sendMessage(message);
      return attached;
    }, { type: 'move', tabId: idD, windowId: other, targetId: await idOf('C'), position: 'before' });
    assert.ok(arrival.color && arrival.color !== 'blue', `D's colour when its tabs arrive: ${arrival.color}`);
    const marker = { tabs: [idD, idD1], windowId: other };
    assert.ok(arrival.markers.length > 0, 'a write that moves D before it arrives');
    assert.deepEqual(arrival.markers, arrival.markers.map(() => marker), 'what every write says until D arrives');
    assert.equal(arrival.index, 0, 'where D arrives: before C');
    await eventually(storedLeaving, null, 'the stored tree once D has arrived');
    await inWorker(async (w) => {
      const ids = (await chrome.tabs.query({})).filter((t) => /^[EF](\.|$)/.test(t.title)).map((t) => t.id);
      await chrome.tabs.move(ids, { windowId: w, index: -1 });
    }, other);
    const colorThere = async (name) => ((await windowOf(name)) === other ? (await storedColors())[name] : 'not moved');
    await eventually(async () => {
      const colors = [await colorThere('D'), await colorThere('E')];
      return [...colors.map((c) => (/^[a-z]+$/.test(c ?? '') && c !== 'blue' ? 'a new one' : c)), await colorThere('F')];
    }, ['a new one', 'a new one', 'purple'], 'colours of D, E and F in C\'s window');
    await inWorker(async () => chrome.tabs.remove((await chrome.tabs.query({})).filter((t) => /^[DEF](\.|$)/.test(t.title)).map((t) => t.id)));
  });

  await step('"Move tree to new window" keeps the tree together, in its colour', async () => {
    // Not the colour that the first tree of a window gets anyway.
    await sendFromPanel({ type: 'setTreeColor', tabId: await idOf('A'), color: 'purple' });
    await eventually(async () => (await storedColors()).A, 'purple', 'colour of A');
    const ids = await Promise.all(['A', 'A.1.1', 'A.2.same'].map(idOf));
    await leavesOut(panel, ids, null, 'A\'s tree in its panel');
    // The worker says that the tree is leaving, for a window not made yet, before its top tab goes,
    // and so does every write until the rest is there. The rest follows a moment later here, so
    // that the writes in between show.
    await inWorker(() => {
      const move = chrome.tabs.move;
      chrome.tabs.move = async (...args) => {
        chrome.tabs.move = move;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return move.apply(chrome.tabs, args);
      };
    });
    const { markers, early } = await panel.evaluate(async (message, ids) => {
      const coming = new Set(ids);
      const markers = []; // what each write says, from the first that says the tree is leaving until all of it has arrived
      let left = false;
      let early = false; // whether that first write came before the top tab left
      chrome.tabs.onDetached.addListener((tabId) => { if (tabId === message.tabId) left = true; });
      chrome.storage.session.onChanged.addListener((changes) => {
        const now = changes.tree?.newValue;
        if (!now || !coming.size || !(markers.length || now.leaving)) return;
        if (!markers.length) early = !left;
        markers.push(now.leaving ?? null);
      });
      chrome.tabs.onAttached.addListener((tabId) => coming.delete(tabId));
      await chrome.runtime.sendMessage(message);
      // The worker may answer before the rest is there: record until it is (at most 10 s).
      for (const start = Date.now(); coming.size && Date.now() - start < 10000;) await new Promise((resolve) => setTimeout(resolve, 50));
      return { markers, early };
    }, { type: 'moveToNewWindow', tabId: ids[0] }, ids);
    const sorted = (list) => [...(list ?? [])].sort((x, y) => x - y);
    assert.deepEqual(markers.slice(0, 1).map((m) => ({ ...m, tabs: sorted(m.tabs) })), [{ tabs: sorted(ids), windowId: null }], 'the first write that says A\'s tree is leaving');
    assert.ok(early, 'the first write that says A\'s tree is leaving comes before A leaves');
    assert.ok(markers.every((m) => isDeepStrictEqual(sorted(m?.tabs), sorted(ids))), `what every write says until A's tree has arrived: ${JSON.stringify(markers)}`);
    await eventually(async () => new Set(await Promise.all(['A', 'A.1.1', 'A.2.same'].map(windowOf))).size, 1, 'one window');
    await eventually(storedLeaving, null, 'the stored tree once A\'s tree is there');
    assert.notEqual(await windowOf('A'), windowId);
    assert.deepEqual(
      Object.fromEntries(Object.entries(await storedParents()).filter(([title]) => ['A', 'A.1.1', 'A.2.same'].includes(title))),
      { A: null, 'A.1.1': 'A', 'A.2.same': 'A' },
    );
    await eventually(async () => (await storedColors()).A, 'purple', 'colour of A in its new window');
  });

  await step('"Move tree to new window" before a colour pass: the tree keeps its colour, and so do trees elsewhere', async () => {
    // In a window of their own: R(R.1), blue, then Q(Q.1) and P(P.1 P.2), drawn orange and pink. P.2
    // is dragged to a second window and opens P.2.1 there: a tree drawn blue. No colour pass stores
    // theirs before Q's tree goes to a new window: the pass's read of every window's tabs (see
    // scheduleColors) waits here until then, as it would while tabs keep changing. So the move
    // stores them, for Q's tree to keep its orange, and does so before it says that Q's tree is
    // leaving, for P's to keep its pink while its panel leaves Q's out; and storing P's pink alone
    // would have P.2's tree take it on in the second window (see inheritedColor).
    const first = await inWorker(async (url) => (await chrome.windows.create({ url })).id, `${base}/?name=R`);
    const second = await inWorker(async (url) => (await chrome.windows.create({ url })).id, `${base}/?name=X`);
    const r = await pageNamed(browser, base, 'R');
    await r.bringToFront();
    await r.click('#l1', { button: 'middle' });
    await idOf('R.1');
    await eventually(async () => (await storedColors()).R, 'blue', 'colour of R');
    for (const name of ['Q', 'P']) await inWorker((w, url) => chrome.tabs.create({ windowId: w, url }), first, `${base}/?name=${name}`);
    const [q, p] = [await pageNamed(browser, base, 'Q'), await pageNamed(browser, base, 'P')];
    const panels = [];
    try {
      const here = collectErrors(await openPanel(browser, worker, extensionId, first), 'panel of R\'s window');
      panels.push(here);
      const there = collectErrors(await openPanel(browser, worker, extensionId, second), 'panel of X\'s window');
      panels.push(there);
      await settledTree();
      await holdColorPass();
      await q.bringToFront();
      await q.click('#l1', { button: 'middle' });
      await p.bringToFront();
      await p.click('#l1', { button: 'middle' });
      await p.click('#l2', { button: 'middle' });
      const [idQ, idQ1, idP, idP1, idP2] = await Promise.all(['Q', 'Q.1', 'P', 'P.1', 'P.2'].map(idOf));
      await inWorker((id, w) => chrome.tabs.move(id, { windowId: w, index: -1 }), idP2, second);
      const p2 = await pageNamed(browser, base, 'P.2');
      await p2.bringToFront();
      await p2.click('#l1', { button: 'middle' });
      const idP21 = await idOf('P.2.1');
      await eventually(async () => {
        const nodes = await storedNodes();
        return [idQ1, idP1, idP2, idP21].map((id) => nodes[id]?.parent);
      }, [idQ, idP, idP, idP2], 'Q.1, P.1, P.2 and P.2.1 in the stored tree');
      await eventually(() => inWorker(() => globalThis.heldRead.held), true, 'the colour pass waits');
      await eventually(async () => [await colorIn(here, idQ), await colorIn(here, idP), await colorIn(there, idP2)], ['orange', 'pink', 'blue'], 'Q, P and P.2 as their panels draw them');
      assert.deepEqual(await storedColors().then((c) => [c.Q, c.P, c['P.2']]), [undefined, undefined, undefined], 'their colours, not stored yet');
      // P's colour in its window's panel and P.2's in X's, each time it changes.
      const drawn = await watchColors([[here, idP], [there, idP2]]);
      await sendFromPanel({ type: 'moveToNewWindow', tabId: idQ });
      await eventually(async () => {
        const [w, w1] = [await windowOf('Q'), await windowOf('Q.1')];
        return w !== first && w === w1;
      }, true, 'Q\'s tree in a new window');
      await eventually(storedLeaving, null, 'the stored tree once Q\'s tree is there');
      await sleep(300); // for the panels to redraw
      assert.deepEqual(await drawn(), [['pink'], ['blue']], 'P and P.2 in their windows\' panels while Q\'s tree moves');
      await letColorPassGo();
      await eventually(async () => storedColors().then((c) => [c.Q, c.P, c['P.2']]), ['orange', 'pink', 'blue'], 'colours of Q, P and P.2 once stored');
      await sleep(300);
      assert.deepEqual(await drawn(), [['pink'], ['blue']], 'P and P.2 in their windows\' panels once the colours are stored');
    } finally {
      await letColorPassGo();
      for (const page of panels) await page.close();
      await inWorker(async () => chrome.tabs.remove((await chrome.tabs.query({})).filter((t) => /^[PQRX](\.|$)/.test(t.title)).map((t) => t.id)));
    }
  });

  await step('"Move tree to new window" once the colours are stored: a tree elsewhere that takes its colour from it keeps it', async () => {
    // The green tree S(S.1), stored, and S.2, opened from S by a Shift+click: in a window of its own,
    // where S.2 opens S.2.1, a tree that takes S's green (see inheritedColor). No colour pass stores
    // it before S's tree goes to a new window (see holdColorPass). There S keeps its colour (see
    // attached), so S.2's tree keeps it too.
    await inWorker((w, url) => chrome.tabs.create({ windowId: w, url }), windowId, `${base}/?name=S`);
    const s = await pageNamed(browser, base, 'S');
    await s.bringToFront();
    await s.click('#l1', { button: 'middle' });
    await idOf('S.1');
    const idS = await idOf('S');
    await sendFromPanel({ type: 'setTreeColor', tabId: idS, color: 'green' });
    await eventually(async () => (await storedColors()).S, 'green', 'colour of S');
    await s.keyboard.down('Shift');
    await s.click('#l2');
    await s.keyboard.up('Shift');
    const idS2 = await idOf('S.2');
    const third = await windowOf('S.2');
    assert.notEqual(third, windowId, 'S.2 in a window of its own');
    await eventually(async () => (await storedNodes())[idS2]?.parent, idS, 'S.2\'s parent');
    const panels = [];
    try {
      const there = collectErrors(await openPanel(browser, worker, extensionId, third), 'panel of S.2\'s window');
      panels.push(there);
      await settledTree();
      await holdColorPass();
      const s2 = await pageNamed(browser, base, 'S.2');
      await s2.bringToFront();
      await s2.click('#l1', { button: 'middle' });
      const idS21 = await idOf('S.2.1');
      await eventually(async () => (await storedNodes())[idS21]?.parent, idS2, 'S.2.1 in the stored tree');
      await eventually(() => inWorker(() => globalThis.heldRead.held), true, 'the colour pass waits');
      await eventually(() => colorIn(there, idS2), 'green', 'S.2 as its panel draws it');
      assert.equal((await storedColors())['S.2'], undefined, 'its colour, not stored yet');
      const drawn = await watchColors([[there, idS2]]);
      await sendFromPanel({ type: 'moveToNewWindow', tabId: idS });
      await eventually(async () => {
        const [w, w1] = [await windowOf('S'), await windowOf('S.1')];
        return w !== windowId && w === w1;
      }, true, 'S\'s tree in a new window');
      await eventually(storedLeaving, null, 'the stored tree once S\'s tree is there');
      await sleep(300); // for the panel to redraw
      assert.deepEqual(await drawn(), [['green']], 'S.2 in its window\'s panel while S\'s tree moves');
      await letColorPassGo();
      await eventually(async () => storedColors().then((c) => [c.S, c['S.1'], c['S.2']]), ['green', '[green]', 'green'], 'colours of S, S.1 and S.2 once stored');
      await sleep(300);
      assert.deepEqual(await drawn(), [['green']], 'S.2 in its window\'s panel once the colours are stored');
      // Dragged on from there, S's tree claims its colour afresh, as any tree does (see attached): back
      // in the window it came from, where T(T.1) is green now, it takes another.
      await inWorker((w, url) => chrome.tabs.create({ windowId: w, url }), windowId, `${base}/?name=T`);
      const t = await pageNamed(browser, base, 'T');
      await t.bringToFront();
      await t.click('#l1', { button: 'middle' });
      await idOf('T.1');
      await sendFromPanel({ type: 'setTreeColor', tabId: await idOf('T'), color: 'green' });
      await eventually(async () => (await storedColors()).T, 'green', 'colour of T');
      await inWorker(async (w) => {
        const ids = (await chrome.tabs.query({})).filter((x) => /^S(\.1)?$/.test(x.title)).map((x) => x.id);
        await chrome.tabs.move(ids, { windowId: w, index: -1 });
      }, windowId);
      await eventually(async () => {
        const c = (await storedColors()).S;
        return (await windowOf('S')) === windowId && /^[a-z]+$/.test(c ?? '') && c !== 'green' ? 'a new one' : c;
      }, 'a new one', 'colour of S back in the window it came from, where T\'s tree has green');
    } finally {
      await letColorPassGo();
      for (const page of panels) await page.close();
      await inWorker(async () => chrome.tabs.remove((await chrome.tabs.query({})).filter((t) => /^[ST](\.|$)/.test(t.title)).map((t) => t.id)));
    }
  });

  await step('"Move tree to new window" lets go of the parent of its top tab: a tree elsewhere keeps its colour all the same', async () => {
    // U in a window of its own, and U.1, opened from it by a Shift+click, heading the tree U.1(U.1.1)
    // in another. U.1.2, opened from U.1 and dragged to U's window, hangs under U there (through U.1):
    // the blue tree U(U.1.2). V there once headed a blue tree (its colour picked by hand) and opens
    // V.2 with the colour pass held (see holdColorPass): V's tree asks for blue, which U's tree has,
    // so it is drawn orange. Once U.1's tree is in a new window, U.1 has no parent: U.1.2 hangs under
    // nothing in U's window, and U's tree is gone. So the move stores V's tree first (see
    // colorsReachOtherWindows), or it would take blue then.
    const home = await inWorker(async (url) => (await chrome.windows.create({ url })).id, `${base}/?name=U`);
    const u = await pageNamed(browser, base, 'U');
    await u.bringToFront();
    await u.keyboard.down('Shift');
    await u.click('#l1');
    await u.keyboard.up('Shift');
    const idU1 = await idOf('U.1');
    const away = await windowOf('U.1');
    assert.notEqual(away, home, 'U.1 in a window of its own');
    const u1 = await pageNamed(browser, base, 'U.1');
    await u1.bringToFront();
    await u1.click('#l1', { button: 'middle' });
    await u1.click('#l2', { button: 'middle' });
    const idU12 = await idOf('U.1.2');
    await idOf('U.1.1');
    await eventually(async () => (await storedNodes())[idU12]?.parent, idU1, 'U.1.2\'s parent');
    await inWorker((id, w) => chrome.tabs.move(id, { windowId: w, index: -1 }), idU12, home);
    await eventually(async () => (await storedColors()).U, 'blue', 'colour of U\'s tree');
    await inWorker((w, url) => chrome.tabs.create({ windowId: w, url }), home, `${base}/?name=V`);
    const v = await pageNamed(browser, base, 'V');
    await v.bringToFront();
    await v.click('#l1', { button: 'middle' });
    const idV = await idOf('V');
    const idV1 = await idOf('V.1');
    await sendFromPanel({ type: 'setTreeColor', tabId: idV, color: 'blue' });
    await eventually(async () => (await storedColors()).V, 'blue', 'colour of V');
    await inWorker((id) => chrome.tabs.remove(id), idV1);
    await eventually(async () => (await storedColors()).V, '(blue)', 'the colour V remembers');
    const panels = [];
    try {
      const there = collectErrors(await openPanel(browser, worker, extensionId, home), 'panel of U\'s window');
      panels.push(there);
      await settledTree();
      await holdColorPass();
      await v.bringToFront();
      await v.click('#l2', { button: 'middle' });
      const idV2 = await idOf('V.2');
      await eventually(async () => (await storedNodes())[idV2]?.parent, idV, 'V.2 in the stored tree');
      await eventually(() => inWorker(() => globalThis.heldRead.held), true, 'the colour pass waits');
      await eventually(async () => [await colorIn(there, await idOf('U')), await colorIn(there, idV)], ['blue', 'orange'], 'U and V as their panel draws them');
      assert.equal((await storedColors()).V, '(blue)', 'V\'s colour, not stored yet');
      const drawn = await watchColors([[there, idV]]);
      await sendFromPanel({ type: 'moveToNewWindow', tabId: idU1 });
      await eventually(async () => {
        const [w, w1] = [await windowOf('U.1'), await windowOf('U.1.1')];
        return w !== away && w === w1;
      }, true, 'U.1\'s tree in a new window');
      await eventually(storedLeaving, null, 'the stored tree once U.1\'s tree is there');
      await sleep(300); // for the panel to redraw
      assert.deepEqual(await drawn(), [['orange']], 'V in its window\'s panel while U.1\'s tree moves');
      await letColorPassGo();
      await eventually(async () => storedColors().then((c) => [c.U, c.V]), ['(blue)', 'orange'], 'colours of U and V once stored');
      await sleep(300);
      assert.deepEqual(await drawn(), [['orange']], 'V in its window\'s panel once the colours are stored');
    } finally {
      await letColorPassGo();
      for (const page of panels) await page.close();
      await inWorker(async () => chrome.tabs.remove((await chrome.tabs.query({})).filter((t) => /^[UV](\.|$)/.test(t.title)).map((t) => t.id)));
    }
  });

  await step('"Move tree to new window" once every colour is stored reads the tabs of its own window only', async () => {
    // H.1, opened from H by a Shift+click, heads H.1(H.1.1) in a window of its own, and H.1.2, opened
    // from H.1 by another Shift+click, is in a third. Moving H.1's tree lets go of H.1's parent, in
    // another window, and H.1.2 hangs from it (see colorsReachOtherWindows): with every colour
    // stored, that can change no tree elsewhere, so the worker need not read the other windows.
    // The worker's reads of the tabs: those of every window by the colour pass (see scheduleColors),
    // and those made while it moves the tree, of one window or of every window; and the colour
    // pass's timers, until they fire.
    await inWorker(() => {
      const query = chrome.tabs.query;
      const timeout = globalThis.setTimeout;
      const reads = {
        reading: 0, begun: 0, armed: 0, window: 0, every: 0,
        restore: () => { chrome.tabs.query = query; globalThis.setTimeout = timeout; },
      };
      globalThis.workerReads = reads;
      chrome.tabs.query = (info, ...rest) => {
        const stack = new Error().stack;
        const every = !Object.keys(info ?? {}).length;
        if (/\bmoveToNewWindow\b/.test(stack)) reads[every ? 'every' : 'window']++;
        else if (every && /\/background\.js:/.test(stack)) {
          reads.reading++;
          reads.begun++;
          return query.call(chrome.tabs, info, ...rest).finally(() => { reads.reading--; });
        }
        return query.call(chrome.tabs, info, ...rest);
      };
      globalThis.setTimeout = (fn, ms, ...args) => {
        if (!/\bscheduleColors\b/.test(new Error().stack)) return timeout(fn, ms, ...args);
        reads.armed++;
        return timeout(() => { reads.armed--; return fn(...args); }, ms);
      };
    });
    try {
      await inWorker((w, url) => chrome.tabs.create({ windowId: w, url }), windowId, `${base}/?name=H`);
      const h = await pageNamed(browser, base, 'H');
      await h.bringToFront();
      await h.keyboard.down('Shift');
      await h.click('#l1');
      await h.keyboard.up('Shift');
      const idH1 = await idOf('H.1');
      const own = await windowOf('H.1');
      assert.notEqual(own, windowId, 'H.1 in a window of its own');
      const h1 = await pageNamed(browser, base, 'H.1');
      await h1.bringToFront();
      await h1.click('#l1', { button: 'middle' });
      await h1.keyboard.down('Shift');
      await h1.click('#l2');
      await h1.keyboard.up('Shift');
      const [idH, idH11, idH12] = await Promise.all(['H', 'H.1.1', 'H.1.2'].map(idOf));
      assert.ok(![windowId, own].includes(await windowOf('H.1.2')), 'H.1.2 in a third window');
      await eventually(async () => {
        const nodes = await storedNodes();
        return [idH1, idH11, idH12].map((id) => nodes[id]?.parent);
      }, [idH, idH1, idH1], 'H.1, H.1.1 and H.1.2 in the stored tree');
      await eventually(async () => /^[a-z]+$/.test((await storedColors())['H.1'] ?? ''), true, 'colour of H.1\'s tree');
      // No colour pass is pending: none has its timer armed or is reading the tabs, and a request
      // answered since, with no read begun meanwhile, let the last one finish (one that found the tabs
      // changed has armed its timer again by then).
      const quiet = () => inWorker(() => {
        const reads = globalThis.workerReads;
        return reads.reading || reads.armed ? null : { begun: reads.begun };
      });
      for (;;) {
        const { begun } = await waitFor(quiet, 'no colour pass waiting or reading the tabs');
        await sendFromPanel({ type: 'ping' });
        if ((await quiet())?.begun === begun) break;
      }
      await inWorker(() => { globalThis.workerReads.window = 0; globalThis.workerReads.every = 0; });
      await sendFromPanel({ type: 'moveToNewWindow', tabId: idH1 });
      await eventually(async () => {
        const [w, w1] = [await windowOf('H.1'), await windowOf('H.1.1')];
        return w !== own && w === w1;
      }, true, 'H.1\'s tree in a new window');
      const reads = await inWorker(() => ({ window: globalThis.workerReads.window, every: globalThis.workerReads.every }));
      assert.deepEqual(reads, { window: 1, every: 0 }, 'the worker\'s reads of the tabs while H.1\'s tree moves');
    } finally {
      await inWorker(() => globalThis.workerReads?.restore());
      await inWorker(async () => {
        const ids = (await chrome.tabs.query({})).filter((t) => /^H(\.|$)/.test(t.title)).map((t) => t.id);
        if (ids.length) await chrome.tabs.remove(ids);
      });
    }
  });

  await step('"Move tree to new window" after a tab event that came in since the request: a tree elsewhere keeps its colour all the same', async () => {
    // As in the step before last, W in a window of its own and W.1, opened from it by a Shift+click,
    // heading W.1(W.1.1) in another; W.1.2, opened from W.1 and dragged to W's window, hangs under W
    // there: the blue tree W(W.1.2). There too Z(Y(Y.2)), orange: Y once headed a blue tree, then was
    // dragged under Z. Every colour is stored. The move's request waits behind another (as it does
    // while the worker starts, see init), and meanwhile Z closes: its onRemoved is handled after the
    // move, and Y(Y.2) is a tree of its own, drawn in Z's orange (Y's heir: blue is W's). So the move
    // stores every window first (see moveToNewWindow), or Y's tree would take blue once W's is gone.
    // The colour pass's reads of every window and its timers, as in the step before.
    await inWorker(() => {
      const query = chrome.tabs.query;
      const timeout = globalThis.setTimeout;
      const reads = {
        reading: 0, begun: 0, armed: 0,
        restore: () => { chrome.tabs.query = query; globalThis.setTimeout = timeout; },
      };
      globalThis.passReads = reads;
      chrome.tabs.query = (info, ...rest) => {
        const stack = new Error().stack;
        if (Object.keys(info ?? {}).length || /\bmoveToNewWindow\b/.test(stack) || !/\/background\.js:/.test(stack)) return query.call(chrome.tabs, info, ...rest);
        reads.reading++;
        reads.begun++;
        return query.call(chrome.tabs, info, ...rest).finally(() => { reads.reading--; });
      };
      globalThis.setTimeout = (fn, ms, ...args) => {
        if (!/\bscheduleColors\b/.test(new Error().stack)) return timeout(fn, ms, ...args);
        reads.armed++;
        return timeout(() => { reads.armed--; return fn(...args); }, ms);
      };
    });
    const panels = [];
    try {
      const home = await inWorker(async (url) => (await chrome.windows.create({ url })).id, `${base}/?name=W`);
      const w = await pageNamed(browser, base, 'W');
      await w.bringToFront();
      await w.keyboard.down('Shift');
      await w.click('#l1');
      await w.keyboard.up('Shift');
      const idW1 = await idOf('W.1');
      const away = await windowOf('W.1');
      assert.notEqual(away, home, 'W.1 in a window of its own');
      const w1 = await pageNamed(browser, base, 'W.1');
      await w1.bringToFront();
      await w1.click('#l1', { button: 'middle' });
      await w1.click('#l2', { button: 'middle' });
      const idW12 = await idOf('W.1.2');
      await idOf('W.1.1');
      await eventually(async () => (await storedNodes())[idW12]?.parent, idW1, 'W.1.2\'s parent');
      await inWorker((id, w) => chrome.tabs.move(id, { windowId: w, index: -1 }), idW12, home);
      await eventually(async () => (await storedColors()).W, 'blue', 'colour of W\'s tree');
      await inWorker((w, url) => chrome.tabs.create({ windowId: w, url }), home, `${base}/?name=Y`);
      const y = await pageNamed(browser, base, 'Y');
      await y.bringToFront();
      await y.click('#l1', { button: 'middle' });
      const idY = await idOf('Y');
      const idY1 = await idOf('Y.1');
      await sendFromPanel({ type: 'setTreeColor', tabId: idY, color: 'blue' });
      await eventually(async () => (await storedColors()).Y, 'blue', 'colour of Y');
      await inWorker((id) => chrome.tabs.remove(id), idY1);
      await eventually(async () => (await storedColors()).Y, '(blue)', 'the colour Y remembers');
      await inWorker((w, url) => chrome.tabs.create({ windowId: w, url }), home, `${base}/?name=Z`);
      await pageNamed(browser, base, 'Z');
      const idZ = await idOf('Z');
      await sendFromPanel({ type: 'move', tabId: idY, windowId: home, targetId: idZ, position: 'lastChild' });
      await y.bringToFront();
      await y.click('#l2', { button: 'middle' });
      const idY2 = await idOf('Y.2');
      await eventually(async () => {
        const nodes = await storedNodes();
        return [nodes[idY]?.parent, nodes[idY2]?.parent, nodes[idZ]?.color, nodes[idY]?.heir];
      }, [idZ, idY, 'orange', 'orange'], 'Z(Y(Y.2)) in the stored tree, in orange');
      const there = collectErrors(await openPanel(browser, worker, extensionId, home), 'panel of W\'s window');
      panels.push(there);
      await eventually(() => colorIn(there, idZ), 'orange', 'Z as its panel draws it');
      // No colour pass is pending, as in the step before: Y.2 and the panel's window, made just now,
      // may have left one.
      const quiet = () => inWorker(() => {
        const reads = globalThis.passReads;
        return reads.reading || reads.armed ? null : { begun: reads.begun };
      });
      for (;;) {
        const { begun } = await waitFor(quiet, 'no colour pass waiting or reading the tabs');
        await sendFromPanel({ type: 'ping' });
        if ((await quiet())?.begun === begun) break;
      }
      // The request before the move ('Make top level' on W, top-level already: it changes nothing)
      // waits for its first read of the tabs until Z has closed. Listeners added after the worker's
      // own tell when it has seen the move's request, and when it has counted Z's closing.
      await inWorker(() => {
        const get = chrome.tabs.get;
        let release;
        const released = new Promise((resolve) => { release = resolve; });
        globalThis.held = { task: false, request: false, release, restore: () => { chrome.tabs.get = get; } };
        chrome.tabs.get = (...args) => {
          if (!/\bmakeTopLevel\b/.test(new Error().stack)) return get.apply(chrome.tabs, args);
          chrome.tabs.get = get;
          globalThis.held.task = true;
          return released.then(() => get.apply(chrome.tabs, args));
        };
        chrome.runtime.onMessage.addListener(function seen(message) {
          if (message.type !== 'moveToNewWindow') return;
          chrome.runtime.onMessage.removeListener(seen);
          globalThis.held.request = true;
        });
      });
      const drawn = await watchColors([[there, idY]]);
      const idW = await idOf('W');
      const first = sendFromPanel({ type: 'makeTopLevel', tabId: idW });
      await eventually(() => inWorker(() => globalThis.held.task), true, 'the request before the move waits');
      const moved = sendFromPanel({ type: 'moveToNewWindow', tabId: idW1 });
      await eventually(() => inWorker(() => globalThis.held.request), true, 'the move\'s request has come in');
      await inWorker((id) => new Promise((resolve) => {
        chrome.tabs.onRemoved.addListener(function seen(tabId) {
          if (tabId !== id) return;
          chrome.tabs.onRemoved.removeListener(seen);
          resolve();
        });
        chrome.tabs.remove(id);
      }), idZ);
      await inWorker(() => globalThis.held.release());
      assert.deepEqual(await first, { ok: true, result: false }, 'W, top-level already');
      await moved;
      await eventually(async () => {
        const [w, w1] = [await windowOf('W.1'), await windowOf('W.1.1')];
        return w !== away && w === w1;
      }, true, 'W.1\'s tree in a new window');
      await eventually(storedLeaving, null, 'the stored tree once W.1\'s tree is there');
      await sleep(300); // for the panel to redraw
      assert.deepEqual(await drawn(), [['orange']], 'Y in its window\'s panel while W.1\'s tree moves');
      await eventually(async () => storedColors().then((c) => [c.W, c.Y]), ['(blue)', 'orange'], 'colours of W and Y once stored');
      await sleep(300);
      assert.deepEqual(await drawn(), [['orange']], 'Y in its window\'s panel once the colours are stored');
    } finally {
      await inWorker(() => {
        globalThis.held?.restore();
        globalThis.held?.release();
        globalThis.passReads?.restore();
      });
      for (const page of panels) await page.close();
      await inWorker(async () => {
        const ids = (await chrome.tabs.query({})).filter((t) => /^[WYZ](\.|$)/.test(t.title)).map((t) => t.id);
        if (ids.length) await chrome.tabs.remove(ids);
      });
    }
  });

  /**
   * A tab opened with "New tab as child" of `parent` (so `parent` opened it, as the browser sees it), then
   * navigated to the page named `name`: its id. It is the active tab.
   */
  async function newChildNamed(parent, name) {
    const known = new Set((await allTabs()).map((t) => t.id));
    await sendFromPanel({ type: 'newChild', tabId: parent });
    // In Edge the new tab can be a New Tab page made earlier and kept ready (its id is older than the parent's),
    // and Edge can load that page again (&invalidaterender=1) just after a navigation is sent to the tab, which
    // then never begins (seen right after an extension reload): navigate the new tab until it has the page. A
    // navigation under way can hide from pendingUrl for a moment, and sending the page again restarts it, which on
    // a slow machine can go on for a while (25 sends were seen once): so the page is sent at most once every 2 s.
    // One that stays pending without beginning (pendingUrl the page, for good) is sent again after 5 s.
    const url = `${base}/?name=${name}`;
    let sent = 0;
    let lastSent = 0;
    const id = await waitFor(async () => {
      const tab = (await allTabs()).find((t) => !known.has(t.id));
      if (tab?.title === name) return tab.id;
      const stuck = Date.now() - lastSent >= 5000;
      if (tab && tab.url !== url && (tab.pendingUrl !== url || stuck) && Date.now() - lastSent >= 2000) {
        sent++;
        lastSent = Date.now();
        await inWorker((i, u) => chrome.tabs.update(i, { url: u }).catch(() => null), tab.id, url); // turned down: sent again later
      }
      return null;
    }, `tab ${name}`, 30000);
    if (sent > 1) console.log(`     (the new tab for ${name} was sent its page ${sent} times)`);
    return id;
  }

  /** `top` heading `${top}.1` and `${top}.2` in the first window (see newChildNamed). Their ids; `${top}.2` is the active tab. */
  async function treeOfTwo(top) {
    await inWorker((w, url) => chrome.tabs.create({ windowId: w, url, active: true }), windowId, `${base}/?name=${top}`);
    const ids = [await idOf(top)];
    for (const name of [`${top}.1`, `${top}.2`]) ids.push(await newChildNamed(ids[0], name));
    return ids;
  }

  /**
   * A tab made with `props` (windowId, active...) for the page named `name`: its id once the page is in. tabs.create's
   * answer is not waited for (Edge was seen not to give it), and Edge can leave a new tab without its page for good:
   * the page is sent again every 5 s to the new tab that has not got it (see newChildNamed).
   */
  async function openNamed(name, props) {
    const url = `${base}/?name=${name}`;
    const known = new Set((await allTabs()).map((t) => t.id));
    await inWorker((p, u) => { chrome.tabs.create({ ...p, url: u }).catch(() => {}); }, props, url);
    let lastSent = Date.now();
    return waitFor(async () => {
      const tabs = await allTabs();
      const done = tabs.find((t) => t.title === name);
      if (done) return done.id;
      const fresh = tabs.find((t) => !known.has(t.id));
      if (fresh && Date.now() - lastSent >= 5000) {
        lastSent = Date.now();
        await inWorker((i, u) => chrome.tabs.update(i, { url: u }).catch(() => null), fresh.id, url);
      }
      return null;
    }, `tab ${name}`, 30000);
  }

  const isActive = async (id) => (await inWorker((i) => chrome.tabs.get(i), id)).active;
  const activate = (id) => inWorker((i) => chrome.tabs.update(i, { active: true }), id);

  /** Collapse `id` from the panel while the active tab is in its tree, which leaves `id` the active tab. */
  async function collapseActive(id, what) {
    await sendFromPanel({ type: 'setCollapsed', tabId: id, collapsed: true });
    await eventually(async () => [(await storedNodes())[id]?.collapsed, await isActive(id)], [true, true], `${what} collapsed, and the active tab`);
  }

  /** A drag in the tab strip to window `w`: the tab moves there and is the active tab there. */
  const dragTo = (id, w) => inWorker((i, w) => Promise.all([chrome.tabs.move(i, { windowId: w, index: -1 }), chrome.tabs.update(i, { active: true })]), id, w);

  /** [title, collapsed, count] of the rows that `page` draws for the tree of `top`, sorted. */
  const rowsOf = async (page, top) => (await page.$$eval('#tree .row', (els) => els.map((el) => [
    el.querySelector('.title').textContent, el.classList.contains('collapsed'), el.querySelector('.count').textContent,
  ]))).filter(([title]) => title === top || title.startsWith(`${top}.`)).sort();

  /** The stored tree once the worker has handled the tab events so far: they reach it before a request sent after them. */
  async function handled() {
    await sendFromPanel({ type: 'ping' });
    return settledTree();
  }

  /** Close the tabs whose titles match `pattern`. */
  const closeTabs = (pattern) => inWorker(async (source) => {
    const ids = (await chrome.tabs.query({})).filter((t) => new RegExp(source).test(t.title)).map((t) => t.id);
    if (ids.length) await chrome.tabs.remove(ids);
  }, pattern.source);

  await step('a collapsed tree stays collapsed when it moves to another window, though its top tab was the active one', async () => {
    // H heads H.1 and H.2 (see treeOfTwo) and is collapsed, which leaves it the active tab. When it leaves
    // its window, the browser makes H.1 the active tab there for a moment, until H.1 follows, and then
    // H.2. Nothing hides those there once H has gone, and by the time the worker gets to them neither is
    // active: the tree is not expanded (see reveal). H's tree goes to a new window; then J's, made the
    // same way, goes to C's window by the request that a drop below the list in that window's panel sends.
    const windowOfC = await windowOf('C');
    const moves = [
      ['H', { type: 'moveToNewWindow' }, 'a new window', (w) => w !== windowId && w !== windowOfC],
      ['J', { type: 'move', windowId: windowOfC, targetId: null, position: 'end' }, 'C\'s window', (w) => w === windowOfC],
    ];
    const panels = [];
    try {
      for (const [top, request, where, arrived] of moves) {
        const ids = await treeOfTwo(top);
        await collapseActive(ids[0], top);
        const activated = await panel.evaluate(async (message, ids) => {
          const seen = [];
          const onActivated = ({ tabId, windowId }) => seen.push([tabId, windowId]);
          chrome.tabs.onActivated.addListener(onActivated);
          const coming = new Set(ids);
          const onAttached = (tabId) => coming.delete(tabId);
          chrome.tabs.onAttached.addListener(onAttached);
          await chrome.runtime.sendMessage(message);
          for (const start = Date.now(); coming.size && Date.now() - start < 10000;) await new Promise((resolve) => setTimeout(resolve, 50));
          await chrome.runtime.sendMessage({ type: 'ping' }); // answered once the worker has handled those activations
          chrome.tabs.onActivated.removeListener(onActivated);
          chrome.tabs.onAttached.removeListener(onAttached);
          return seen;
        }, { ...request, tabId: ids[0] }, ids);
        if (!activated.some(([id, w]) => ids.includes(id) && w === windowId)) {
          console.log(`     (no tab of ${top}'s tree was active for a moment in its old window: this run could not tell)`);
        }
        const there = await windowOf(top);
        assert.ok(arrived(there), `${top} in ${where}`);
        assert.deepEqual(await Promise.all(ids.map(async (id) => (await inWorker((i) => chrome.tabs.get(i), id)).windowId)), ids.map(() => there), `${top}'s tree together`);
        await eventually(storedLeaving, null, `the stored tree once ${top}'s tree is there`);
        assert.equal((await settledTree()).nodes[ids[0]]?.collapsed, true, `${top} collapsed in ${where}`);
        const page = collectErrors(await openPanel(browser, worker, extensionId, there), `panel of ${top}'s window`);
        panels.push(page);
        await eventually(() => rowsOf(page, top), [[top, true, '2']], `${top}'s tree in the panel of ${where}`);
      }
    } finally {
      for (const page of panels) await page.close();
      await closeTabs(/^[HJ](\.|$)/);
    }
  });

  await step('a pinned tab hides nothing and nothing hides it: switching to one expands no tree, but a tab it opens in the foreground, or unpinning, expands the tree above the active tab', async () => {
    // P heads P.1 and P.2 (see treeOfTwo); P.1 is pinned, so it shows above the tree, and P is collapsed.
    // Nothing hides a pinned tab: switching to P.1 leaves P collapsed. A link in P.1 opens P.1.1 in the
    // foreground: it hangs under P, in P.1's place, and P expands to show it. P is collapsed again, and
    // stays so with P.1 the active tab; unpinned, P.1 is in P's tree again, under P, and P expands to show
    // it. Then X heads X.1 and X.2, is collapsed and is pinned, so X.1 and X.2 step up to the top level.
    // A pinned tab hides nothing: switching to X.1 leaves X collapsed. Unpinned, X is above X.1 again,
    // and expands to show it.
    try {
      const [p, p1] = await treeOfTwo('P');
      await inWorker((id) => chrome.tabs.update(id, { pinned: true }), p1);
      await waitFor(() => panel.$(`#pinned .pin[data-id="${p1}"]`), 'the pinned icon of P.1');
      await collapseActive(p, 'P');
      await activate(p1);
      assert.equal((await handled()).nodes[p]?.collapsed, true, 'P collapsed once P.1, pinned, is the active tab');
      await eventually(() => rowsOf(panel, 'P'), [['P', true, '1']], 'P\'s tree in the panel');
      // (Made by "New tab as child", P.1 began as Edge's New Tab page, which Puppeteer gives no page: asPage.)
      const pageOfP1 = await (await browser.waitForTarget((t) => t.url() === `${base}/?name=P.1`)).asPage();
      await pageOfP1.waitForSelector('#l1');
      await pageOfP1.click('#l1');
      const p11 = await idOf('P.1.1');
      await eventually(async () => [(await storedNodes())[p11]?.parent, await isActive(p11)], [p1, true], 'P.1.1 opened from P.1, and the active tab');
      await eventually(() => rowsOf(panel, 'P'), [['P', false, ''], ['P.1.1', false, ''], ['P.2', false, '']], 'P\'s tree in the panel once P.1 has opened P.1.1');
      await collapseActive(p, 'P');
      await activate(p1);
      assert.equal((await handled()).nodes[p]?.collapsed, true, 'P collapsed again once P.1 is the active tab');
      await inWorker((id) => chrome.tabs.update(id, { pinned: false }), p1);
      await eventually(() => rowsOf(panel, 'P'), [['P', false, ''], ['P.1', false, ''], ['P.1.1', false, ''], ['P.2', false, '']], 'P\'s tree in the panel once P.1 is unpinned');
      assert.equal(await isActive(p1), true, 'P.1 the active tab');
      await closeTabs(/^P(\.|$)/);

      const [x, x1] = await treeOfTwo('X');
      await collapseActive(x, 'X');
      await inWorker((id) => chrome.tabs.update(id, { pinned: true }), x);
      await waitFor(() => panel.$(`#pinned .pin[data-id="${x}"]`), 'the pinned icon of X');
      await activate(x1);
      assert.equal((await handled()).nodes[x]?.collapsed, true, 'X collapsed once X.1 is the active tab, X pinned');
      await eventually(() => rowsOf(panel, 'X'), [['X.1', false, ''], ['X.2', false, '']], 'X.1 and X.2 at the top level while X is pinned');
      await inWorker((id) => chrome.tabs.update(id, { pinned: false }), x);
      await eventually(() => rowsOf(panel, 'X'), [['X', false, ''], ['X.1', false, ''], ['X.2', false, '']], 'X\'s tree in the panel once X is unpinned');
      assert.equal(await isActive(x1), true, 'X.1 the active tab');
    } finally {
      await closeTabs(/^[PX](\.|$)/);
    }
  });

  await step('a collapsed tree expands only for a tab that it hides in its window: not for one left in another, but for one it arrives above', async () => {
    // Q heads Q.1 and Q.2 (see treeOfTwo), is collapsed and the active tab, and is dragged alone to C's
    // window. The browser makes Q.1 the active tab of the window Q left; it is at the top level there,
    // so Q stays collapsed. Q comes back with the request a drop on that window's panel sends, above
    // Q.1, which is still the active tab: Q expands to show it, though no tab was activated in that
    // window. Then M heads M.1 and M.2; M.2 is dragged to C's window, where it stays the active tab, and
    // M's tree follows it there, collapsed, with M the active tab: M arrives above M.2 and expands to
    // show it. Last, Ka heads Ka.1 and Ka.2 and goes the same way, but in the tab strip, alone and without
    // becoming the active tab there (one tab of several moved at once, say): no request moves it, and the
    // window it arrives in expands it to show Ka.2 all the same.
    const windowOfC = await windowOf('C');
    let page;
    try {
      const [q, q1] = await treeOfTwo('Q');
      await collapseActive(q, 'Q');
      await dragTo(q, windowOfC);
      await eventually(async () => [await windowOf('Q'), await isActive(q)], [windowOfC, true], 'Q the active tab of C\'s window');
      if (!(await isActive(q1))) {
        console.log('     (Q.1 did not become the active tab of the window Q left: it is made so)');
        await activate(q1);
      }
      assert.equal((await handled()).nodes[q]?.collapsed, true, 'Q collapsed, Q.1 the active tab of the window Q left');
      await eventually(() => rowsOf(panel, 'Q'), [['Q.1', false, ''], ['Q.2', false, '']], 'Q.1 and Q.2 in the first window\'s panel');
      await sendFromPanel({ type: 'move', tabId: q, windowId, targetId: q1, position: 'before' });
      await eventually(async () => [await windowOf('Q'), await isActive(q1)], [windowId, true], 'Q back in the first window, Q.1 its active tab');
      await eventually(() => rowsOf(panel, 'Q'), [['Q', false, ''], ['Q.1', false, ''], ['Q.2', false, '']], 'Q\'s tree in the first window\'s panel');

      const [m, , m2] = await treeOfTwo('M');
      await dragTo(m2, windowOfC);
      await activate(m);
      await collapseActive(m, 'M');
      await eventually(async () => [await windowOf('M.2'), await isActive(m2)], [windowOfC, true], 'M.2 the active tab of C\'s window');
      await sendFromPanel({ type: 'move', tabId: m, windowId: windowOfC, targetId: null, position: 'end' });
      assert.deepEqual([await windowOf('M'), await windowOf('M.1'), await isActive(m2)], [windowOfC, windowOfC, true], 'M\'s tree in C\'s window, M.2 its active tab');
      assert.equal((await handled()).nodes[m]?.collapsed, false, 'M expanded in C\'s window');
      page = collectErrors(await openPanel(browser, worker, extensionId, windowOfC), 'panel of C\'s window');
      await eventually(() => rowsOf(page, 'M'), [['M', false, ''], ['M.1', false, ''], ['M.2', false, '']], 'M\'s tree in the panel of C\'s window');

      const [ka, , ka2] = await treeOfTwo('Ka');
      await dragTo(ka2, windowOfC);
      await activate(ka);
      await collapseActive(ka, 'Ka');
      await eventually(async () => [await windowOf('Ka.2'), await isActive(ka2)], [windowOfC, true], 'Ka.2 the active tab of C\'s window');
      await inWorker((id, w) => chrome.tabs.move(id, { windowId: w, index: -1 }), ka, windowOfC);
      await eventually(async () => [await windowOf('Ka'), await isActive(ka2), (await storedNodes())[ka]?.collapsed], [windowOfC, true, false], 'Ka in C\'s window, expanded above Ka.2, its active tab');
      await eventually(() => rowsOf(page, 'Ka'), [['Ka', false, ''], ['Ka.2', false, '']], 'Ka and Ka.2 in the panel of C\'s window');
    } finally {
      await page?.close();
      await closeTabs(/^([QM]|Ka)(\.|$)/);
    }
  });

  await step('a drop into a collapsed tree expands it only to show the active tab, and a drop on a tab whose children closed while it was collapsed shows', async () => {
    // L heads L.1 and L.2 (see treeOfTwo) and is collapsed. O, which is not the active tab, dropped on the
    // middle of L's row goes into L's tree, hidden. E, the active tab, dropped there too expands L, so that
    // the active tab stays visible, in the very write that puts E there. Opened last, O and E are right
    // after L's tree: neither drop moves a tab, and each reaches the snapshot all the same. Then N heads N.1 and
    // N.2, and its tree, which holds the active tab below its top, dropped on L collapsed again expands L too.
    // N is collapsed, and "Close children" closes its children: N's row shows no sign of being collapsed
    // then, and O dropped on it shows. Last, N's tree goes to C's window, before C, and is collapsed there; E,
    // the active tab here, dropped into it, is not the active tab where it lands, and N stays collapsed. Its
    // children close there while it is collapsed, and L.1 dropped on it from here shows.
    const ours = /^[LNOE](\.|$)/;
    const rows = async () => (await panel.$$eval('#tree .row', (els) => els.map((el) => [
      el.querySelector('.title').textContent, el.classList.contains('collapsed'), el.querySelector('.count').textContent,
    ]))).filter(([title]) => ours.test(title));
    try {
      const [l] = await treeOfTwo('L');
      await collapseActive(l, 'L');
      await inWorker((w, url) => chrome.tabs.create({ windowId: w, url, active: false }), windowId, `${base}/?name=O`);
      const o = await idOf('O');
      await inWorker((w, url) => chrome.tabs.create({ windowId: w, url, active: true }), windowId, `${base}/?name=E`);
      const e = await idOf('E');
      await eventually(rows, [['L', true, '2'], ['O', false, ''], ['E', false, '']], 'L collapsed, then O and E');
      // From here on only the drops may save the snapshot: wait out the save that opening O and E scheduled (held
      // back for up to 5 s while a window closes: see holdSnapshot).
      await sleep(SNAPSHOT_SETTLE_MS);
      await eventually(() => savedNodes([l, o, e]), [[null, true], [null, false], [null, false]], 'L collapsed, then O and E, in the snapshot');
      await dragInPanel(panel, o, l, 0.5);
      await eventually(async () => (await storedNodes())[o]?.parent, l, 'parent of O');
      await eventually(rows, [['L', true, '3'], ['E', false, '']], 'L collapsed around O, which is not the active tab');
      await eventually(() => savedNodes([l, o]), [[null, true], [l, false]], 'L and O in the snapshot');
      await panel.evaluate((e, l) => { // the writes of the tree from the drop on: whether L is collapsed in each
        globalThis.lWrites = [];
        globalThis.onWrite = (changes) => {
          const nodes = changes.tree?.newValue?.nodes;
          if (nodes?.[e]?.parent === l) globalThis.lWrites.push(!!nodes[l]?.collapsed);
        };
        chrome.storage.session.onChanged.addListener(globalThis.onWrite);
      }, e, l);
      await dragInPanel(panel, e, l, 0.5);
      await eventually(async () => (await storedNodes())[e]?.parent, l, 'parent of E');
      await eventually(rows, [['L', false, ''], ['L.1', false, ''], ['L.2', false, ''], ['O', false, ''], ['E', false, '']], 'L expanded around the active tab');
      assert.equal(await isActive(e), true, 'E the active tab still');
      const lWrites = await panel.evaluate(() => {
        chrome.storage.session.onChanged.removeListener(globalThis.onWrite);
        return globalThis.lWrites;
      });
      assert.ok(lWrites.length && lWrites.every((collapsed) => !collapsed), `L expanded in every write that has E under it: ${JSON.stringify(lWrites)}`);
      await eventually(() => savedNodes([l, o, e]), [[null, false], [l, false], [l, false]], 'L, O and E in the snapshot');

      const [n] = await treeOfTwo('N');
      // A tree that holds the active tab below its top (N.2), dropped on the middle of a collapsed row, expands it too.
      await sendFromPanel({ type: 'setCollapsed', tabId: l, collapsed: true });
      await eventually(rows, [['L', true, '4'], ['N', false, ''], ['N.1', false, ''], ['N.2', false, '']], 'L collapsed again, then the tree of N');
      await dragInPanel(panel, n, l, 0.5);
      await eventually(async () => (await storedNodes())[n]?.parent, l, 'parent of N');
      await eventually(rows, [['L', false, ''], ['L.1', false, ''], ['L.2', false, ''], ['O', false, ''], ['E', false, ''], ['N', false, ''], ['N.1', false, ''], ['N.2', false, '']], 'L expanded around N.2, the active tab');
      await collapseActive(n, 'N');
      await sendFromPanel({ type: 'closeChildren', tabId: n });
      await eventually(async () => (await rows()).filter(([title]) => title[0] === 'N'), [['N', false, '']], 'N without children');
      await dragInPanel(panel, o, n, 0.5);
      await eventually(async () => (await storedNodes())[o]?.parent, n, 'parent of O');
      await eventually(async () => (await rows()).filter(([title]) => title[0] === 'N' || title === 'O'), [['N', false, ''], ['O', false, '']], 'O under N');

      const windowOfC = await windowOf('C');
      // E lands before the active tab of C's window, and is the active tab here: taken for the active tab where it
      // lands (the first tab flagged active there, in tab order), it would expand N.
      await sendFromPanel({ type: 'move', tabId: n, windowId: windowOfC, targetId: await idOf('C'), position: 'before' });
      await sendFromPanel({ type: 'setCollapsed', tabId: n, collapsed: true });
      await activate(e);
      await eventually(() => isActive(e), true, 'E the active tab here');
      await sendFromPanel({ type: 'move', tabId: e, windowId: windowOfC, targetId: n, position: 'lastChild' });
      assert.deepEqual([await windowOf('E'), await isActive(e)], [windowOfC, false], 'E in C\'s window, not its active tab');
      const { nodes } = await handled();
      assert.deepEqual([nodes[e]?.parent, nodes[n]?.collapsed], [n, true], 'E under N, and N collapsed still');
      // N's children close while it is collapsed there; L.1, dropped on N from here, shows.
      await sendFromPanel({ type: 'closeChildren', tabId: n });
      await eventually(async () => (await allTabs()).filter((t) => /^[EO]$/.test(t.title)).length, 0, 'E and O closed');
      const l1 = await idOf('L.1');
      await sendFromPanel({ type: 'move', tabId: l1, windowId: windowOfC, targetId: n, position: 'lastChild' });
      const after = await handled();
      assert.deepEqual([after.nodes[l1]?.parent, after.nodes[n]?.collapsed], [n, false], 'L.1 under N in the window of C, and N expanded: its children closed while it was collapsed');
    } finally {
      await closeTabs(ours);
    }
  });

  await step('a tree dropped from another window into a collapsed tab expands it when the active tab there hangs under that tree', async () => {
    // I heads I.1 and I.2 (see treeOfTwo). I.2 goes to C's window in the tab strip and is the active tab there, at the
    // top level (I is still in the first window). Then I's tree is dropped on the middle of C's row there, C collapsed:
    // I.2 hangs under I there (it was opened from I), so under C, which expands to show it.
    const windowOfC = await windowOf('C');
    const c = await idOf('C');
    let page;
    try {
      const [i, , i2] = await treeOfTwo('I');
      await sendFromPanel({ type: 'setCollapsed', tabId: c, collapsed: true });
      await dragTo(i2, windowOfC);
      await eventually(async () => [await isActive(i2), (await storedNodes())[c]?.collapsed], [true, true], "I.2 the active tab in C's window, C collapsed");
      await sendFromPanel({ type: 'move', tabId: i, windowId: windowOfC, targetId: c, position: 'lastChild' });
      const { nodes } = await handled();
      assert.deepEqual([nodes[i]?.parent, nodes[c]?.collapsed, await isActive(i2)], [c, false, true], 'I under C, C expanded, I.2 the active tab');
      page = collectErrors(await openPanel(browser, worker, extensionId, windowOfC), "panel of C's window");
      await eventually(() => rowsOf(page, 'I'), [['I', false, ''], ['I.1', false, ''], ['I.2', false, '']], "I's tree in the panel of C's window");
    } finally {
      await page?.close();
      await closeTabs(/^I(\.|$)/);
      await sendFromPanel({ type: 'setCollapsed', tabId: c, collapsed: false });
    }
  });

  await step('a drop in one window expands a collapsed tab of another window that it puts above the active tab there', async () => {
    // Iv, opened from C with "New tab as child", goes to the first window in the tab strip: at the top level there (C
    // is in C's window). Ik heads Ik.1 and Ik.2 (see treeOfTwo); Ik.2 goes to C's window in the tab strip and is the
    // active tab there, at the top level (Ik is in the first window). C is collapsed. Then Ik's tree is dropped on the
    // middle of Iv's row, in the first window: in C's window Ik.2 hangs under C then, through Ik and Iv, so C expands.
    const windowOfC = await windowOf('C');
    const c = await idOf('C');
    try {
      const v = await newChildNamed(c, 'Iv');
      await dragTo(v, windowId);
      const [k, , k2] = await treeOfTwo('Ik');
      await dragTo(k2, windowOfC);
      await sendFromPanel({ type: 'setCollapsed', tabId: c, collapsed: true });
      await eventually(async () => [await windowOf('Iv'), await isActive(k2), (await storedNodes())[c]?.collapsed], [windowId, true, true], "Iv in the first window, Ik.2 the active tab of C's window, C collapsed");
      await sendFromPanel({ type: 'move', tabId: k, windowId, targetId: v, position: 'lastChild' });
      const { nodes } = await handled();
      assert.deepEqual([nodes[k]?.parent, nodes[c]?.collapsed, await isActive(k2)], [v, false, true], "Ik under Iv, C expanded, Ik.2 the active tab of C's window");
    } finally {
      await closeTabs(/^I[kv](\.|$)/);
      await sendFromPanel({ type: 'setCollapsed', tabId: c, collapsed: false });
    }
  });

  await step('"Close children" closes the descendants and keeps the tab', async () => {
    await sendFromPanel({ type: 'closeChildren', tabId: await idOf('A') });
    await eventually(storedParents, { 'A.3': 'C', 'A.js': 'A.3', A: null, 'A.1.2': null }, 'stored tree');
  });

  await step('"Expand all" expands a collapsed tab whose children left, or that is pinned: the tabs that come back under it show', async () => {
    // M heads M.1 and M.2 (see treeOfTwo) and is collapsed. M.1 goes to C's window in the tab strip without
    // becoming the active tab there (one tab of several moved at once, say), and "Close children" closes M.2:
    // M's row shows no sign of being collapsed, but M still is. "Expand all" expands it all the same, so that
    // M.1, brought back after M the same way, is drawn under it. Then M is collapsed again and pinned, which
    // leaves M.1 at the top level, and "Expand all" expands M too: unpinned, M heads M.1 again, drawn.
    const windowOfC = await windowOf('C');
    try {
      const [m, m1] = await treeOfTwo('M');
      await collapseActive(m, 'M');
      await inWorker((id, w) => chrome.tabs.move(id, { windowId: w, index: -1 }), m1, windowOfC);
      await sendFromPanel({ type: 'closeChildren', tabId: m });
      await eventually(() => rowsOf(panel, 'M'), [['M', false, '']], 'M without children');
      await sendFromPanel({ type: 'setAllCollapsed', windowId, collapsed: false });
      await eventually(async () => (await storedNodes())[m]?.collapsed, false, 'M expanded by "Expand all"');
      const { index } = await inWorker((id) => chrome.tabs.get(id), m);
      await inWorker((id, w, i) => chrome.tabs.move(id, { windowId: w, index: i }), m1, windowId, index + 1);
      await eventually(() => rowsOf(panel, 'M'), [['M', false, ''], ['M.1', false, '']], 'M.1 back under M');
      assert.equal(await isActive(m), true, 'M the active tab still');
      await collapseActive(m, 'M');
      await inWorker((id) => chrome.tabs.update(id, { pinned: true }), m);
      await eventually(() => rowsOf(panel, 'M'), [['M.1', false, '']], 'M pinned, M.1 at the top level');
      await sendFromPanel({ type: 'setAllCollapsed', windowId, collapsed: false });
      await inWorker((id) => chrome.tabs.update(id, { pinned: false }), m);
      await eventually(() => rowsOf(panel, 'M'), [['M', false, ''], ['M.1', false, '']], 'M unpinned, M.1 under it');
      assert.equal(await isActive(m), true, 'M the active tab still, unpinned');
    } finally {
      await closeTabs(/^M(\.|$)/);
    }
  });

  await step('a key acts on no tab the user did not see focused: a collapse moves the focus to the row that hides it, and one a search hides takes no key', async () => {
    // K heads K.1 and K.2 (see treeOfTwo), and K is the active tab. ↓ to K.1, then K is collapsed with its twisty: the
    // focus goes to K's row, and → expands K. Then, with K.1 focused, a search for K.2 leaves K.1 out: Delete closes no
    // tab, and focuses the row that shows K.1's place (K, there for K.2).
    const [k] = await treeOfTwo('K');
    await activate(k);
    const focused = () => panel.$eval('#tree', (el) => [Number(el.querySelector('.row.focused')?.dataset.id), el.getAttribute('aria-activedescendant')]);
    const focusOn = async (title) => { const id = await idOf(title); return [id, `tab-${id}`]; };
    const search = (text) => panel.evaluate((t) => {
      const filter = document.getElementById('filter');
      filter.value = t;
      filter.dispatchEvent(new Event('input'));
    }, text);
    await eventually(focused, await focusOn('K'), 'the focus on K, the active tab');
    await panel.bringToFront();
    await panel.focus('#tree');
    await panel.keyboard.press('ArrowDown');
    assert.deepEqual(await focused(), await focusOn('K.1'), 'focus on K.1');
    // A click on the row of the active tab focuses it, though no tab event redraws the panel then.
    await panel.click(`#tab-${k} .title`);
    assert.deepEqual(await focused(), await focusOn('K'), 'the focus on K, clicked while it is the active tab');
    await panel.keyboard.press('ArrowDown');
    assert.deepEqual(await focused(), await focusOn('K.1'), 'focus on K.1 again');
    await panel.click(`#tab-${k} .twisty`);
    await eventually(async () => (await storedNodes())[k]?.collapsed, true, 'K collapsed');
    await eventually(focused, await focusOn('K'), 'the focus on K, whose collapse hides K.1');
    await panel.keyboard.press('ArrowRight');
    await eventually(async () => (await storedNodes())[k]?.collapsed, false, 'K expanded by →, on the row with the focus');
    await waitFor(async () => (await panel.$$(`#tab-${await idOf('K.1')}`)).length > 0, 'the row of K.1');
    await panel.keyboard.press('ArrowDown');
    assert.deepEqual(await focused(), await focusOn('K.1'), 'focus on K.1 again');
    await search('K.2');
    await panel.focus('#tree');
    await panel.keyboard.press('Delete');
    await sleep(800);
    assert.equal((await allTabs()).filter((t) => /^K(\.[12])?$/.test(t.title)).length, 3, 'no tab closed');
    assert.deepEqual(await focused(), await focusOn('K'), 'the focus on K, which shows K.1\'s place in the search');
    // End, with the focused tab left out by the search, goes to the last row all the same.
    await search('');
    await waitFor(async () => (await panel.$$(`#tab-${await idOf('K.1')}`)).length > 0, 'the row of K.1 again');
    await panel.focus('#tree');
    await panel.keyboard.press('ArrowDown');
    assert.deepEqual(await focused(), await focusOn('K.1'), 'focus on K.1, the search cleared');
    await search('K.2');
    await panel.focus('#tree');
    await panel.keyboard.press('End');
    assert.deepEqual(await focused(), await focusOn('K.2'), 'End, K.1 left out by the search: the last row');
    await search('');
    await closeTabs(/^K(\.|$)/);
  });

  // ---- tab groups (see groups.js) ----

  /** The groups of window `w`, in strip order: [title, colour, collapsed, [the titles of its tabs]]. */
  const groupsIn = (w) => inWorker(async (win) => {
    const [groups, tabs] = await Promise.all([chrome.tabGroups.query({ windowId: win }), chrome.tabs.query({ windowId: win })]);
    tabs.sort((a, b) => a.index - b.index);
    const at = (group) => tabs.findIndex((t) => t.groupId === group.id);
    return groups.sort((a, b) => at(a) - at(b))
      .map((group) => [group.title, group.color, group.collapsed, tabs.filter((t) => t.groupId === group.id).map((t) => t.title)]);
  }, w);
  /** The group that tab `id` is in, or null. */
  const groupOfTab = (id) => inWorker(async (i) => {
    const tab = await chrome.tabs.get(i).catch(() => null);
    return tab && tab.groupId !== -1 ? chrome.tabGroups.get(tab.groupId).catch(() => null) : null; // gone meanwhile
  }, id);
  /** The titles of the tabs in the group that tab `id` is in, in strip order. */
  const groupTabs = (id) => inWorker(async (i) => {
    const tab = await chrome.tabs.get(i).catch(() => null);
    if (!tab || tab.groupId === -1) return [];
    return (await chrome.tabs.query({ groupId: tab.groupId })).sort((a, b) => a.index - b.index).map((t) => t.title);
  }, id);
  /** Change the group of tab `id` the way the user does in the tab strip (this script is not the worker). */
  const updateGroupOf = (id, props) => inWorker(async (i, p) => chrome.tabGroups.update((await chrome.tabs.get(i)).groupId, p), id, props);
  const setGroupSettings = (groups, ownGroups = 'leave') => inWorker((s) => chrome.storage.local.set({ settings: s }), { groups, ownGroups });
  /** The group name that the panel shows on the row of tab `id`, or null. */
  const pillOf = (page, id) => page.$eval(`#tab-${id} .group-name`, (el) => (el.hidden ? null : el.textContent)).catch(() => null);
  /** A tab titled `title` (the page named `name`) heading `${name}.1` and `${name}.2` (see newChildNamed): their ids. */
  async function titledTree(name, title) {
    await inWorker((w, url) => chrome.tabs.create({ windowId: w, url, active: true }), windowId, `${base}/?name=${name}&title=${encodeURIComponent(title)}`);
    const head = await idOf(title);
    return [head, await newChildNamed(head, `${name}.1`), await newChildNamed(head, `${name}.2`)];
  }
  /** Rename the group of the unit that `id` is in from the panel's right-click menu: type `name`, then Enter. */
  async function renameFromPanel(id, name) {
    await panel.click(`#tab-${id} .title`, { button: 'right' });
    const field = await panel.waitForSelector('#menu:not([hidden]) .group-field input');
    await field.evaluate((el) => el.select());
    if (name) await field.type(name);
    else await panel.keyboard.press('Backspace');
    await panel.keyboard.press('Enter');
  }
  const COMEDY = '(2) Comedy · rss.test';

  await step('a tree is a tab group in the tab strip, in the tree\'s colour and named after its top page', async () => {
    await setGroupSettings('trees');
    const [g] = await titledTree('Gr', COMEDY);
    await eventually(async () => {
      const [group, nodes] = await Promise.all([groupOfTab(g), storedNodes()]);
      return group && [group.title, group.color === nodes[g]?.color, group.collapsed, await groupTabs(g)];
    }, ['Comedy', true, false, [COMEDY, 'Gr.1', 'Gr.2']], 'the group of Gr\'s tree');
    await eventually(() => pillOf(panel, g), 'Comedy', 'the group\'s name in the panel');
  });

  await step('a group is renamed from the panel or the tab strip; an empty name brings back the automatic one', async () => {
    const [g, g1, g2] = await Promise.all([COMEDY, 'Gr.1', 'Gr.2'].map(idOf));
    await panel.click(`#tab-${g1} .title`, { button: 'right' });
    const field = await panel.waitForSelector('#menu:not([hidden]) .group-field input');
    assert.deepEqual(await field.evaluate((el) => [el.value, el.placeholder]), ['', 'Comedy'], 'the name field');
    await panel.keyboard.press('Escape');
    await renameFromPanel(g1, 'Stand-up');
    await eventually(async () => [(await storedNodes())[g]?.groupName, (await groupOfTab(g))?.title], ['Stand-up', 'Stand-up'], 'renamed from the panel');
    await eventually(() => pillOf(panel, g), 'Stand-up', 'the new name in the panel');
    await updateGroupOf(g, { title: 'Jokes' });
    await eventually(async () => (await storedNodes())[g]?.groupName, 'Jokes', 'renamed in the tab strip');
    await eventually(() => pillOf(panel, g), 'Jokes', 'that name in the panel');
    await panel.evaluate((id) => {
      globalThis.names = [];
      chrome.storage.session.onChanged.addListener((changes) => {
        if (changes.tree) globalThis.names.push(changes.tree.newValue?.nodes?.[id]?.groupName ?? null);
      });
    }, g);
    await inWorker(async (i) => {
      const { groupId } = await chrome.tabs.get(i);
      for (const title of ['P', 'Pu', 'Pun', 'Puns']) { // as the strip's name field sends it, a keystroke at a time
        await chrome.tabGroups.update(groupId, { title });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }, g);
    await eventually(async () => (await storedNodes())[g]?.groupName, 'Puns', 'the name typed in the tab strip');
    assert.deepEqual((await panel.evaluate(() => globalThis.names)).filter((name) => ['P', 'Pu', 'Pun'].includes(name)), [], 'no part of it kept on the way');
    await renameFromPanel(g2, '');
    await eventually(async () => [(await storedNodes())[g]?.groupName ?? null, (await groupOfTab(g))?.title], [null, 'Comedy'], 'the automatic name back');
  });

  await step('a colour picked in the panel colours the group, and one picked in the tab strip the tree', async () => {
    const [g, g1] = await Promise.all([COMEDY, 'Gr.1'].map(idOf));
    await panel.click(`#tab-${g1} .title`, { button: 'right' });
    await panel.click('#menu .swatch[aria-label="Purple"]');
    await eventually(async () => [(await storedNodes())[g]?.color, (await groupOfTab(g))?.color], ['purple', 'purple'], 'purple');
    await updateGroupOf(g, { color: 'cyan' });
    await eventually(async () => (await storedNodes())[g]?.color, 'cyan', 'the tree cyan');
    await eventually(async () => (await paintOf('Gr.1')).own, 'var(--tree-cyan-1)', 'Gr.1 in the panel');
  });

  await step('a collapsed tree\'s group collapses, the active tab\'s too, and stays so when the browser opens it; collapsing or expanding the group does that to the tree', async () => {
    const [g, g2] = await Promise.all([COMEDY, 'Gr.2'].map(idOf));
    // Another tree, collapsed (its group too), for later.
    const [un] = await treeOfTwo('Un');
    await sendFromPanel({ type: 'setCollapsed', tabId: un, collapsed: true });
    await eventually(async () => [(await storedNodes())[un]?.collapsed, (await groupOfTab(un))?.collapsed], [true, true], 'Un and its group collapsed');
    // Tabs to move and close around Gr's group later, made now, in the foreground, while the active tab does not matter
    // yet (Edge can leave a tab made in the background without its page).
    const pre = await openNamed('Pre', { windowId, active: true });
    const pre2 = await openNamed('Pre2', { windowId, active: true });
    await inWorker((w, url) => chrome.tabs.create({ windowId: w, url, active: false }), windowId, `${base}/?name=Go`);
    const go = await idOf('Go');
    await activate(g2);
    await collapseActive(g, 'Gr'); // Gr is the active tab then
    const state = async (active) => [(await groupOfTab(g))?.collapsed, (await storedNodes())[g]?.collapsed, await isActive(active)];
    /** The group and the tree collapsed, and Gr the active tab: soon, and still a while later. */
    const stayShut = async (what) => {
      await eventually(() => state(g), [true, true, true], what);
      await sleep(1500);
      await handled();
      assert.deepEqual(await state(g), [true, true, true], `${what}, still`);
    };
    /** The group and the tree open, and Gr.2 the active tab: soon, and still a while later. */
    const stayOpen = async (what) => {
      await eventually(() => state(g2), [false, false, true], what);
      await sleep(1500);
      await handled();
      assert.deepEqual(await state(g2), [false, false, true], `${what}, still`);
    };
    await stayShut('the group collapsed, though it holds the active tab');
    // From here on, whether each write of the tree has Gr collapsed, and how often Gr's group opened.
    await panel.evaluate(async (id) => {
      globalThis.collapses = [];
      chrome.storage.session.onChanged.addListener((changes) => {
        if (changes.tree) globalThis.collapses.push(!!changes.tree.newValue?.nodes?.[id]?.collapsed);
      });
      const gid = (await chrome.tabs.get(id)).groupId;
      globalThis.opened = 0;
      chrome.tabGroups.onUpdated.addListener((group) => { if (group.id === gid && !group.collapsed) globalThis.opened++; });
    }, g);
    // The browser opens a collapsed group when a tab of it becomes the active one, and (Chromium) when the active tab's
    // place changes while the group holds it: a tab before it moves away or closes (one made before it does not move the
    // selection). Not the user's doing: the tree stays collapsed, and the group closes again.
    await activate(go);
    await activate(g);
    await stayShut('collapsed, after a switch to Gr');
    await inWorker((ids) => chrome.tabs.move(ids, { index: 0 }), [pre, pre2]);
    await stayShut('collapsed, after two tabs moved before it');
    await inWorker((i) => chrome.tabs.move(i, { index: -1 }), pre);
    await stayShut('collapsed, after a tab before it moved behind it');
    await closeTabs(/^Pre2$/);
    await stayShut('collapsed, after a tab before it closed');
    await closeTabs(/^Pre$/);
    await stayShut('collapsed, after a tab behind it closed'); // and the user's next step comes no sooner than a person's
    assert.equal((await panel.evaluate(() => globalThis.collapses)).includes(false), false, 'the tree expanded in no write meanwhile');
    if (!(await panel.evaluate(() => globalThis.opened))) {
      console.log('     (the browser never opened the collapsed group by itself here: this run could not check that those openings are not taken for the user\'s)');
    }
    // Expanded in the tab strip while it holds the active tab: the tree expands, and the group stays open.
    await updateGroupOf(g, { collapsed: false });
    await eventually(async () => (await storedNodes())[g]?.collapsed, false, 'the tree expanded with its group');
    await sleep(1500);
    assert.equal((await groupOfTab(g))?.collapsed, false, 'the group open still');
    // Dragging a group's header collapses it until the drop: the tree does not collapse for that, not even for a moment.
    await panel.evaluate((id) => {
      globalThis.collapses = [];
      chrome.storage.session.onChanged.addListener((changes) => {
        if (changes.tree) globalThis.collapses.push(!!changes.tree.newValue?.nodes?.[id]?.collapsed);
      });
    }, g);
    await inWorker(async (i) => {
      const { groupId } = await chrome.tabs.get(i);
      await chrome.tabGroups.update(groupId, { collapsed: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await chrome.tabGroups.update(groupId, { collapsed: false });
    }, g);
    await sleep(1500);
    await handled();
    assert.deepEqual([(await storedNodes())[g]?.collapsed, (await panel.evaluate(() => globalThis.collapses)).includes(true)], [false, false], 'the tree not collapsed by a header drag');
    // Collapsed in the tab strip around the active tab (Edge leaves it active; Chrome switches to another tab first):
    // the tree collapses, and the group stays collapsed.
    await updateGroupOf(g, { collapsed: true });
    await stayShut('collapsed from the strip, Gr the active tab');
    // A tab of the collapsed group that the tree hides becomes the active one: the browser opens the group, and the tree
    // shows the tab.
    await activate(g2);
    await stayOpen('group and tree open, Gr.2 the active tab');
    // Collapsed in the tab strip around a tab below the top (Edge leaves it active, hidden): the tree collapses, and its
    // top becomes the active tab, as when the tree is collapsed in the panel. That switch is the worker's own: Un's group,
    // opened in the strip right then, is the user's doing, and stays open, its tree with it.
    await updateGroupOf(g, { collapsed: true });
    await waitFor(() => isActive(g), 'Gr the active tab', 10000);
    await updateGroupOf(un, { collapsed: false });
    await stayShut('collapsed from the strip around Gr.2: Gr the active tab now');
    assert.deepEqual([(await storedNodes())[un]?.collapsed, (await groupOfTab(un))?.collapsed], [false, false], 'Un and its group open');
    // Collapsed in the tab strip, and a tab of the group below its top made the active one before that settles: the
    // newer step wins, and group and tree stay open.
    await updateGroupOf(g, { collapsed: false });
    await eventually(async () => (await storedNodes())[g]?.collapsed, false, 'the tree expanded with its group again');
    await sleep(1500); // the user's next step comes no sooner than a person's
    await inWorker(async (i, j) => {
      await chrome.tabGroups.update((await chrome.tabs.get(i)).groupId, { collapsed: true });
      await chrome.tabs.update(j, { active: true });
    }, g, g2);
    await stayOpen('group and tree open: Gr.2 made the active tab while the collapse settled');
    await closeTabs(/^(Go|Un(\.\d)?)$/);
  });

  await step('a tab taken out of its group in the tab strip leaves its tree; one put into the group joins it', async () => {
    const [g, g1] = await Promise.all([COMEDY, 'Gr.1'].map(idOf));
    await inWorker((i) => chrome.tabs.ungroup(i), g1);
    await eventually(async () => (await storedNodes())[g1]?.parent ?? null, null, 'Gr.1 at the top level');
    await eventually(() => groupTabs(g), [COMEDY, 'Gr.2'], 'the group without Gr.1');
    await inWorker(async (i, h) => chrome.tabs.group({ groupId: (await chrome.tabs.get(h)).groupId, tabIds: [i] }), g1, g);
    await eventually(async () => (await storedNodes())[g1]?.parent, g, 'Gr.1 under Gr again');
    await eventually(async () => (await groupTabs(g)).length, 3, 'Gr.1 in the group');
  });

  await step('"Ungroup" in the tab strip leaves the tree as it is, without a group, until "Group in tab strip" in the panel', async () => {
    const [g, g1, g2] = await Promise.all([COMEDY, 'Gr.1', 'Gr.2'].map(idOf));
    await inWorker(async (h) => {
      const { groupId } = await chrome.tabs.get(h);
      await chrome.tabs.ungroup((await chrome.tabs.query({ groupId })).map((t) => t.id));
    }, g);
    await eventually(async () => [(await storedNodes())[g]?.noGroup, await groupOfTab(g)], [true, null], 'Gr\'s tree without a group');
    assert.deepEqual([(await storedNodes())[g1]?.parent, (await storedNodes())[g2]?.parent], [g, g], 'the tree as it was');
    await eventually(() => pillOf(panel, g), null, 'no group name in the panel');
    await panel.click(`#tab-${g2} .title`, { button: 'right' });
    await panel.click('#menu button::-p-text(Group in tab strip)');
    await eventually(async () => [(await storedNodes())[g]?.noGroup ?? null, (await groupTabs(g)).sort()], [null, [COMEDY, 'Gr.1', 'Gr.2'].sort()], 'grouped again');
  });

  await step('a tree that ends loses its group; a tree moved to another window gets its group there', async () => {
    const g = await idOf(COMEDY);
    await closeTabs(/^Gr\./);
    await eventually(() => groupOfTab(g), null, 'no group for a tab alone');
    await closeTabs(/^\(2\) Comedy/);
    const [m] = await titledTree('Gm', 'Moving – A site');
    await renameFromPanel(m, 'Boxes');
    await eventually(async () => (await groupOfTab(m))?.title, 'Boxes', 'Gm\'s group');
    const windowOfC = await windowOf('C');
    await sendFromPanel({ type: 'move', tabId: m, windowId: windowOfC, targetId: null, position: 'end' });
    await eventually(async () => {
      const group = await groupOfTab(m);
      return group && [group.windowId === windowOfC, group.title, group.color === (await storedNodes())[m]?.color, await groupTabs(m)];
    }, [true, 'Boxes', true, ['Moving – A site', 'Gm.1', 'Gm.2']], 'Gm\'s group in C\'s window');
    await closeTabs(/^(Gm\.|Moving)/);
  });

  await step('one group per innermost subtree: each in a colour of its own, in the panel too, and it breaks up once one of its tabs opens a tab', async () => {
    await setGroupSettings('innermost');
    try {
      // R heads R.1 and R.2; R.1 heads R.1.1 and R.1.2, and R.2 heads R.2.1.
      const [r, r1, r2] = await treeOfTwo('R');
      const r11 = await newChildNamed(r1, 'R.1.1');
      await newChildNamed(r1, 'R.1.2');
      await newChildNamed(r2, 'R.2.1');
      const ofR = async () => (await groupsIn(windowId)).filter(([, , , tabs]) => tabs.some((t) => /^R(\.|$)/.test(t)));
      await eventually(async () => (await ofR()).map(([title, , , tabs]) => [title, tabs]),
        [['R.1', ['R.1', 'R.1.1', 'R.1.2']], ['R.2', ['R.2', 'R.2.1']]], 'the groups of R.1 and R.2, and none for R');
      const [[, one], [, two]] = await ofR();
      const nodes = await storedNodes();
      assert.deepEqual([nodes[r1]?.groupColor, nodes[r2]?.groupColor], [one, two], 'their colours kept');
      assert.ok(one !== two && ![one, two].includes(nodes[r]?.color), `colours of their own: ${one} ${two}, R ${nodes[r]?.color}`);
      // R.1.1 is drawn as a child of R.1 in R.1's colour: in its next shade, beside R.1's line and R's.
      await eventually(() => paintOf('R.1.1'), {
        color: one, own: `var(--tree-${one}-1)`, lines: [`--tree-${nodes[r].color}-0`, `--tree-${one}-0`], chip: null, count: null,
      }, 'R.1.1 in R.1\'s colour');
      await newChildNamed(r11, 'R.1.1.1');
      await eventually(async () => (await ofR()).map(([title, , , tabs]) => [title, tabs]),
        [['R.1.1', ['R.1.1', 'R.1.1.1']], ['R.2', ['R.2', 'R.2.1']]], 'R.1\'s group broken up, R.1.1 heading one');
      // One group per tree again: R's whole tree.
      await setGroupSettings('trees');
      await eventually(async () => (await ofR()).map(([title, color, , tabs]) => [title, color, tabs.length]),
        [['R', (await storedNodes())[r]?.color, 7]], 'R\'s tree as one group');
    } finally {
      await setGroupSettings('trees');
      await closeTabs(/^R(\.|$)/);
    }
  });

  await step('one group per page, or per branch: a tab that opens a tab moves out of its group with it, into a group right after; the old group stays', async () => {
    await setGroupSettings('pages');
    try {
      // Pg opened Pg.1 to Pg.4 by links: one group. Then Pg.2, in the middle, opens a link.
      await inWorker((w, url) => chrome.tabs.create({ windowId: w, url, active: true }), windowId, `${base}/?name=Pg`);
      const pg = await pageNamed(browser, base, 'Pg');
      await pg.bringToFront();
      for (let i = 1; i <= 4; i++) {
        await pg.click(`#l${i}`, { button: 'middle' });
        await idOf(`Pg.${i}`);
      }
      /** Pg's tabs in the tab strip, as runs of one group each: [their titles, sorted; whether the run comes right after the one before]. */
      const layout = () => inWorker(async (w) => {
        const runs = [];
        for (const t of (await chrome.tabs.query({ windowId: w })).sort((a, b) => a.index - b.index)) {
          if (!/^(Pg|Pj)(\.|$)/.test(t.title)) continue;
          const last = runs.at(-1);
          if (last && t.groupId !== -1 && last.group === t.groupId && last.end === t.index - 1) {
            last.titles.push(t.title);
            last.end = t.index;
          } else runs.push({ group: t.groupId, titles: [t.title], start: t.index, end: t.index });
        }
        return runs.map((run, i) => [run.titles.sort(), i > 0 && run.start === runs[i - 1].end + 1]);
      }, windowId);
      await eventually(layout, [[['Pg', 'Pg.1', 'Pg.2', 'Pg.3', 'Pg.4'], false]], 'Pg\'s group');
      const old = (await groupOfTab(await idOf('Pg'))).id;
      const open = async (from, link, name) => {
        const page = await pageNamed(browser, base, from);
        await page.bringToFront();
        await page.click(`#l${link}`, { button: 'middle' });
        await idOf(name);
      };
      await open('Pg.2', 1, 'Pg.2.1');
      await eventually(layout, [[['Pg', 'Pg.1', 'Pg.3', 'Pg.4'], false], [['Pg.2', 'Pg.2.1'], true]], 'Pg.2 out, right after the group, leading one with Pg.2.1');
      assert.equal((await groupOfTab(await idOf('Pg'))).id, old, 'the old group kept');
      await open('Pg.2', 2, 'Pg.2.2');
      await eventually(layout, [[['Pg', 'Pg.1', 'Pg.3', 'Pg.4'], false], [['Pg.2', 'Pg.2.1', 'Pg.2.2'], true]], 'a further link of Pg.2\'s in its group');
      await open('Pg.2.1', 1, 'Pg.2.1.1');
      await eventually(layout, [[['Pg', 'Pg.1', 'Pg.3', 'Pg.4'], false], [['Pg.2', 'Pg.2.2'], true], [['Pg.2.1', 'Pg.2.1.1'], true]],
        'a link from Pg.2.1: Pg.2.1 out in turn, right after Pg.2\'s group');
      // One group per branch: Pg.2.1's branch goes back to Pg.2's group, Pg.2.2 gets one of its own.
      await setGroupSettings('branches');
      await eventually(layout, [[['Pg', 'Pg.1', 'Pg.3', 'Pg.4'], false], [['Pg.2', 'Pg.2.1', 'Pg.2.1.1'], true], [['Pg.2.2'], true]],
        'per branch: Pg.2 with its first branch, then Pg.2.2\'s');
      await open('Pg.2.1.1', 1, 'Pg.2.1.1.1');
      await eventually(layout, [[['Pg', 'Pg.1', 'Pg.3', 'Pg.4'], false], [['Pg.2', 'Pg.2.1', 'Pg.2.1.1', 'Pg.2.1.1.1'], true], [['Pg.2.2'], true]],
        'what is opened in a branch stays in its group');
      await open('Pg.3', 1, 'Pg.3.1');
      await eventually(layout, [[['Pg', 'Pg.1', 'Pg.4'], false], [['Pg.3', 'Pg.3.1'], true], [['Pg.2', 'Pg.2.1', 'Pg.2.1.1', 'Pg.2.1.1.1'], true], [['Pg.2.2'], true]],
        'Pg.3 out, right after the old group, leading one with Pg.3.1');
      assert.equal((await groupOfTab(await idOf('Pg'))).id, old, 'the old group kept still');
      // A further link from Pg.3 (the browser puts it just after Pg.3, before Pg.3.1): a group of its own; Pg.3.1 stays
      // the first link.
      await open('Pg.3', 2, 'Pg.3.2');
      await eventually(layout, [[['Pg', 'Pg.1', 'Pg.4'], false], [['Pg.3', 'Pg.3.1'], true], [['Pg.3.2'], true], [['Pg.2', 'Pg.2.1', 'Pg.2.1.1', 'Pg.2.1.1.1'], true], [['Pg.2.2'], true]],
        'Pg.3.2 in a group of its own, right after Pg.3\'s');
      // A tab the user puts into Pg.3's group stays in it: under Pg.3.1, not a further link of Pg.3's.
      const pj = await openNamed('Pj', { windowId, active: true });
      await sleep(1000); // a tab the browser just made is not the user's to move (NEW_TAB_EVENTS_MS)
      await inWorker(async (p, i) => chrome.tabs.group({ groupId: (await chrome.tabs.get(i)).groupId, tabIds: [p] }), pj, await idOf('Pg.3'));
      await eventually(async () => (await storedNodes())[pj]?.parent, await idOf('Pg.3.1'), 'Pj under Pg.3.1');
      await sleep(1500);
      assert.deepEqual((await groupTabs(await idOf('Pg.3'))).sort(), ['Pg.3', 'Pg.3.1', 'Pj'], 'Pj in Pg.3\'s group still');
      await open('Pg.3.1', 1, 'Pg.3.1.1');
      await eventually(layout, [[['Pg', 'Pg.1', 'Pg.4'], false], [['Pg.3', 'Pg.3.1', 'Pg.3.1.1', 'Pj'], true], [['Pg.3.2'], true], [['Pg.2', 'Pg.2.1', 'Pg.2.1.1', 'Pg.2.1.1.1'], true], [['Pg.2.2'], true]],
        'what Pg.3.1 opens stays in Pg.3\'s group');
      // Pg.3.1 stays Pg.3's first link, whatever comes under Pg.3 later, older tabs too: Pg.1, dropped under Pg.3 in the
      // panel, gets a group of its own...
      const pg3 = await idOf('Pg.3');
      await sendFromPanel({ type: 'move', tabId: await idOf('Pg.1'), windowId, targetId: pg3, position: 'lastChild' });
      await eventually(async () => [await groupTabs(await idOf('Pg.1')), (await groupTabs(pg3)).sort()],
        [['Pg.1'], ['Pg.3', 'Pg.3.1', 'Pg.3.1.1', 'Pj']], 'Pg.1, dropped under Pg.3, in a group of its own; Pg.3.1\'s branch in Pg.3\'s still');
      // ... and so does a new tab as child of Pg.3 (in Edge, a New Tab page made earlier and kept ready: older than Pg.3.1).
      // (Found by its title: Edge can replace a tab, which changes its id, a while after making it.)
      await newChildNamed(pg3, 'Pg.3.9');
      await eventually(async () => [await groupTabs(await idOf('Pg.3.9')), (await groupTabs(pg3)).sort()],
        [['Pg.3.9'], ['Pg.3', 'Pg.3.1', 'Pg.3.1.1', 'Pj']], 'Pg.3.9, a new tab as child of Pg.3, in a group of its own');
      await closeTabs(/^Pg\.3\.9$/);
      // A first link that closes hands its place on to the first tab it opened, and the others it opened stay in the
      // branch: Pg.2.1.1 and Pg.2.1.2 carry Pg.2.1's branch on in Pg.2's group, and Pg.2.2, older, keeps its own.
      const pg2 = await idOf('Pg.2');
      await open('Pg.2.1', 2, 'Pg.2.1.2');
      await eventually(async () => (await groupTabs(pg2)).sort(), ['Pg.2', 'Pg.2.1', 'Pg.2.1.1', 'Pg.2.1.1.1', 'Pg.2.1.2'],
        'a second link from Pg.2.1 in Pg.2\'s group');
      await closeTabs(/^Pg\.2\.1$/);
      const branch2 = async () => [(await groupTabs(pg2)).sort(), await groupTabs(await idOf('Pg.2.2'))];
      const kept2 = [['Pg.2', 'Pg.2.1.1', 'Pg.2.1.1.1', 'Pg.2.1.2'], ['Pg.2.2']];
      await eventually(branch2, kept2, 'Pg.2.1 closed: its branch in Pg.2\'s group');
      await sleep(1500);
      await handled();
      assert.deepEqual(await branch2(), kept2, 'Pg.2.1\'s branch in Pg.2\'s group still');
      // One group per tree, then per page again: the groups made in that one pass come out each after its parent's.
      await setGroupSettings('trees');
      await eventually(async () => (await layout()).length, 1, 'Pg\'s tree as one group');
      await setGroupSettings('pages');
      await eventually(async () => (await layout()).length, 5, 'per page again: five groups');
      await sleep(1500);
      const runs = await layout();
      const at = (title) => runs.findIndex(([titles]) => titles.includes(title));
      assert.ok(at('Pg') === 0 && at('Pg.2') < at('Pg.2.1.1') && at('Pg.3') < at('Pg.3.1'),
        `each group after its parent's: ${JSON.stringify(runs)}`);
    } finally {
      await setGroupSettings('trees');
      await closeTabs(/^(Pg|Pj)(\.|$)/);
    }
  });

  await step('with groups off the first links are kept too: one group per branch then gives a closed first link\'s place to the tab it opened', async () => {
    // Pf opened Pf.1, which opened Pf.1.1 (its first link) and then Pf.1.2; Pf.1.1 opened Pf.1.1.1; then Pf.1.1 closes.
    // All with groups off: Pf.1.1.1 takes Pf.1.1's place, and Pf.1.2, older than it, stays a further link.
    await setGroupSettings('off');
    try {
      // While the extension still owns groups, its group passes run, and they record first links too: wait until it owns
      // none, so that only the colour pass can record Pf.1's.
      await eventually(async () => Object.keys((await settledTree()).groups ?? {}).length, 0, 'none of the extension\'s groups left');
      await inWorker((w, url) => chrome.tabs.create({ windowId: w, url, active: true }), windowId, `${base}/?name=Pf`);
      await idOf('Pf');
      const open = async (from, link, name) => {
        const page = await pageNamed(browser, base, from);
        await page.bringToFront();
        await page.click(`#l${link}`, { button: 'middle' });
        await idOf(name);
      };
      await open('Pf', 1, 'Pf.1');
      await open('Pf.1', 1, 'Pf.1.1');
      await open('Pf.1', 2, 'Pf.1.2');
      await open('Pf.1.1', 1, 'Pf.1.1.1');
      await sleep(300);
      await handled();
      await closeTabs(/^Pf\.1\.1$/);
      await sleep(300);
      await handled();
      await setGroupSettings('branches');
      const pf1 = await idOf('Pf.1');
      const branch = async () => [(await groupTabs(pf1)).sort(), await groupTabs(await idOf('Pf.1.2'))];
      const want = [['Pf.1', 'Pf.1.1.1'], ['Pf.1.2']];
      // (Every tree of the window gets its groups in this pass, from none.)
      await eventually(branch, want, 'per branch: Pf.1 with Pf.1.1.1, in Pf.1.1\'s place; Pf.1.2 in a group of its own', 20000);
      await sleep(1500);
      await handled();
      assert.deepEqual(await branch(), want, 'Pf.1\'s branch as it was, still');
    } finally {
      await setGroupSettings('trees');
      await closeTabs(/^Pf(\.|$)/);
    }
  });

  await step('a group the user made that holds a whole tree becomes its group; other groups of theirs are left alone, or regrouped', async () => {
    await setGroupSettings('off');
    try {
      const [u, u1, u2] = await treeOfTwo('U');
      const [v, v1, v2] = await treeOfTwo('V');
      await sleep(300);
      await handled(); // answered after the group pass that the last change asked for
      assert.deepEqual([await groupOfTab(u), await groupOfTab(v)], [null, null], 'no groups while they are off');
      // The user groups U's whole tree, and V.1 and V.2 alone.
      await inWorker(async (ids) => {
        const one = await chrome.tabs.group({ tabIds: ids.u, createProperties: { windowId: ids.w } });
        await chrome.tabGroups.update(one, { title: 'Mine', color: 'yellow' });
        const two = await chrome.tabs.group({ tabIds: ids.v, createProperties: { windowId: ids.w } });
        await chrome.tabGroups.update(two, { title: 'Theirs', color: 'red' });
      }, { u: [u, u1, u2], v: [v1, v2], w: windowId });
      await setGroupSettings('trees');
      await eventually(async () => {
        const nodes = await storedNodes();
        return [nodes[u]?.groupName, nodes[u]?.color, await pillOf(panel, u)];
      }, ['Mine', 'yellow', 'Mine'], 'U\'s tree takes over the group that holds it, with its name and colour');
      await sleep(300);
      await handled();
      assert.deepEqual([(await groupOfTab(v))?.id ?? null, (await groupOfTab(v1))?.title], [null, 'Theirs'], 'V\'s tree left alone');
      await setGroupSettings('trees', 'regroup');
      await eventually(async () => [await groupTabs(v), (await groupOfTab(v))?.title], [['V', 'V.1', 'V.2'], 'V'], 'V\'s tree regrouped');
    } finally {
      await setGroupSettings('trees');
      await closeTabs(/^[UV](\.|$)/);
    }
  });

  await step('with groups off, the groups the extension made go and the panel shows no group names', async () => {
    try {
      const [w] = await treeOfTwo('Wg');
      await eventually(async () => (await groupTabs(w)).length, 3, 'Wg\'s group');
      await setGroupSettings('off');
      await eventually(() => groupOfTab(w), null, 'no group');
      await eventually(() => pillOf(panel, w), null, 'no name in the panel');
    } finally {
      await setGroupSettings(GROUPS);
      await closeTabs(/^Wg(\.|$)/);
    }
  });

  await step('the keyboard shortcuts act on the tab where they are pressed: its tree collapses and expands, a new tab as child, to the top level, the tree closes', async () => {
    // As chrome.commands.onCommand does (the keys themselves are the browser's to send), for the tab given.
    const command = (name, tabId) => sendFromPanel({ type: 'command', command: name, tabId });
    const [k, k1, k2] = await treeOfTwo('Ks');
    try {
      await command('toggle-tree', k1);
      await eventually(async () => (await storedNodes())[k]?.collapsed, true, 'Ks collapsed from Ks.1');
      await command('toggle-tree', k);
      await eventually(async () => (await storedNodes())[k]?.collapsed, false, 'Ks expanded again');
      const known = new Set((await allTabs()).map((t) => t.id));
      await command('new-child', k2);
      const child = await waitFor(async () => (await allTabs()).find((t) => !known.has(t.id))?.id, 'the new tab');
      await eventually(async () => (await storedNodes())[child]?.parent, k2, 'a new tab as child of Ks.2');
      await command('top-level', k2);
      await eventually(async () => (await storedNodes())[k2]?.parent ?? null, null, 'Ks.2 at the top level');
      await command('close-tree', k2);
      await eventually(async () => (await allTabs()).some((t) => t.id === k2 || t.id === child), false, 'Ks.2 and its new tab closed');
    } finally {
      await closeTabs(/^Ks(\.|$)/);
    }
  });

  await step('the menu moves a tree to another open window, and closes a tree\'s tab group from any of its tabs', async () => {
    const windowOfC = await windowOf('C');
    const [m, m1] = await treeOfTwo('Mw');
    try {
      const there = (await allTabs()).find((t) => t.windowId === windowOfC && t.active).title;
      await sleep(400); // the panel's list of windows (refreshWindows)
      await panel.click(`#tab-${m} .title`, { button: 'right' });
      await panel.click('#menu button.submenu::-p-text(Move tree to window)');
      await panel.click(`#menu button::-p-text(“${there.slice(0, 10)})`);
      await eventually(async () => [await windowOf('Mw'), await windowOf('Mw.1'), await windowOf('Mw.2')],
        [windowOfC, windowOfC, windowOfC], 'Mw\'s tree in C\'s window');
      await eventually(async () => (await storedNodes())[m1]?.parent, m, 'a tree there still');
    } finally {
      await closeTabs(/^Mw(\.|$)/);
    }
    const [g, g1] = await treeOfTwo('Cg');
    try {
      await setGroupSettings('trees');
      await eventually(async () => (await groupTabs(g)).length, 3, 'Cg\'s group');
      await panel.click(`#tab-${g1} .title`, { button: 'right' });
      await panel.click('#menu button::-p-text(Close group (3 tabs))');
      await eventually(async () => (await allTabs()).filter((t) => /^Cg(\.|$)/.test(t.title)).length, 0, 'the group\'s tabs closed');
    } finally {
      await setGroupSettings(GROUPS);
      await closeTabs(/^Cg(\.|$)/);
    }
  });

  await step('the settings change how the panel looks: theme, row height, text size and indent', async () => {
    const look = () => panel.evaluate(() => {
      const row = document.querySelector('#tree .row');
      return {
        ...document.documentElement.dataset,
        row: Math.round(parseFloat(getComputedStyle(row).height)),
        text: getComputedStyle(row.querySelector('.title')).fontSize,
        bg: getComputedStyle(document.body).backgroundColor,
      };
    });
    try {
      await inWorker((s) => chrome.storage.local.set({ settings: s }),
        { groups: GROUPS, ownGroups: 'leave', theme: 'dark', density: 'compact', textSize: 'large', indent: 'wide' });
      await eventually(look, {
        theme: 'dark', density: 'compact', textSize: 'large', indent: 'wide', unread: 'dot', searchBox: 'show', row: 26, text: '15px',
        bg: 'rgb(31, 31, 31)',
      }, 'dark, compact, with large text');
      await inWorker((s) => chrome.storage.local.set({ settings: s }), { groups: GROUPS, ownGroups: 'leave', theme: 'light', density: 'roomy' });
      await eventually(async () => {
        const { theme, density, textSize, row, text, bg } = await look();
        return { theme, density, textSize, row, text, bg };
      }, { theme: 'light', density: 'roomy', textSize: 'normal', row: 36, text: '13px', bg: 'rgb(255, 255, 255)' }, 'light and roomy');
    } finally {
      await setGroupSettings(GROUPS);
    }
    await eventually(async () => (await look()).row, 30, 'the normal look again');
  });

  await step('the quick switcher finds a tab in any window and switches to it there; asked again, it comes forward', async () => {
    const windowOfC = await windowOf('C');
    await inWorker((w, url) => chrome.tabs.create({ windowId: w, url, active: false }), windowOfC, `${base}/?name=Swfar`);
    const far = await idOf('Swfar');
    const url = `chrome-extension://${extensionId}/switcher.html`;
    const switchers = async () => (await allTabs()).filter((t) => (t.url || t.pendingUrl || '').startsWith(url)).length;
    let switcher = null;
    try {
      await panel.click('#find');
      const target = await browser.waitForTarget((t) => t.url().startsWith(url), { timeout: 10000 });
      switcher = await target.page();
      await switcher.waitForSelector('#results .tab');
      await switcher.type('#query', 'swfar');
      await eventually(() => switcher.$$eval('#results .tab .title', (els) => els.map((el) => el.textContent)), ['Swfar'], 'Swfar alone');
      assert.match(await switcher.$eval('#results .window', (el) => el.textContent), /^Window of /, 'under another window');
      await sendFromPanel({ type: 'openSwitcher', windowId });
      await sleep(300);
      assert.equal(await switchers(), 1, 'asked again: the same switcher');
      // Enter switches to the tab and closes the switcher: its page may be gone before the key's events are answered.
      await switcher.keyboard.press('Enter').catch((error) => {
        if (!/Target closed|Session closed/i.test(error?.message ?? '')) throw error;
      });
      await eventually(async () => (await allTabs()).find((t) => t.id === far)?.active, true, 'Swfar the active tab of its window');
      await eventually(switchers, 0, 'the switcher closed');
    } finally {
      await closeTabs(/^Swfar$/);
      if (switcher && !switcher.isClosed()) await switcher.close().catch(() => {});
    }
  });

  await step('folders: a tree goes into a new folder, another into it from the menu; it is named and given an icon in the panel and in its page, which lists its tabs; its "+" opens a tab in it; closed, its tabs step up', async () => {
    const folderBase = `chrome-extension://${extensionId}/folder.html`;
    const tabById = (id) => inWorker((i) => chrome.tabs.get(i).catch(() => null), id);
    const folderParams = async (id) => Object.fromEntries(new URL((await tabById(id))?.url ?? 'about:blank').searchParams);
    const [f] = await treeOfTwo('Fo');
    const [g] = await treeOfTwo('Fp');
    let folder = null;
    let child = null;
    try {
      await panel.click(`#tab-${f} .title`, { button: 'right' });
      await panel.click('#menu button::-p-text(Move tree to new folder)');
      folder = await waitFor(async () => (await allTabs()).find((t) => t.url?.startsWith(folderBase) || t.pendingUrl?.startsWith(folderBase))?.id, 'the folder');
      await eventually(async () => {
        const nodes = await storedNodes();
        return [nodes[folder]?.parent ?? null, nodes[f]?.parent];
      }, [null, folder], 'Fo\'s tree in the folder, at the top level where Fo was');
      await eventually(() => panel.$eval(`#tab-${folder}`, (el) => [el.classList.contains('folder'), el.querySelector('.title').textContent,
        el.querySelector('.emoji').textContent]).catch(() => null), [true, 'Folder', '📁'], 'the folder\'s row: its name and icon');
      // Named and given an icon from its menu in the panel.
      await panel.click(`#tab-${folder} .title`, { button: 'right' });
      const field = await panel.waitForSelector('#menu:not([hidden]) .group-field input');
      await field.evaluate((el) => {
        el.focus();
        el.select();
      });
      await panel.keyboard.type('Reading');
      await panel.keyboard.press('Enter');
      await eventually(async () => [(await folderParams(folder)).name, (await tabById(folder))?.title], ['Reading', 'Reading'], 'renamed from the panel');
      await panel.click(`#tab-${folder} .title`, { button: 'right' });
      await panel.click('#menu .icon-choice::-p-text(⭐)');
      await eventually(async () => (await folderParams(folder)).icon, '⭐', 'its icon from the panel');
      await eventually(() => panel.$eval(`#tab-${folder} .emoji`, (el) => el.textContent).catch(() => null), '⭐', 'the row\'s icon');
      // Another tree goes into it from the menu.
      await panel.click(`#tab-${g} .title`, { button: 'right' });
      await panel.click('#menu button.submenu::-p-text(Move tree to folder)');
      await panel.click('#menu button::-p-text(Reading)');
      await eventually(async () => (await storedNodes())[g]?.parent, folder, 'Fp\'s tree in the folder');
      // Its page lists its tabs, and renames it.
      const target = await browser.waitForTarget((t) => t.url().startsWith(folderBase), { timeout: 10000 });
      const page = collectErrors(await target.page(), 'folder page');
      await eventually(() => page.$$eval('#tabs li .title', (els) => els.map((el) => el.textContent)).catch(() => null),
        ['Fo', 'Fo.1', 'Fo.2', 'Fp', 'Fp.1', 'Fp.2'], 'the page lists the tabs in the folder');
      await (await page.waitForSelector('#name')).evaluate((el) => {
        el.focus();
        el.select();
      });
      await page.keyboard.type('Read later');
      await page.keyboard.press('Enter');
      await eventually(async () => [(await folderParams(folder)).name, (await tabById(folder))?.title], ['Read later', 'Read later'], 'renamed in its page');
      await eventually(() => panel.$eval(`#tab-${folder} .title`, (el) => el.textContent).catch(() => null), 'Read later', 'the row\'s name');
      // Its "+": a new tab at its end.
      const known = new Set((await allTabs()).map((t) => t.id));
      await panel.hover(`#tab-${folder} .title`);
      await panel.click(`#tab-${folder} .add`);
      child = await waitFor(async () => (await allTabs()).find((t) => !known.has(t.id))?.id, 'the folder\'s new tab');
      await eventually(async () => (await storedNodes())[child]?.parent, folder, 'a new tab in the folder');
      // Closed, its tabs step up a level.
      await inWorker((i) => chrome.tabs.remove(i), folder);
      await eventually(async () => {
        const nodes = await storedNodes();
        return [nodes[f]?.parent ?? null, nodes[g]?.parent ?? null, nodes[child]?.parent ?? null];
      }, [null, null, null], 'its tabs at the top level once it closed');
      folder = null;
    } finally {
      await inWorker((ids) => chrome.tabs.remove(ids.filter((i) => i != null)).catch(() => {}), [folder, child]);
      await closeTabs(/^(Fo|Fp)(\.|$)/);
    }
  });

  await step('selection: Ctrl+click and Shift+click select tabs in the panel and the tab strip, the menu and a drag act on them all, closing many asks first; Ctrl+× closes a tree; Ctrl+drag takes a tab without its children', async () => {
    const titlesOf = async (pattern) => (await allTabs()).filter((t) => pattern.test(t.title ?? '')).map((t) => t.title).sort();
    const highlighted = async () => (await allTabs()).filter((t) => t.windowId === windowId && t.highlighted).map((t) => t.title).sort();
    const withKey = async (key, selector) => {
      await panel.keyboard.down(key);
      try {
        await panel.click(selector);
      } finally {
        await panel.keyboard.up(key);
      }
    };
    const [sa, sa1] = await treeOfTwo('Sa');
    const [sb, sb1, sb2] = await treeOfTwo('Sb'); // Sb.2 the active tab
    let folder = null;
    try {
      await withKey('Control', `#tab-${sa} .title`);
      await withKey('Control', `#tab-${sb} .title`);
      await eventually(highlighted, ['Sa', 'Sb', 'Sb.2'], 'Sa and Sb selected, with the active tab, in the tab strip too');
      await eventually(() => panel.$$eval('.row.selected', (els) => els.length), 2, 'the panel shows them selected');
      // The menu acts on them all: into a new folder, each with the tabs under it.
      await panel.click(`#tab-${sa} .title`, { button: 'right' });
      await eventually(() => panel.$eval('#menu .menu-label', (el) => el.textContent).catch(() => null), '3 tabs selected', 'the selection\'s menu');
      await panel.click('#menu button::-p-text(Move to new folder)');
      folder = await waitFor(async () => (await allTabs()).find((t) => (t.url || t.pendingUrl || '').includes('/folder.html'))?.id, 'the folder');
      await eventually(async () => {
        const nodes = await storedNodes();
        return [nodes[sa]?.parent, nodes[sb]?.parent, nodes[sa1]?.parent, nodes[sb2]?.parent];
      }, [folder, folder, sa, sb], 'both trees in the folder, as they were');
      // A click ends the selection; Shift+click selects the rows from the one clicked last, as they show.
      await panel.click(`#tab-${sa} .title`);
      await eventually(highlighted, ['Sa'], 'a click ends the selection');
      await withKey('Shift', `#tab-${sb1} .title`);
      await eventually(highlighted, ['Sa', 'Sa.1', 'Sa.2', 'Sb', 'Sb.1'], 'Shift+click: Sa to Sb.1');
      // Closing five tabs asks first (the setting's default): Esc keeps them, the dialog's button closes them.
      await panel.click(`#tab-${sa1} .title`, { button: 'right' });
      await panel.click('#menu button::-p-text(Close 5 tabs)');
      await panel.waitForSelector('#dialog:not([hidden])', { timeout: 5000 });
      assert.match(await panel.$eval('#dialog-text', (el) => el.textContent), /^Close the 5 tabs you selected\?$/);
      await panel.keyboard.press('Escape');
      await eventually(() => panel.$eval('#dialog', (el) => el.hidden), true, 'Esc: no dialog');
      assert.deepEqual(await titlesOf(/^S[ab]/), ['Sa', 'Sa.1', 'Sa.2', 'Sb', 'Sb.1', 'Sb.2'], 'nothing closed');
      await panel.click(`#tab-${sa1} .title`, { button: 'right' });
      await panel.click('#menu button::-p-text(Close 5 tabs)');
      await panel.click('#dialog-ok');
      await eventually(() => titlesOf(/^S[ab]/), ['Sb.2'], 'the five closed');
      // Ctrl+× closes a tab with the tabs under it (three: no question).
      const [sc] = await treeOfTwo('Sc');
      await panel.hover(`#tab-${sc} .title`);
      await withKey('Control', `#tab-${sc} .close`);
      await eventually(() => titlesOf(/^Sc/), [], 'Ctrl+× closed Sc with its tabs');
      // Ctrl held as a drag starts: the tab goes alone, its tabs stay where it was.
      const [sd, sd1, sd2] = await treeOfTwo('Sd');
      const [se] = await treeOfTwo('Se');
      await dragInPanel(panel, sd, se, 0.5, { ctrl: true });
      await eventually(async () => {
        const nodes = await storedNodes();
        return [nodes[sd]?.parent, nodes[sd1]?.parent ?? null, nodes[sd2]?.parent ?? null];
      }, [se, null, null], 'Sd alone under Se; Sd.1 and Sd.2 at the top level');
      // A drag of a selected tab takes the selection.
      await panel.click(`#tab-${sd1} .title`);
      await eventually(highlighted, ['Sd.1'], 'Sd.1 the active tab');
      await withKey('Control', `#tab-${sd2} .title`);
      await eventually(highlighted, ['Sd.1', 'Sd.2'], 'Sd.1 and Sd.2 selected');
      // The panel draws the selection a moment after the browser has it: the drag reads it from the panel.
      await eventually(() => panel.$eval(`#tab-${sd2}`, (el) => el.classList.contains('selected')).catch(() => null), true,
        'the panel shows Sd.2 selected');
      await dragInPanel(panel, sd1, se, 0.5);
      await eventually(async () => {
        const nodes = await storedNodes();
        return [nodes[sd1]?.parent, nodes[sd2]?.parent];
      }, [se, se], 'the selection dragged under Se');
    } finally {
      await inWorker((ids) => chrome.tabs.remove(ids.filter((i) => i != null)).catch(() => {}), [folder]);
      await closeTabs(/^S[a-e](\.|$)/);
    }
  });

  /** The settings for a step: the run's groups mode, and `extra`; {} puts the others back to their defaults. */
  const setSettings = (extra) => inWorker((s) => chrome.storage.local.set({ settings: s }), { groups: GROUPS, ownGroups: 'leave', ...extra });
  const tabNow = (id) => inWorker((i) => chrome.tabs.get(i).catch(() => null), id);
  /** A tab made with `props` (as chrome.tabs.create takes them): its id. */
  async function newTabWith(props) {
    const known = new Set((await allTabs()).map((t) => t.id));
    await inWorker((p) => chrome.tabs.create(p), props);
    return waitFor(async () => (await allTabs()).find((t) => !known.has(t.id))?.id, 'the new tab');
  }

  await step('where new tabs go, as the settings say: a New Tab page under the current tab or next to it, a link\'s tab first under its page; the New tab button with Ctrl, "New tab below", and the new-sibling shortcut', async () => {
    const made = [];
    const [w, w1, w2] = await treeOfTwo('Wn'); // Wn.2 the active tab
    const right = async (id, after) => (await tabNow(id))?.index === (await tabNow(after))?.index + 1;
    try {
      // A New Tab page as Ctrl+T opens it (at the end of the strip, the current tab its opener): under it, the last.
      await setSettings({ newTabPlacement: 'child' });
      await sleep(300);
      const n1 = await newTabWith({ windowId, openerTabId: w2, index: 9999 });
      made.push(n1);
      await eventually(async () => [(await storedNodes())[n1]?.parent, await right(n1, w2)], [w2, true], 'a New Tab page under the current tab');
      // Next to it: after the tabs under it, under its parent. (Ctrl+T opens from the current tab: Wn.1 now.)
      await setSettings({ newTabPlacement: 'sibling' });
      await activate(w1);
      await waitFor(() => isActive(w1), 'Wn.1 the active tab');
      await sleep(300);
      const n2 = await newTabWith({ windowId, openerTabId: w1, index: 9999 });
      made.push(n2);
      await eventually(async () => [(await storedNodes())[n2]?.parent, await right(n2, w1)], [w, true], 'a New Tab page next to the current tab');
      // A link's tab, first under its page.
      await setSettings({ linkPlacement: 'first' });
      await sleep(300);
      const page = await pageNamed(browser, base, 'Wn');
      await page.bringToFront();
      await page.click('#l3', { button: 'middle' });
      const w3 = await idOf('Wn.3');
      made.push(w3);
      await eventually(async () => [(await storedNodes())[w3]?.parent, await right(w3, w)], [w, true], 'a link\'s tab first under its page');
      await setSettings({});
      await sleep(300);
      // The New tab button with Ctrl held: under the current tab (Wn.1 now), the last.
      await activate(w1);
      await waitFor(() => isActive(w1), 'Wn.1 the active tab');
      let known = new Set((await allTabs()).map((t) => t.id));
      await panel.keyboard.down('Control');
      try {
        await panel.click('#new-tab');
      } finally {
        await panel.keyboard.up('Control');
      }
      const n3 = await waitFor(async () => (await allTabs()).find((t) => !known.has(t.id))?.id, 'the button\'s tab');
      made.push(n3);
      await eventually(async () => (await storedNodes())[n3]?.parent, w1, 'Ctrl+New tab: under the current tab');
      // "New tab below" in Wn.2's menu: next to it.
      known = new Set((await allTabs()).map((t) => t.id));
      await panel.click(`#tab-${w2} .title`, { button: 'right' });
      await panel.click('#menu button::-p-text(New tab below)');
      const n4 = await waitFor(async () => (await allTabs()).find((t) => !known.has(t.id))?.id, 'the tab below Wn.2');
      made.push(n4);
      await eventually(async () => (await storedNodes())[n4]?.parent, w, '"New tab below": next to Wn.2, under Wn');
      // The new-sibling shortcut on Wn: after its tree, at the top level.
      known = new Set((await allTabs()).map((t) => t.id));
      await sendFromPanel({ type: 'command', command: 'new-sibling', tabId: w });
      const n5 = await waitFor(async () => (await allTabs()).find((t) => !known.has(t.id))?.id, 'the shortcut\'s tab');
      made.push(n5);
      await eventually(async () => [(await storedNodes())[n5]?.parent ?? null, (await tabNow(n5))?.active], [null, true], 'the shortcut: next to Wn, at the top level');
    } finally {
      await setSettings({});
      await inWorker((ids) => chrome.tabs.remove(ids).catch(() => {}), made);
      await closeTabs(/^Wn(\.|$)/);
    }
  });

  await step('closing and the mouse, as the settings say: a closed tab\'s first child takes its place, the tree picks the tab to switch to, a click on the current tab folds its tree, a drop onto a tab goes first, a tab moved in the tab strip takes the place of the tab after it', async () => {
    const [, cp1, cp2] = await treeOfTwo('Cp');
    try {
      await setSettings({ closeParent: 'promote' });
      await sleep(300);
      await closeTabs(/^Cp$/);
      await eventually(async () => {
        const nodes = await storedNodes();
        return [nodes[cp1]?.parent ?? null, nodes[cp2]?.parent];
      }, [null, cp1], 'Cp.1 in Cp\'s place, Cp.2 under it');
      // The active tab closes: the tree gives the tab above it under its parent (the browser would go back to the page
      // that opened it).
      await setSettings({ afterClose: 'tree' });
      await sleep(300);
      const [ac, ac1, ac2] = await treeOfTwo('Ac'); // Ac.2 the active tab
      await inWorker((i) => chrome.tabs.remove(i), ac2);
      await eventually(() => isActive(ac1), true, 'Ac.1 the active tab: the one above Ac.2 under Ac');
      // The browser picks that one too (the next tab opened from the same page). Not so here: Ac.x, put under Ac by a
      // drop, was opened from no page, and Ac.1 has a tab under it (Ac.1.1) and Ac.y, at the top level, comes after Ac.x.
      // Ac.x closes: the browser would pick a tab next to it (Ac.1.1 in its group, or Ac.y), the tree Ac.1.
      const acPage = await pageNamed(browser, base, 'Ac.1');
      await acPage.bringToFront();
      await acPage.click('#l1', { button: 'middle' });
      const ac11 = await idOf('Ac.1.1');
      await eventually(async () => (await storedNodes())[ac11]?.parent, ac1, 'Ac.1.1 under Ac.1');
      const loose = [];
      for (const name of ['Ac.x', 'Ac.y']) {
        await inWorker((w, u) => chrome.tabs.create({ windowId: w, url: u, active: false }), windowId, `${base}/?name=${name}`);
        loose.push(await idOf(name));
      }
      const [acx, acy] = loose;
      await dragInPanel(panel, acx, ac, 0.5);
      await eventually(async () => [(await storedNodes())[acx]?.parent, (await tabNow(acx))?.index === (await tabNow(ac11))?.index + 1,
        (await tabNow(acy))?.index === (await tabNow(acx))?.index + 1], [ac, true, true], 'Ac.x dropped under Ac, after Ac.1.1 and before Ac.y');
      await settledGroups(); // the drop takes Ac.x into Ac's group
      await activate(acx);
      await waitFor(() => isActive(acx), 'Ac.x the active tab');
      await inWorker((i) => chrome.tabs.remove(i), acx);
      await eventually(() => isActive(ac1), true, 'Ac.1 the active tab: the one above Ac.x under Ac, not one next to it');
      // A click on the current tab's row folds its tree.
      await setSettings({ clickToFold: 'click' });
      await sleep(300);
      await activate(ac);
      await waitFor(() => isActive(ac), 'Ac the active tab');
      await panel.click(`#tab-${ac} .title`);
      await eventually(async () => (await storedNodes())[ac]?.collapsed, true, 'a click on the current tab\'s row folds its tree');
      await panel.click(`#tab-${ac} .title`);
      await eventually(async () => (await storedNodes())[ac]?.collapsed, false, 'and unfolds it');
      // A drop onto the middle of a tab: its first child.
      await setSettings({ dropInto: 'first' });
      await sleep(300);
      const [dp, , dp2] = await treeOfTwo('Dp');
      await dragInPanel(panel, cp2, dp, 0.5);
      await eventually(async () => [(await storedNodes())[cp2]?.parent, (await tabNow(cp2))?.index === (await tabNow(dp))?.index + 1],
        [dp, true], 'a drop onto the middle: the first child');
      // A tab moved in the tab strip right before Dp.2: under Dp, as Dp.2 is.
      await setSettings({ stripMoves: 'follow' });
      // The drop ended Cp.1's tree, and the group pass took it out of its group: a move of it within a second of that
      // is the pass's own (see TOUCH_MS). The user's comes once the groups are settled.
      await settledGroups();
      await inWorker(async (i, j) => {
        const [from, to] = [(await chrome.tabs.get(i)).index, (await chrome.tabs.get(j)).index];
        await chrome.tabs.move(i, { index: from < to ? to - 1 : to });
      }, cp1, dp2);
      await eventually(async () => (await storedNodes())[cp1]?.parent, dp, 'moved in the tab strip before Dp.2: under Dp');
    } finally {
      await setSettings({});
      await closeTabs(/^(Cp|Ac|Dp)(\.|$)/);
    }
  });

  await step('a tab group of your own shows in the panel (a band in its colour, its name on its first tab); its menu makes it, adds to it, renames and recolours it, takes a tab out, moves it to a new window; pinned tabs reorder by a drag', async () => {
    const ids = [];
    for (const name of ['Ug1', 'Ug2', 'Ug3', 'Pa', 'Pb']) {
      await inWorker((w, u, pinned) => chrome.tabs.create({ windowId: w, url: u, active: false, pinned }), windowId,
        `${base}/?name=${name}`, name.startsWith('P'));
      ids.push(await idOf(name));
    }
    const [u1, u2, u3, pa, pb] = ids;
    const groupOf = async (id) => (await tabNow(id))?.groupId ?? null;
    try {
      // Ug1 and Ug2 selected, into a new group of their own.
      await activate(u1);
      await waitFor(() => isActive(u1), 'Ug1 the active tab');
      await panel.keyboard.down('Control');
      try {
        await panel.click(`#tab-${u2} .title`);
      } finally {
        await panel.keyboard.up('Control');
      }
      await eventually(async () => (await tabNow(u2))?.highlighted, true, 'Ug2 selected');
      await eventually(() => panel.$eval(`#tab-${u2}`, (el) => el.classList.contains('selected')).catch(() => null), true,
        'the panel shows Ug2 selected');
      await panel.click(`#tab-${u1} .title`, { button: 'right' });
      await panel.click('#menu button::-p-text(Add 2 tabs to new group)');
      await eventually(async () => {
        const [a, b] = await Promise.all([groupOf(u1), groupOf(u2)]);
        return a !== -1 && a === b;
      }, true, 'Ug1 and Ug2 in a new group');
      const group = await groupOf(u1);
      await inWorker((g) => chrome.tabGroups.update(g, { title: 'Mine', color: 'green' }), group);
      await eventually(() => panel.$$eval('.row.in-group', (els) => els.map((el) => el.id)), [`tab-${u1}`, `tab-${u2}`], 'a band on the group\'s tabs');
      await eventually(() => pillOf(panel, u1), 'Mine', 'the group\'s name on its first tab');
      // Renamed and recoloured from the menu of one of its tabs.
      await panel.click(`#tab-${u2} .title`, { button: 'right' });
      const field = await panel.waitForSelector('#menu:not([hidden]) .group-field input');
      await field.evaluate((el) => {
        el.focus();
        el.select();
      });
      await panel.keyboard.type('Ours');
      await panel.keyboard.press('Enter');
      await eventually(async () => (await inWorker((g) => chrome.tabGroups.get(g), group)).title, 'Ours', 'renamed from the panel');
      await panel.click(`#tab-${u2} .title`, { button: 'right' });
      await panel.click('#menu .swatch[aria-label="Purple"]');
      await eventually(async () => (await inWorker((g) => chrome.tabGroups.get(g), group)).color, 'purple', 'recoloured from the panel');
      // Ug3 in, and out again.
      await panel.click(`#tab-${u3} .title`, { button: 'right' });
      await panel.click('#menu button.submenu::-p-text(Add to group)');
      await panel.click('#menu button::-p-text(“Ours”)');
      await eventually(() => groupOf(u3), group, 'Ug3 in the group');
      await panel.click(`#tab-${u3} .title`, { button: 'right' });
      await panel.click('#menu button::-p-text(Remove from group)');
      await eventually(() => groupOf(u3), -1, 'Ug3 out of it');
      // Pinned tabs reorder by a drag: Pb onto Pa's left half goes before it.
      await panel.evaluate((source, target) => {
        const from = document.querySelector(`.pin[data-id="${source}"]`);
        const to = document.querySelector(`.pin[data-id="${target}"]`);
        const dataTransfer = new DataTransfer();
        const rect = to.getBoundingClientRect();
        const point = { clientX: rect.left + 2, clientY: rect.top + rect.height / 2 };
        const fire = (el, type, extra = {}) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, ...extra }));
        fire(from, 'dragstart');
        fire(to, 'dragover', point);
        fire(to, 'drop', point);
        fire(from, 'dragend');
      }, pb, pa);
      await eventually(async () => (await tabNow(pb))?.index < (await tabNow(pa))?.index, true, 'Pb dragged before Pa');
      // The group, whole, to a new window.
      await panel.click(`#tab-${u1} .title`, { button: 'right' });
      await panel.click('#menu button::-p-text(Move group to new window)');
      await eventually(async () => {
        const [a, b] = await Promise.all([tabNow(u1), tabNow(u2)]);
        return a?.windowId !== windowId && a?.windowId === b?.windowId && a?.groupId === b?.groupId && a?.groupId !== -1;
      }, true, 'the group in a new window');
    } finally {
      await closeTabs(/^(Ug[123]|Pa|Pb)$/);
      // The new window closes with them: the snapshot waits (WINDOW_CLOSE_HOLD_MS) before the next step's changes.
      await sleep(6500);
    }
  });

  await step('looks and search: a tab opened in the background is unread until looked at; a regular expression; a tab only its address matched shows it; the search box hides until Ctrl+F; your own colours; the menu of folders and groups; the settings page lists the shortcuts', async () => {
    const made = [];
    const setFilter = (text) => panel.$eval('#filter', (el, value) => {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    const [ex] = await treeOfTwo('Ex');
    try {
      await inWorker((w, u) => chrome.tabs.create({ windowId: w, url: u, active: false }), windowId, `${base}/?name=Exu`);
      const exu = await idOf('Exu');
      made.push(exu);
      const unread = () => panel.$eval(`#tab-${exu}`, (el) => el.classList.contains('unread')).catch(() => null);
      await eventually(unread, true, 'unread before it is looked at');
      await activate(exu);
      await eventually(unread, false, 'read once it was the active tab');
      // A regular expression: Ex.1 and Ex.2 match, Ex shows dimmed above them.
      await panel.click('#regex');
      await eventually(() => panel.$eval('#regex', (el) => el.getAttribute('aria-pressed')), 'true', 'the .* button on');
      await setFilter(String.raw`^Ex\.\d$`);
      await eventually(() => panel.$$eval('.row:not(.dim) .title', (els) => els.map((el) => el.textContent).sort()), ['Ex.1', 'Ex.2'],
        'the regular expression: Ex.1 and Ex.2');
      await setFilter('(Ex');
      await eventually(() => panel.$eval('#filter', (el) => el.classList.contains('invalid')), true, 'no regular expression: marked');
      await panel.click('#regex');
      // A tab that only its address matched: its address shows, marked.
      await setFilter('name=Exu');
      await eventually(() => panel.$eval(`#tab-${exu} .url`, (el) => (el.hidden ? null : /name=Exu/.test(el.textContent))).catch(() => null),
        true, 'its address shows when only it matched');
      await setFilter('');
      // The search box hidden until Ctrl+F.
      await setSettings({ searchBox: 'hide' });
      await eventually(() => panel.$eval('.search', (el) => getComputedStyle(el).display), 'none', 'the search box hidden');
      await panel.focus('#tree');
      await panel.keyboard.down('Control');
      await panel.keyboard.press('f');
      await panel.keyboard.up('Control');
      await eventually(() => panel.$eval('.search', (el) => getComputedStyle(el).display !== 'none'), true, 'Ctrl+F shows it');
      await setSettings({});
      // Your own colours.
      const activeColor = () => panel.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--active').trim());
      await inWorker(() => chrome.storage.local.set({ colors: { on: true, values: { active: '#123456' } } }));
      await eventually(activeColor, '#123456', 'the panel in your colours');
      await inWorker(() => chrome.storage.local.remove('colors'));
      await eventually(async () => (await activeColor()) !== '#123456', true, 'and back in the theme\'s');
      // The menu of folders and groups switches to one.
      const folder = (await sendFromPanel({ type: 'moveToNewFolder', tabIds: [ex] }))?.result;
      made.push(folder);
      await eventually(() => panel.$eval(`#tab-${folder}`, (el) => el.classList.contains('folder')).catch(() => null), true, 'the folder\'s row');
      await panel.click('#more');
      await panel.click('#menu button::-p-text(Folders and groups)');
      await panel.click('#menu button::-p-text(Folder)');
      await eventually(() => isActive(folder), true, 'the menu of folders and groups switches to the folder');
      // The settings page lists the keyboard shortcuts, those with keys first. Its categories show one at a time; the
      // arrow keys move between them; a choice is saved and drawn in its example; a reload keeps the category.
      const options = collectErrors(await browser.newPage(), 'settings page');
      try {
        await options.goto(`chrome-extension://${extensionId}/options.html`);
        await options.waitForSelector('#shortcuts li', { timeout: 10000 });
        const shortcuts = await options.$$eval('#shortcuts li', (els) => els.length);
        assert.ok(shortcuts >= 12, `the settings page lists the shortcuts (${shortcuts})`);
        const unset = await options.$$eval('#shortcuts kbd', (els) => els.map((el) => el.classList.contains('unset')));
        assert.ok(unset.every((none, i) => none || !unset.slice(0, i).some(Boolean)), `the shortcuts with keys first (${unset})`);
        const shown = () => options.$$eval('[role="tabpanel"]', (els) => els.filter((el) => !el.hidden).map((el) => el.id));
        await eventually(shown, ['panel-groups'], 'the first category alone');
        await options.click('#tab-new-tabs');
        await eventually(shown, ['panel-new-tabs'], 'New tabs alone');
        assert.equal(new URL(options.url()).hash, '#new-tabs', 'the category in the address');
        await options.keyboard.press('ArrowDown');
        await eventually(shown, ['panel-closing'], 'the arrow key: the next category');
        assert.equal(await options.evaluate(() => document.activeElement?.id), 'tab-closing', 'the focus on its tab');
        await options.click('#tab-new-tabs');
        await options.click('input[name="newTabPlacement"][value="child"]');
        await eventually(async () => (await inWorker(() => chrome.storage.local.get('settings'))).settings?.newTabPlacement, 'child', 'the choice saved');
        await eventually(() => options.$eval('[data-example="newTabPlacement"] .ex-row.added', (el) => [el.querySelector('.ex-title').textContent, el.style.getPropertyValue('--d')]).catch(() => null),
          ['New tab', '2'], 'its example: the new tab under the current one');
        await options.reload();
        await options.waitForSelector('#panel-new-tabs:not([hidden])', { timeout: 10000 });
        assert.equal(await options.$eval('input[name="newTabPlacement"]:checked', (el) => el.value), 'child', 'the choice shown after a reload');
      } finally {
        await options.close();
      }
    } finally {
      await setSettings({});
      await setFilter('').catch(() => {});
      await inWorker((ids) => chrome.tabs.remove(ids.filter((i) => i != null)).catch(() => {}), made);
      await closeTabs(/^Ex(u|\.\d)?$/);
    }
  });

  await step('a window that closes and comes back gets its tree back: at once, or later on', async () => {
    // Cw opened Cw.1 and Cw.2, and Cw.1 opened Cw.1.1, in a window of their own. The window closes, and comes back: the
    // browser makes it anew, with new tabs (History, Ctrl+Shift+T, or reopening the browser that kept running in the
    // background), as a window made here with the same pages is.
    const names = ['Cw', 'Cw.1', 'Cw.1.1', 'Cw.2'];
    const want = { Cw: null, 'Cw.1': 'Cw', 'Cw.1.1': 'Cw.1', 'Cw.2': 'Cw' };
    const parentsOf = async () => {
      const [tabs, nodes] = await Promise.all([allTabs(), storedNodes()]);
      const titles = new Map(tabs.map((t) => [t.id, t.title]));
      return Object.fromEntries(names.map((name) => {
        const tab = tabs.find((t) => t.title === name);
        const parent = tab ? nodes[tab.id]?.parent ?? null : undefined;
        return [name, parent == null ? parent : titles.get(parent) ?? `#${parent}`];
      }));
    };
    let win = await inWorker(async (url) => (await chrome.windows.create({ url })).id, `${base}/?name=Cw`);
    try {
      for (const [from, link, name] of [['Cw', 1, 'Cw.1'], ['Cw', 2, 'Cw.2'], ['Cw.1', 1, 'Cw.1.1']]) {
        const page = await pageNamed(browser, base, from);
        await page.bringToFront();
        await page.click(`#l${link}`, { button: 'middle' });
        await idOf(name);
      }
      await eventually(parentsOf, want, 'Cw\'s tree');
      await sleep(1500); // in the snapshot
      await handled();
      const urls = await inWorker(async (w) => (await chrome.tabs.query({ windowId: w })).sort((a, b) => a.index - b.index).map((t) => t.url), win);
      const comeBack = () => inWorker(async (u) => (await chrome.windows.create({ url: u })).id, urls);
      await inWorker((w) => chrome.windows.remove(w), win);
      win = await comeBack();
      await eventually(parentsOf, want, 'back at once, with its tree');
      await inWorker((w) => chrome.windows.remove(w), win);
      await sleep(7000); // the snapshot lets it go (WINDOW_CLOSE_HOLD_MS, then a save): it is kept as a closed window
      win = await comeBack();
      await eventually(parentsOf, want, 'back later on, with its tree');
      // Closed again at once, before a snapshot has it: it is kept all the same.
      await inWorker((w) => chrome.windows.remove(w), win);
      await sleep(7000);
      win = await comeBack();
      await eventually(parentsOf, want, 'closed again at once, then back later on, with its tree');
      // Back 4.5 s after it closed, once a snapshot has it: the save held back while a window closes comes while the tabs
      // that came back are being matched, and leaves them to it.
      await sleep(SNAPSHOT_SETTLE_MS);
      await handled();
      await inWorker((w) => chrome.windows.remove(w), win);
      await sleep(4500);
      win = await comeBack();
      await eventually(parentsOf, want, 'back 4.5 s after it closed, with its tree');
      // The window first, its pages a moment later (as when the browser fills a window it opened with its saved session).
      await inWorker((w) => chrome.windows.remove(w), win);
      await sleep(7000);
      win = await inWorker(async () => (await chrome.windows.create({})).id);
      await sleep(1500);
      await inWorker(async (w, u) => {
        for (const url of u) await chrome.tabs.create({ windowId: w, url, active: false });
      }, win, urls);
      await eventually(parentsOf, want, 'its pages a moment after the window, with its tree');
    } finally {
      await inWorker((w) => chrome.windows.remove(w).catch(() => {}), win);
      // A closing window holds the snapshot back (WINDOW_CLOSE_HOLD_MS, then a save): the next step's changes are only
      // in it after that.
      await sleep(6500);
    }
  });

  await step('reloading the extension (session storage wiped) restores the tree by tab id', async () => {
    const before = await storedParents();
    // Colours a fresh start would not give: C's tree green, which A.js inside it holds too, and
    // A's own purple, which it remembers now that it has no children left.
    await sendFromPanel({ type: 'setTreeColor', tabId: await idOf('C'), color: 'green' });
    await eventually(async () => {
      const c = await storedColors();
      return [c.C, c['A.js'], c.A];
    }, ['green', '[green]', '(purple)'], 'colours before the reload');
    // A name and an opt-out that only the snapshot carries through the reload (GROUP_FIELDS in restore.js).
    const [kept] = await treeOfTwo('Kept');
    await sendFromPanel({ type: 'setGroupName', tabId: kept, name: 'Kept name' });
    await sendFromPanel({ type: 'setNoGroup', tabId: kept, noGroup: true });
    if (GROUPS !== 'off') await eventually(() => groupOfTab(kept), null, 'Kept\'s tree out of the groups');
    // A folder, which the browser closes (Chrome) or shows its New Tab page in (Edge) as the extension reloads: it comes
    // back where it was, with its name, and Fk's tree in it.
    const folderBase = `chrome-extension://${extensionId}/folder.html`;
    const [fk] = await treeOfTwo('Fk');
    const kf = (await sendFromPanel({ type: 'moveToNewFolder', tabIds: [fk] }))?.result;
    assert.ok(kf != null, 'a folder for Fk');
    await sendFromPanel({ type: 'renameFolder', tabId: kf, name: 'Kept folder' });
    const folderNow = async () => {
      const tabs = await allTabs();
      const tab = tabs.find((t) => (t.url || '').startsWith(folderBase) && new URL(t.url).searchParams.get('name') === 'Kept folder');
      return tab ? { id: tab.id, title: tab.title, parent: (await storedNodes())[tab.id]?.parent ?? null } : null;
    };
    await eventually(async () => (await folderNow())?.title, 'Kept folder', 'the folder named');
    const colorsBefore = await storedColors();
    await sleep(SNAPSHOT_SETTLE_MS);
    const groupsBefore = await settledGroups();
    await reload();
    collectErrors(worker, 'worker after reload');
    // A panel, the old one gone with the reload: its first request starts the worker's work, should the
    // browser be slow to tell the new worker that it was installed.
    panel = collectErrors(await openPanel(browser, worker, extensionId, windowId), 'panel after the reload');
    await eventually(storedParents, before, 'tree after the reload');
    await eventually(storedColors, colorsBefore, 'colours after the reload');
    // The trees take their groups back (see hadGroup in groups.js).
    await eventually(allGroups, groupsBefore, 'tab groups after the reload');
    await eventually(async () => Object.keys((await settledTree()).groups ?? {}).length, groupsBefore.length, 'the groups the extension\'s again');
    await eventually(async () => {
      const node = (await storedNodes())[kept];
      return [node?.groupName, node?.noGroup, await groupOfTab(kept)];
    }, ['Kept name', true, null], 'Kept\'s name and opt-out after the reload');
    await eventually(async () => {
      const now = await folderNow();
      return now && [now.title, now.parent, (await storedNodes())[fk]?.parent === now.id];
    }, ['Kept folder', null, true], 'the folder back after the reload, with Fk\'s tree in it');
    await inWorker(async (base) => {
      const ids = (await chrome.tabs.query({})).filter((t) => (t.url || '').startsWith(base)).map((t) => t.id);
      if (ids.length) await chrome.tabs.remove(ids);
    }, folderBase);
    await closeTabs(/^(Kept|Fk)(\.|$)/);
  });

  await step('collapsing and expanding reach the snapshot; reloaded from one older than an expansion, the active tab shows', async () => {
    // Every change to the tree reaches the snapshot a second later. F heads F.1 and F.2 (see treeOfTwo): F
    // collapsed, expanded by its arrow, collapsed by "Collapse all", expanded by "Expand all", collapsed again,
    // and expanded by switching to F.1, is saved each way. A reload less than a second after that last change
    // finds the snapshot from before it, with F collapsed though F.1 is the active tab: then the trees that
    // hide a window's active tab expand, and only those.
    let page;
    try {
      // P heads P.1 and P.2 in C's window and is collapsed; its pinned child P.1 is the active tab there. A pinned
      // tab hides nothing: P stays collapsed through the reload.
      const [p, p1] = await treeOfTwo('P');
      await sendFromPanel({ type: 'move', tabId: p, windowId: await windowOf('C'), targetId: null, position: 'end' });
      await inWorker((id) => chrome.tabs.update(id, { pinned: true, active: true }), p1);
      await sendFromPanel({ type: 'setCollapsed', tabId: p, collapsed: true });
      await eventually(async () => [(await storedNodes())[p]?.collapsed, await isActive(p1)], [true, true], 'P collapsed, its pinned P.1 the active tab of the window of C');
      const [f, f1] = await treeOfTwo('F');
      await sleep(SNAPSHOT_SETTLE_MS); // the snapshot has F's tree: from here on only the changes below save it
      await collapseActive(f, 'F');
      await eventually(() => savedNodes([f]), [[null, true]], 'F collapsed in the snapshot');
      await sendFromPanel({ type: 'setCollapsed', tabId: f, collapsed: false });
      await eventually(() => savedNodes([f]), [[null, false]], 'F expanded in the snapshot by its arrow');
      await sendFromPanel({ type: 'setAllCollapsed', windowId, collapsed: true });
      // F.1 by its title: Edge can replace a tab (its id changes) a while after making it.
      await eventually(async () => savedNodes([f, await idOf('F.1')]), [[null, true], [f, false]], 'F collapsed in the snapshot by "Collapse all", and F.1, which has no children, not');
      await sendFromPanel({ type: 'setAllCollapsed', windowId, collapsed: false });
      await eventually(() => savedNodes([f]), [[null, false]], 'F expanded in the snapshot after "Expand all"');
      await collapseActive(f, 'F');
      await eventually(() => savedNodes([f, p]), [[null, true], [null, true]], 'F collapsed in the snapshot again, and P');
      const older = (await inWorker(() => chrome.storage.local.get('snapshot'))).snapshot;
      await activate(await idOf('F.1'));
      await eventually(async () => (await storedNodes())[f]?.collapsed, false, 'F expanded once F.1 is the active tab');
      await eventually(() => savedNodes([f]), [[null, false]], 'F expanded in the snapshot once F.1 is the active tab');
      await inWorker((snapshot) => chrome.storage.local.set({ snapshot }), older); // as a reload within that second finds it
      await reload();
      collectErrors(worker, 'worker after the second reload');
      page = collectErrors(await openPanel(browser, worker, extensionId, windowId), 'panel after the second reload'); // as in the reload step
      await eventually(async () => (await storedNodes())[f]?.collapsed, false, 'F expanded after the reload');
      assert.equal(await isActive(await idOf('F.1')), true, 'F.1 the active tab');
      assert.deepEqual([(await storedNodes())[p]?.collapsed, await isActive(p1)], [true, true], 'P collapsed after the reload, its pinned P.1 the active tab of the window of C');
      await eventually(() => rowsOf(page, 'F'), [['F', false, ''], ['F.1', false, ''], ['F.2', false, '']], 'F\'s tree in the panel');
    } finally {
      await page?.close();
      await closeTabs(/^[FP](\.|$)/);
    }
  });

  await step('after a browser restart the tree is rebuilt from the snapshot', async () => {
    const before = await storedParents();
    const colorsBefore = await storedColors();
    const groupsBefore = await settledGroups();
    const idsOfPages = async () => new Map((await allTabs()).filter((t) => isTestPage(t.title)).map((t) => [t.title, t.id]));
    const idsBefore = await idsOfPages();
    await sleep(SNAPSHOT_SETTLE_MS);
    await browser.close();
    browser = await relaunch({ profile: PROFILE, args: ['--restore-last-session'] });
    ({ worker } = await extensionWorker(browser));
    collectErrors(worker, 'worker after restart');
    // The browser's session restore now and then fails to bring a tab back, or brings back one
    // that was closed before. The extension cannot change that, so check what it does with the
    // tabs that did come back: same tree, with a lost tab's children moved up to its nearest
    // restored ancestor, and tabs that are not in the snapshot at the top level.
    const titlesNow = async () => new Set((await allTabs()).map((t) => t.title));
    const titles = [...new Set([...Object.keys(before), ...Object.keys(colorsBefore)])];
    const present = await waitFor(async () => {
      const now = await titlesNow();
      return titles.every((title) => now.has(title)) ? now : null;
    }, 'the test tabs to be restored').catch(titlesNow);
    const missing = titles.filter((title) => !present.has(title));
    if (missing.length) console.log(`     (the browser did not restore ${missing.join(', ')})`);
    const known = async () => {
      const parents = await storedParents();
      for (const title of Object.keys(parents)) if (!(title in before) && parents[title] === null) delete parents[title];
      return parents;
    };
    await eventually(known, withoutMissing(before, present), 'tree after the restart', 20000);
    const revived = Object.keys(await storedParents()).filter((title) => !(title in before));
    if (revived.length) console.log(`     (the browser also brought back ${revived.join(', ')}, closed before)`);
    // A lost top tab changes the colours of its tree (its subtrees become trees), and so does losing
    // every other tab of a tree (its top tab heads none then): compare those of the other trees.
    const rootOf = (title) => (before[title] == null ? title : rootOf(before[title]));
    const heads = new Set(Object.keys(before).filter((title) => before[title] != null).map(rootOf));
    const lostTrees = new Set([...heads].filter((head) => !present.has(head)
      || !Object.keys(before).some((title) => title !== head && present.has(title) && rootOf(title) === head)));
    const compared = Object.keys(colorsBefore).filter((title) => present.has(title) && !lostTrees.has(rootOf(title)));
    if (missing.length) console.log(`     (colours compared for ${compared.join(', ') || 'no tab'})`);
    await eventually(async () => {
      const now = await storedColors();
      return Object.fromEntries(compared.map((title) => [title, now[title]]));
    }, Object.fromEntries(compared.map((title) => [title, colorsBefore[title]])), 'colours after the restart');
    // The groups whose tabs all came back, as they were: the browser restores them, or the worker makes them again.
    const whole = groupsBefore.filter(([, , , tabs]) => tabs.every((title) => present.has(title)) && !tabs.some((title) => lostTrees.has(rootOf(title))));
    await eventually(async () => (await allGroups()).filter((group) => whole.some(([, , , tabs]) => tabs[0] === group[3][0])), whole, 'tab groups after the restart', 20000);
    // Chromium gives restored tabs new ids (matched by URL); Edge keeps them (matched by id).
    const idsAfter = await idsOfPages();
    const kept = [...idsAfter].every(([title, id]) => !idsBefore.has(title) || idsBefore.get(title) === id);
    console.log(`     (tab ids ${kept ? 'were kept: matched by id' : 'changed: matched by URL'})`);
  });

  await step('the extension logged no errors', async () => {
    assert.deepEqual(loggedErrors, []);
  });

  console.log(`\nall ${passed} end-to-end checks passed`);
} catch (error) {
  console.error(`\nnot ok ${passed + 1}`);
  console.error(error);
  console.error('\nTabs (window#index id "title" url), the stored tree and the saved snapshot at the time:');
  console.error(await inWorker(async () => JSON.stringify({
    tabs: (await chrome.tabs.query({})).map((t) => `${t.windowId}#${t.index} ${t.id} "${t.title}" ${t.url}`),
    tree: (await chrome.storage.session.get('tree')).tree ?? '(none)',
    snapshot: (await chrome.storage.local.get('snapshot')).snapshot?.windows.map((w) => w.tabs),
  }, null, 1)).catch((e) => `(unavailable: ${e.message})`));
  // Whether the panel could draw then: it draws in animation frames, which a hidden page does not get.
  console.error('\nThe panel at the time:', await panel?.evaluate(() => new Promise((resolve) => {
    const state = { visibility: document.visibilityState, focused: document.hasFocus(), rows: document.querySelectorAll('#tree > *').length };
    const timer = setTimeout(() => resolve({ ...state, frame: 'none within 2 s' }), 2000);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve({ ...state, frame: 'drawn' });
    });
  })).catch((e) => `(unavailable: ${e.message})`));
  if (loggedErrors.length) console.error('\nErrors the extension logged:', loggedErrors);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  server.close();
  await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
}
