// Side panel: draws this window's tabs as a tree. It reads the tree the service worker keeps
// in chrome.storage.session and asks the worker for every change to it; plain tab actions
// (activate, close, reload, pin, mute) go straight to chrome.tabs.

import { buildForest, flatten, rememberColor, shadeOf, subtree, TREE_COLORS, treeColors } from './tree.js';
import { autoName, groupUnits, isNested, readSettings, unitColors, unitTitle } from './groups.js';

const params = new URLSearchParams(location.search);
// ?windowId= shows another window's tabs (used by the end-to-end test).
const windowId = params.has('windowId')
  ? Number(params.get('windowId'))
  : (await chrome.windows.getCurrent()).id;

const DRAG_TYPE = 'application/x-tree-tabs-tab';
// A new tab gets its place from the worker a moment after Chrome reports it. Until then
// (at most this long) it is held back, rather than flashing at the top level first.
const NEW_TAB_GRACE_MS = 250;
// How long a tree dragged in from another window waits for the worker before the panel asks
// whether it is still coming (see onAttached below).
const ARRIVAL_MS = 3000;

const treeEl = document.getElementById('tree');
const pinnedEl = document.getElementById('pinned');
const scrollerEl = document.getElementById('scroller');
const filterEl = document.getElementById('filter');
const emptyEl = document.getElementById('empty');
const newTabEl = document.getElementById('new-tab');
const dropLineEl = document.getElementById('drop-line');
const menuEl = document.getElementById('menu');
const moreEl = document.getElementById('more');
const rowTemplate = document.getElementById('row-template').content.firstElementChild;

let tabs = [];
let tabsById = new Map();
let nodes = {};
let nodesFromEvent = false;
let leaving = null; // tabs the worker is moving to another window, see `leaving` in background.js
let owned = {}; // the tab groups the worker made or took over: { groupId: head }, see groups.js
let settings = readSettings(null);
let units = []; // the tab group units of this window, see groupUnits
let unitColorMap = new Map(); // head of a unit -> its colour
let forest = buildForest([], {});
let rows = [];
let rowsById = new Map();
let indent = 16;
let filter = '';
let focusedId = null;
let lastActiveId = null;
let scrollPending = null; // active tab to scroll into view once its row exists
let drag = null; // { tabId, block } while a drag that started in this panel is running
let dropRow = null;
let menuTabId = null; // the tab the open menu is for
const rowEls = new Map();
const pinEls = new Map();
const unplacedSince = new Map(); // tab id -> when it was first seen without a node
const arriving = new Map(); // tab dragged in from another window -> { picked }, see onAttached below

// ---- data ------------------------------------------------------------------------------

async function send(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) console.error('[tree-tabs]', message.type, response?.error);
    return response?.result;
  } catch (error) {
    console.error('[tree-tabs]', message.type, error);
  }
}

let updateQueued = false;
let updating = false;

/** Re-read this window's tabs and redraw, at most once per frame. */
function scheduleUpdate() {
  if (updateQueued) return;
  updateQueued = true;
  requestAnimationFrame(update);
}

async function update() {
  if (updating) {
    requestAnimationFrame(update);
    return;
  }
  updateQueued = false;
  updating = true;
  try {
    tabs = await chrome.tabs.query({ windowId });
    render();
  } finally {
    updating = false;
  }
}

function watch(event, concerns) {
  event.addListener((...args) => {
    if (concerns(...args)) scheduleUpdate();
  });
}

watch(chrome.tabs.onCreated, (tab) => tab.windowId === windowId);
watch(chrome.tabs.onUpdated, (id, change, tab) => tab.windowId === windowId);
watch(chrome.tabs.onRemoved, (id, info) => info.windowId === windowId);
watch(chrome.tabs.onMoved, (id, info) => info.windowId === windowId);
watch(chrome.tabs.onActivated, (info) => info.windowId === windowId);
watch(chrome.tabs.onHighlighted, (info) => info.windowId === windowId);
watch(chrome.tabs.onAttached, (id, info) => info.newWindowId === windowId);
watch(chrome.tabs.onDetached, (id, info) => info.oldWindowId === windowId);
watch(chrome.tabs.onReplaced, () => true);

// A tree dragged in from another window claims its colour afresh here (see attached() in
// background.js). Until the worker has let go of the colour, draw the tree as if it had, or in
// the colour picked for it meanwhile until that is stored. Should that write never come (one
// colour picked elsewhere is written together with letting go of the other), stop waiting once
// the worker has caught up with the move.
chrome.tabs.onAttached.addListener((id, info) => {
  if (info.newWindowId !== windowId || !nodes[id]?.color) return;
  const entry = { picked: null };
  arriving.set(id, entry);
  setTimeout(async () => {
    if (arriving.get(id) !== entry) return;
    await send({ type: 'ping' }); // answered after the tasks queued before it: the move's, a pick
    setTimeout(() => {
      if (arriving.get(id) !== entry) return;
      arriving.delete(id);
      scheduleUpdate();
    }, 100); // their write comes a moment later
  }, ARRIVAL_MS);
});

chrome.storage.session.onChanged.addListener((changes) => {
  if (!changes.tree) return;
  readTree(changes.tree.newValue);
  for (const [id, entry] of arriving) {
    if (entry.picked ? nodes[id]?.color === entry.picked : !nodes[id]?.color) arriving.delete(id);
  }
  nodesFromEvent = true;
  scheduleUpdate();
});

chrome.storage.local.onChanged.addListener((changes) => {
  if (!changes.settings) return;
  settings = readSettings(changes.settings.newValue);
  scheduleUpdate();
});

function readTree(tree) {
  nodes = tree?.nodes ?? {};
  owned = tree?.groups ?? {};
  const out = tree?.leaving;
  leaving = out && out.windowId !== windowId ? new Set(out.tabs) : null;
}

// ---- rendering -------------------------------------------------------------------------

function render() {
  const focusedAt = rows.findIndex((row) => row.id === focusedId); // in the rows as last drawn
  tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  if (menuTabId != null && !tabsById.has(menuTabId)) closeMenu(); // its tab closed or left
  forest = buildForest(placedTabs(), nodes);
  const query = filter.trim().toLowerCase();
  const matches = query
    ? new Set(tabs.filter((tab) => !tab.pinned && matchesQuery(tab, query)).map((tab) => tab.id))
    : null;
  // A tree the worker has not coloured yet is drawn in the colour it will get, and so is a unit below
  // the top level (see groups.js) that it has not coloured yet.
  const colors = treeColors(forest, withArrivals(nodes));
  units = groupUnits(forest, nodes, settings.groups);
  unitColorMap = unitColors(forest, nodes, units, colors);
  const nested = new Map(units.filter((unit) => isNested(forest, unit)).map((unit) => [unit.head, unitColorMap.get(unit.head)]));
  rows = flatten(forest, nodes, { matches, colors, units: nested });
  rowsById = new Map(rows.map((row) => [row.id, row]));

  // The focused tab closed, left the window or was pinned: focus the row that took its place, as
  // Delete does.
  const gone = !tabsById.has(focusedId) || tabsById.get(focusedId).pinned || leaving?.has(focusedId);
  if (gone && focusedAt >= 0 && rows.length) focusedId = rows[Math.min(focusedAt, rows.length - 1)].id;
  const active = tabs.find((tab) => tab.active);
  if (active && active.id !== lastActiveId) {
    lastActiveId = active.id;
    focusedId = active.id; // keyboard focus follows the active tab
    // Its row may only appear once the worker has expanded a collapsed tree around it.
    scrollPending = active.pinned ? null : active.id;
  }
  // A collapse hid the focused tab: the focus moves to the row that hides it, as in a tree view. Not for a search (the
  // tab is back once the search is cleared; see the keyboard), nor for the active tab: the worker expands the trees
  // above it in a moment (a tab just made active can be drawn before that), and the focus stays with it.
  if (!query && focusedId != null && focusedId !== active?.id && !rowsById.has(focusedId)) {
    focusedId = rowFor(focusedId) ?? focusedId;
  }
  if (rowsById.has(focusedId)) treeEl.setAttribute('aria-activedescendant', `tab-${focusedId}`);
  else treeEl.removeAttribute('aria-activedescendant');

  document.body.classList.toggle('filtering', !!query);
  emptyEl.hidden = !query || rows.length > 0;
  renderPinned();
  renderRows(query);
  const activeRow = rowEls.get(scrollPending);
  if (activeRow) {
    activeRow.scrollIntoView({ block: 'nearest' });
    scrollPending = null;
  }
}

/**
 * `nodes` as they will be once the worker has let go of the colours of the `arriving` tabs, or
 * stored the colours picked for them.
 */
function withArrivals(nodes) {
  if (!arriving.size) return nodes;
  const view = { ...nodes };
  for (const [id, entry] of arriving) {
    view[id] = { ...view[id] };
    if (entry.picked) view[id].color = entry.picked;
    else rememberColor(view[id]);
  }
  return view;
}

/**
 * This window's tabs minus brand-new ones that the worker has not placed yet, and minus those it
 * is moving to another window.
 */
function placedTabs() {
  const now = performance.now();
  let waiting = false;
  const placed = tabs.filter((tab) => {
    if (leaving?.has(tab.id)) return false;
    if (tab.pinned || nodes[tab.id]) {
      unplacedSince.delete(tab.id);
      return true;
    }
    if (!unplacedSince.has(tab.id)) unplacedSince.set(tab.id, now);
    if (now - unplacedSince.get(tab.id) >= NEW_TAB_GRACE_MS) return true;
    waiting = true;
    return false;
  });
  for (const id of unplacedSince.keys()) {
    if (!tabsById.has(id)) unplacedSince.delete(id);
  }
  if (waiting) setTimeout(scheduleUpdate, NEW_TAB_GRACE_MS);
  return placed;
}

function matchesQuery(tab, query) {
  return (tab.title ?? '').toLowerCase().includes(query) || (tab.url ?? '').toLowerCase().includes(query);
}

function renderRows(query) {
  // Indent less when the tree gets deep, so titles keep room in a narrow panel.
  const deepest = rows.reduce((max, row) => Math.max(max, row.depth), 0);
  indent = deepest ? Math.max(6, Math.min(16, Math.floor((treeEl.clientWidth * 0.4) / deepest))) : 16;
  treeEl.style.setProperty('--indent', `${indent}px`);

  let cursor = treeEl.firstElementChild;
  for (const [i, row] of rows.entries()) {
    let el = rowEls.get(row.id);
    if (!el) {
      el = rowTemplate.cloneNode(true);
      el.dataset.id = row.id;
      el.id = `tab-${row.id}`;
      el.querySelector('.favicon').addEventListener('error', () => faviconFailed(el));
      rowEls.set(row.id, el);
    }
    paintRow(el, row, tabsById.get(row.id), query);
    // Its children show below it (not so for a match whose children don't match).
    el.classList.toggle('open', rows[i + 1]?.depth > row.depth);
    if (el === cursor) cursor = cursor.nextElementSibling;
    else treeEl.insertBefore(el, cursor);
  }
  for (const [id, el] of rowEls) {
    if (!rowsById.has(id)) {
      el.remove();
      rowEls.delete(id);
    }
  }
}

function paintRow(el, row, tab, query) {
  el.style.setProperty('--depth', row.depth);
  el.setAttribute('aria-level', row.depth + 1);
  el.setAttribute('aria-selected', String(!!tab.active));
  if (row.hasChildren) el.setAttribute('aria-expanded', String(!row.collapsed));
  else el.removeAttribute('aria-expanded');

  const muted = !!tab.mutedInfo?.muted;
  const classes = el.classList;
  classes.toggle('active', !!tab.active);
  classes.toggle('selected', !!tab.highlighted && !tab.active);
  classes.toggle('parent', row.hasChildren);
  classes.toggle('collapsed', row.collapsed);
  classes.toggle('loading', tab.status === 'loading');
  classes.toggle('discarded', !!tab.discarded);
  classes.toggle('audible', !!tab.audible);
  classes.toggle('muted', muted);
  classes.toggle('dim', row.dim);
  classes.toggle('focused', row.id === focusedId);
  paintColor(el, row);

  // The name of the tab group it heads, once the worker has made the group.
  const name = Object.values(owned).includes(row.id) ? unitTitle(nodes, row.id, tab) : '';
  const pill = el.querySelector('.group-name');
  if (pill.textContent !== name) {
    pill.textContent = name;
    if (name) el.setAttribute('aria-description', `Tab group ${name}`);
    else el.removeAttribute('aria-description');
  }
  pill.hidden = !name;

  const title = tab.title || tab.url || 'New Tab';
  const titleKey = `${title}\u0000${query}`;
  if (el.dataset.titleKey !== titleKey) {
    el.dataset.titleKey = titleKey;
    setTitle(el.querySelector('.title'), title, query);
  }
  const tooltip = tab.url && tab.url !== title ? `${title}\n${tab.url}` : title;
  if (el.title !== tooltip) el.title = tooltip;
  el.querySelector('.count').textContent = row.collapsed ? String(row.descendants) : '';

  const audio = el.querySelector('.audio');
  const audioLabel = muted ? 'Unmute tab' : 'Mute tab';
  if (audio.title !== audioLabel) {
    audio.title = audioLabel;
    audio.setAttribute('aria-label', audioLabel);
  }
  setFavicon(el, tab);
}

const shade = (color, depth) => `var(--tree-${color}-${shadeOf(depth)})`;

/**
 * A row of a tree draws a guide line under each ancestor's twisty, in the shade that the ancestor
 * heads: of the tree's colour, or below the head of a tab group unit with a colour of its own (mode
 * 'innermost'), of that one (see flatten). And --own: its own shade, for its chip, count and group name.
 */
function paintColor(el, { color, palette, depth }) {
  const paint = color ? `${palette.flat().join(' ')} ${depth}` : '';
  if (el.dataset.paint === paint) return;
  el.dataset.paint = paint;
  if (!color) {
    delete el.dataset.color;
    el.style.removeProperty('--own');
    el.style.removeProperty('--lines');
    return;
  }
  const at = (k) => {
    const from = palette.findLast(([, start]) => start <= k);
    return from ? shade(from[0], k - from[1]) : 'transparent';
  };
  el.dataset.color = color;
  el.style.setProperty('--own', at(depth));
  const stops = [];
  for (let k = 0; k < depth; k++) {
    // 2px wide, centred under the twisty of the ancestor at depth k (see .row in sidepanel.css)
    stops.push(`transparent 0 calc(15px + ${k} * var(--indent))`, `${at(k)} 0 calc(17px + ${k} * var(--indent))`);
  }
  el.style.setProperty('--lines', depth ? `linear-gradient(to right, ${stops.join(', ')}, transparent 0)` : 'none');
}

function setTitle(span, title, query) {
  const lower = title.toLowerCase();
  if (!query || lower.length !== title.length) {
    span.textContent = title;
    return;
  }
  span.textContent = '';
  let from = 0;
  for (let at = lower.indexOf(query); at !== -1; at = lower.indexOf(query, from)) {
    const mark = document.createElement('mark');
    mark.textContent = title.slice(at, at + query.length);
    span.append(title.slice(from, at), mark);
    from = at + query.length;
  }
  span.append(title.slice(from));
}

function renderPinned() {
  pinnedEl.hidden = forest.pinned.length === 0;
  let cursor = pinnedEl.firstElementChild;
  for (const id of forest.pinned) {
    const tab = tabsById.get(id);
    let el = pinEls.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'pin';
      el.dataset.id = id;
      el.innerHTML = '<span class="icon"><img class="favicon" alt="" draggable="false"><span class="spinner"></span></span>';
      el.querySelector('.favicon').addEventListener('error', () => faviconFailed(el));
      pinEls.set(id, el);
    }
    el.classList.toggle('active', !!tab.active);
    el.classList.toggle('loading', tab.status === 'loading');
    el.title = tab.title || tab.url || '';
    setFavicon(el, tab);
    if (el === cursor) cursor = cursor.nextElementSibling;
    else pinnedEl.insertBefore(el, cursor);
  }
  const shown = new Set(forest.pinned); // not those that are leaving
  for (const [id, el] of pinEls) {
    if (!shown.has(id)) {
      el.remove();
      pinEls.delete(id);
    }
  }
}

/** Chrome's own favicon cache, for pages whose favIconUrl we cannot load. */
function cachedFavicon(pageUrl) {
  if (!pageUrl) return '';
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', '32');
  return url.href;
}

function setFavicon(el, tab) {
  const pageUrl = tab.url || tab.pendingUrl;
  const own = tab.favIconUrl && /^(https?|data):/.test(tab.favIconUrl) ? tab.favIconUrl : '';
  const wanted = own || cachedFavicon(pageUrl);
  if (el.dataset.favicon === wanted) return;
  el.dataset.favicon = wanted;
  el.dataset.fallback = cachedFavicon(pageUrl);
  const img = el.querySelector('.favicon');
  el.querySelector('.icon').classList.toggle('fallback', !wanted);
  if (wanted) img.src = wanted;
  else img.removeAttribute('src');
}

function faviconFailed(el) {
  const img = el.querySelector('.favicon');
  const fallback = el.dataset.fallback;
  if (fallback && img.src !== fallback) img.src = fallback;
  else el.querySelector('.icon').classList.add('fallback');
}

/** The row that shows tab `id`: its own, or else that of its nearest ancestor that has one; null if none has. */
function rowFor(id) {
  const seen = new Set();
  for (let at = id; at != null && !seen.has(at); at = forest.parentOf.get(at)) {
    if (rowsById.has(at)) return at;
    seen.add(at);
  }
  return null;
}

function setFocus(id) {
  if (id == null) return;
  focusedId = id;
  for (const [rowId, el] of rowEls) el.classList.toggle('focused', rowId === id);
  treeEl.setAttribute('aria-activedescendant', `tab-${id}`);
  rowEls.get(id)?.scrollIntoView({ block: 'nearest' });
}

// ---- actions ---------------------------------------------------------------------------

const activate = (id) => chrome.tabs.update(id, { active: true });
const close = (id) => chrome.tabs.remove(id);
const setCollapsed = (id, collapsed) => send({ type: 'setCollapsed', tabId: id, collapsed });

function toggleMute(id) {
  const tab = tabsById.get(id);
  if (tab) chrome.tabs.update(id, { muted: !tab.mutedInfo?.muted });
}

function rowIdAt(target) {
  const el = target.closest?.('.row');
  return el ? Number(el.dataset.id) : null;
}

treeEl.addEventListener('click', (event) => {
  const id = rowIdAt(event.target);
  if (id == null) return;
  const row = rowsById.get(id);
  if (event.target.closest('.close')) close(id);
  else if (event.target.closest('.audio')) toggleMute(id);
  else if (event.target.closest('.twisty') && row?.hasChildren && !filter.trim()) setCollapsed(id, !row.collapsed);
  else {
    setFocus(id); // at once: a click on the active tab's row brings no tab event, and so no redraw
    activate(id);
  }
});

treeEl.addEventListener('mousedown', (event) => {
  treeEl.classList.remove('keyboard');
  if (event.button === 1) event.preventDefault(); // no autoscroll on middle click
});

treeEl.addEventListener('auxclick', (event) => {
  const id = rowIdAt(event.target);
  if (event.button === 1 && id != null) {
    event.preventDefault();
    close(id);
  }
});

treeEl.addEventListener('contextmenu', (event) => {
  const id = rowIdAt(event.target);
  if (id == null) return;
  event.preventDefault();
  openTabMenu(id, event.clientX, event.clientY);
});

pinnedEl.addEventListener('click', (event) => {
  const el = event.target.closest('.pin');
  if (el) activate(Number(el.dataset.id));
});

pinnedEl.addEventListener('mousedown', (event) => {
  if (event.button === 1) event.preventDefault();
});

pinnedEl.addEventListener('auxclick', (event) => {
  const el = event.target.closest('.pin');
  if (event.button === 1 && el) close(Number(el.dataset.id));
});

pinnedEl.addEventListener('contextmenu', (event) => {
  const el = event.target.closest('.pin');
  if (!el) return;
  event.preventDefault();
  openTabMenu(Number(el.dataset.id), event.clientX, event.clientY);
});

newTabEl.addEventListener('click', () => chrome.tabs.create({ windowId }));

scrollerEl.addEventListener('dblclick', (event) => {
  if (event.target === scrollerEl) chrome.tabs.create({ windowId });
});

// ---- keyboard --------------------------------------------------------------------------

// The keys the tree handles (see below).
const TREE_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft', 'Enter', ' ', 'Delete', 'ContextMenu']);

treeEl.addEventListener('keydown', (event) => {
  if (!rows.length) return;
  const i = rows.findIndex((row) => row.id === focusedId);
  if (i < 0) {
    // The focused tab has no row (a search leaves it out, or it is pinned): the key only focuses a row, the one that
    // shows that tab or else the first, and acts on no tab the user did not see focused.
    if (!TREE_KEYS.has(event.key)) return;
    if (event.key === 'Home') setFocus(rows[0].id);
    else if (event.key === 'End') setFocus(rows.at(-1).id);
    else setFocus(rowFor(focusedId) ?? rows[0].id);
    event.preventDefault();
    treeEl.classList.add('keyboard');
    return;
  }
  const row = rows[i];
  const focusAt = (index) => setFocus(rows[Math.max(0, Math.min(rows.length - 1, index))].id);
  const filtering = !!filter.trim();

  switch (event.key) {
    case 'ArrowDown': focusAt(i + 1); break;
    case 'ArrowUp': focusAt(i - 1); break;
    case 'Home': focusAt(0); break;
    case 'End': focusAt(rows.length - 1); break;
    case 'ArrowRight':
      if (row.hasChildren && row.collapsed) setCollapsed(row.id, false);
      else if (row.hasChildren) focusAt(i + 1);
      break;
    case 'ArrowLeft': {
      const parent = forest.parentOf.get(row.id);
      if (row.hasChildren && !row.collapsed && !filtering) setCollapsed(row.id, true);
      else if (parent != null && rowsById.has(parent)) setFocus(parent);
      break;
    }
    case 'Enter':
    case ' ':
      activate(row.id);
      break;
    case 'Delete':
      close(row.id);
      focusAt(i + 1 < rows.length ? i + 1 : i - 1);
      break;
    case 'ContextMenu': {
      const rect = rowEls.get(row.id)?.getBoundingClientRect();
      if (rect) openTabMenu(row.id, rect.left + 32, rect.bottom);
      break;
    }
    default:
      return;
  }
  event.preventDefault();
  treeEl.classList.add('keyboard');
});

// ---- search ----------------------------------------------------------------------------

filterEl.addEventListener('input', () => {
  filter = filterEl.value;
  render();
});

filterEl.addEventListener('keydown', (event) => {
  const firstMatch = rows.find((row) => !row.dim);
  if (event.key === 'Escape' && filterEl.value) {
    filterEl.value = '';
    filter = '';
    render();
  } else if (event.key === 'Enter' && firstMatch) {
    activate(firstMatch.id);
  } else if (event.key === 'ArrowDown' && rows.length) {
    treeEl.focus();
    treeEl.classList.add('keyboard');
    setFocus((firstMatch ?? rows[0]).id);
  } else {
    return;
  }
  event.preventDefault();
});

// ---- menus -----------------------------------------------------------------------------

function openTabMenu(id, x, y) {
  const tab = tabsById.get(id);
  if (!tab) return;
  const hasChildren = !!forest.children.get(id)?.length;
  const nested = forest.parentOf.get(id) != null;
  const collapsed = !!nodes[id]?.collapsed;
  const muted = !!tab.mutedInfo?.muted;
  openMenu(x, y, [
    !tab.pinned && ['New tab as child', () => send({ type: 'newChild', tabId: id })],
    ['Reload', () => chrome.tabs.reload(id)],
    ['Duplicate', () => send({ type: 'duplicate', tabId: id })],
    [tab.pinned ? 'Unpin' : 'Pin', () => chrome.tabs.update(id, { pinned: !tab.pinned })],
    [muted ? 'Unmute' : 'Mute', () => chrome.tabs.update(id, { muted: !muted })],
    '-',
    ...groupItems(id),
    hasChildren && [collapsed ? 'Expand tree' : 'Collapse tree', () => setCollapsed(id, !collapsed)],
    nested && ['Move to top level', () => send({ type: 'makeTopLevel', tabId: id })],
    [hasChildren ? 'Move tree to new window' : 'Move to new window', () => send({ type: 'moveToNewWindow', tabId: id })],
    '-',
    hasChildren && ['Close children', () => send({ type: 'closeChildren', tabId: id })],
    hasChildren && ['Close tree', () => send({ type: 'closeTree', tabId: id })],
    ['Close tab', () => close(id)],
  ], id);
}

function rootOf(id) {
  let root = id;
  while (forest.parentOf.get(root) != null) root = forest.parentOf.get(root);
  return root;
}

/**
 * The menu's items for the tab group of the unit that `id` is in (see groups.js): the group's name
 * (empty for the automatic one), its colour, and whether the unit is grouped at all. A tab in no unit
 * gets the colours of its tree, if it is in one.
 */
function groupItems(id) {
  const unit = units.find((u) => u.tabs.includes(id));
  const color = unit ? unitColorMap.get(unit.head) : rowsById.get(id)?.color;
  if (!unit) return [color && colorSwatches(id, color)];
  const mine = heldBack(unit);
  return [
    !unit.optedOut && !mine && nameField(unit.head),
    color && (isNested(forest, unit) ? colorSwatches(id, color, unit.head) : colorSwatches(id, color)),
    !mine && [unit.optedOut ? 'Group in tab strip' : 'Ungroup in tab strip',
      () => send({ type: 'setNoGroup', tabId: unit.head, noGroup: !unit.optedOut })],
  ];
}

/**
 * Whether a group of the user's own holds a unit back from having one (their groups are left alone: see planGroups),
 * so that its name and "Ungroup" would do nothing to be seen. The group the unit's head is in does not, if the worker
 * is to take it over: it holds just the unit's tabs, all of them (or, after a reload, any of them).
 */
function heldBack(unit) {
  if (settings.ownGroups !== 'leave') return false;
  const ours = new Set(Object.keys(owned).map(Number));
  const theirs = (group) => group !== -1 && group != null && !ours.has(group);
  const head = tabsById.get(unit.head)?.groupId;
  const inHead = theirs(head) ? tabs.filter((t) => t.groupId === head).map((t) => t.id) : [];
  const takeable = inHead.length > 0 && inHead.every((t) => unit.tabs.includes(t))
    && (inHead.length === unit.tabs.length || !!nodes[unit.head]?.hadGroup);
  return unit.tabs.some((t) => {
    const group = tabsById.get(t)?.groupId;
    return theirs(group) && !(takeable && group === head);
  });
}

/**
 * A field for the name of the group that `head` heads: Enter (or leaving the field) keeps what was
 * typed, Esc does not, and an empty name brings back the automatic one, which it shows meanwhile.
 */
function nameField(head) {
  const label = document.createElement('label');
  label.className = 'group-field';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 200;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.value = nodes[head]?.groupName ?? '';
  input.placeholder = autoName(tabsById.get(head)) || 'Group name';
  input.setAttribute('aria-label', 'Group name');
  input.dir = 'auto';
  let saved = nodes[head]?.groupName ?? '';
  let cancelled = false;
  const keep = () => {
    const name = input.value.trim();
    if (cancelled || name === saved) return;
    saved = name;
    send({ type: 'setGroupName', tabId: head, name });
  };
  input.addEventListener('change', keep);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      keep();
      closeMenu();
    } else if (event.key === 'Escape') {
      cancelled = true;
      closeMenu();
    } else if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      event.stopPropagation(); // the field's own keys: Home, End, ← and → move in it
      return;
    }
    event.preventDefault();
    if (event.key === 'Enter' || event.key === 'Escape') event.stopPropagation();
  });
  label.append(input);
  return label;
}

/**
 * The tree colours as a row of swatches, like the colours of a tab group; one recolours the tree, or
 * with `unitHead` the tab group unit it heads (mode 'innermost', below the top level).
 */
function colorSwatches(id, current, unitHead = null) {
  const tree = subtree(forest, rootOf(id));
  const row = document.createElement('div');
  row.className = 'swatches';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', unitHead == null ? 'Tree colour' : 'Group colour');
  for (const color of TREE_COLORS) {
    const name = color[0].toUpperCase() + color.slice(1);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.title = name;
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-label', name);
    button.setAttribute('aria-checked', String(color === current));
    button.style.setProperty('--swatch', `var(--tree-${color}-0)`);
    button.addEventListener('click', () => {
      closeMenu();
      if (unitHead != null) {
        send({ type: 'setGroupColor', tabId: unitHead, color });
        return;
      }
      // The tree as it is now: should its top tab have closed while the menu was open, the tree
      // that this tab is in, or else the first one that a tab of the tree heads now.
      const root = [id, ...tree].filter((t) => forest.parentOf.has(t)).map(rootOf).find((r) => forest.children.has(r));
      if (root == null) return; // no tab of it heads a tree any more
      const entry = arriving.get(root);
      if (entry) {
        entry.picked = color; // a picked colour is final, however the tree got here
        scheduleUpdate();
      }
      send({ type: 'setTreeColor', tabId: root, color });
    });
    row.append(button);
  }
  return row;
}

moreEl.addEventListener('click', () => {
  const rect = moreEl.getBoundingClientRect();
  openMenu(rect.right, rect.bottom + 4, [
    ['Collapse all', () => send({ type: 'setAllCollapsed', windowId, collapsed: true })],
    ['Expand all', () => send({ type: 'setAllCollapsed', windowId, collapsed: false })],
    '-',
    ['Settings…', () => chrome.runtime.openOptionsPage()],
    ['Keyboard shortcut…', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })],
  ]);
});

/**
 * items: [label, action] pairs, elements, '-' for a separator; falsy items are skipped. A menu
 * for a tab (`tabId`) closes when the tab closes.
 */
function openMenu(x, y, items, tabId = null) {
  menuTabId = tabId;
  menuEl.replaceChildren();
  let separator = false;
  for (const item of items) {
    if (!item) continue;
    if (item === '-') {
      separator = menuEl.childElementCount > 0;
      continue;
    }
    if (separator) {
      menuEl.append(document.createElement('hr'));
      separator = false;
    }
    if (item instanceof Element) {
      menuEl.append(item);
      continue;
    }
    const [label, action] = item;
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    button.addEventListener('click', () => {
      closeMenu();
      action();
    });
    menuEl.append(button);
  }
  menuEl.hidden = false;
  const { width, height } = menuEl.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, innerWidth - width - 4));
  const top = y + height > innerHeight - 4 ? Math.max(4, y - height) : y;
  menuEl.style.left = `${left}px`;
  menuEl.style.top = `${top}px`;
  menuEl.querySelector('button:not(.swatch)')?.focus();
}

function closeMenu() {
  menuTabId = null;
  if (menuEl.hidden) return;
  const hadFocus = menuEl.contains(document.activeElement);
  menuEl.hidden = true;
  if (hadFocus) treeEl.focus();
}

menuEl.addEventListener('keydown', (event) => {
  // The colour swatches are one stop for ↑ ↓ (the checked one); ← → move between them.
  const buttons = [...menuEl.querySelectorAll('input, button:not(.swatch), .swatch[aria-checked="true"]')];
  const swatch = document.activeElement?.closest('.swatch');
  const i = buttons.indexOf(swatch ? menuEl.querySelector('.swatch[aria-checked="true"]') : document.activeElement);
  if (swatch && event.key === 'ArrowLeft') swatch.previousElementSibling?.focus();
  else if (swatch && event.key === 'ArrowRight') swatch.nextElementSibling?.focus();
  else if (event.key === 'Escape') closeMenu();
  else if (event.key === 'ArrowDown') buttons[(i + 1) % buttons.length]?.focus();
  else if (event.key === 'ArrowUp') buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
  else if (event.key === 'Home') buttons[0]?.focus();
  else if (event.key === 'End') buttons.at(-1)?.focus();
  else return;
  event.preventDefault();
});

menuEl.addEventListener('focusout', (event) => {
  if (!menuEl.contains(event.relatedTarget)) closeMenu();
});

document.addEventListener('mousedown', (event) => {
  if (!menuEl.contains(event.target)) closeMenu();
}, true);

window.addEventListener('blur', closeMenu);
window.addEventListener('resize', () => {
  closeMenu();
  render();
});
scrollerEl.addEventListener('scroll', closeMenu, { passive: true });

// ---- drag and drop ---------------------------------------------------------------------
// Drop on the top quarter of a tab: before it. Bottom quarter: after it (as its first child
// when its children are showing). The middle: as its last child. Below the list: the end.

treeEl.addEventListener('dragstart', (event) => {
  const id = rowIdAt(event.target);
  if (id == null) return;
  const tab = tabsById.get(id);
  drag = { tabId: id, block: new Set(subtree(forest, id)) };
  closeMenu();
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ tabId: id }));
  if (tab?.url) {
    event.dataTransfer.setData('text/uri-list', tab.url);
    event.dataTransfer.setData('text/plain', tab.url);
  }
  rowEls.get(id)?.classList.add('dragging');
});

treeEl.addEventListener('dragend', () => {
  drag = null;
  for (const el of treeEl.querySelectorAll('.dragging')) el.classList.remove('dragging');
  showDrop(null);
});

scrollerEl.addEventListener('dragover', (event) => {
  if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
  const target = dropTarget(event);
  showDrop(target);
  if (!target) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
});

scrollerEl.addEventListener('dragleave', (event) => {
  if (!scrollerEl.contains(event.relatedTarget)) showDrop(null);
});

scrollerEl.addEventListener('drop', (event) => {
  const target = dropTarget(event);
  showDrop(null);
  if (!target || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
  event.preventDefault();
  let dragged;
  try {
    dragged = JSON.parse(event.dataTransfer.getData(DRAG_TYPE));
  } catch {
    return;
  }
  send({ type: 'move', tabId: dragged.tabId, windowId, targetId: target.targetId, position: target.position });
});

function dropTarget(event) {
  if (filter.trim()) return null; // the filtered view hides parts of the tree
  const id = rowIdAt(event.target);
  if (id == null) {
    const below = event.target === scrollerEl || event.target === treeEl || newTabEl.contains(event.target);
    return below ? { targetId: null, position: 'end' } : null;
  }
  if (drag?.block.has(id)) return null;
  const row = rowsById.get(id);
  const rect = rowEls.get(id).getBoundingClientRect();
  const y = (event.clientY - rect.top) / rect.height;
  if (y < 0.25) return { targetId: id, position: 'before' };
  if (y > 0.75) return { targetId: id, position: row?.hasChildren && !row.collapsed ? 'firstChild' : 'afterTree' };
  return { targetId: id, position: 'lastChild' };
}

function showDrop(target) {
  dropRow?.classList.remove('drop-into');
  dropRow = null;
  dropLineEl.hidden = true;
  if (!target) return;
  if (target.position === 'lastChild') {
    dropRow = rowEls.get(target.targetId) ?? null;
    dropRow?.classList.add('drop-into');
    return;
  }
  let top = 0;
  let depth = 0;
  if (target.position === 'end') {
    const last = treeEl.lastElementChild;
    if (last) top = last.offsetTop + last.offsetHeight;
  } else {
    const el = rowEls.get(target.targetId);
    const row = rowsById.get(target.targetId);
    if (!el || !row) return;
    top = target.position === 'before' ? el.offsetTop : el.offsetTop + el.offsetHeight;
    depth = row.depth + (target.position === 'firstChild' ? 1 : 0);
  }
  dropLineEl.style.top = `${top - 1}px`;
  dropLineEl.style.left = `${16 + depth * indent}px`; // the guide line of that depth
  dropLineEl.hidden = false;
}

// ---- start -----------------------------------------------------------------------------

const [initialTabs, stored, local] = await Promise.all([
  chrome.tabs.query({ windowId }),
  chrome.storage.session.get('tree'),
  chrome.storage.local.get('settings'),
]);
tabs = initialTabs;
settings = readSettings(local.settings);
if (!nodesFromEvent) readTree(stored.tree);
render();
send({ type: 'ping' }); // wakes the worker, which loads or restores the tree
