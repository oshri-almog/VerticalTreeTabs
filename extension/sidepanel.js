// Side panel: draws this window's tabs as a tree. It reads the tree the service worker keeps
// in chrome.storage.session and asks the worker for every change to it; plain tab actions
// (activate, close, reload, pin, mute) go straight to chrome.tabs.

import { buildForest, flatten, rememberColor, shadeOf, subtree, TREE_COLORS, treeColors } from './tree.js';
import { autoName, groupUnits, isNested, readSettings, unitColors, unitTitle } from './groups.js';
import { makeSearch } from './search.js';
import { FOLDER_ICONS, FOLDER_PAGE, parseFolder, wholePrefix } from './folders.js';

// A folder tab's page (see folders.js), without its parameters.
const folderBase = chrome.runtime.getURL(FOLDER_PAGE);
/** The folder that tab `tab` is ({ id, name, icon }), or null. */
const folderOf = (tab) => (tab ? parseFolder(tab.url || tab.pendingUrl, folderBase) : null);
/** A tab as a search sees it: a folder by its name. */
const searchable = (tab) => {
  const folder = folderOf(tab);
  return folder ? { ...tab, title: folder.name, url: '', pendingUrl: '' } : tab;
};

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
const findEl = document.getElementById('find');
const dialogEl = document.getElementById('dialog');
const toastEl = document.getElementById('toast');
// The most a level of the tree indents (the setting `indent`), less when the tree gets deep.
const INDENTS = { narrow: 10, normal: 16, wide: 24 };
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
let otherWindows = []; // the other windows a tree can move to: [{ id, title, count }], see refreshWindows
const rowEls = new Map();
const pinEls = new Map();
const unplacedSince = new Map(); // tab id -> when it was first seen without a node
const arriving = new Map(); // tab dragged in from another window -> { picked }, see onAttached below

// ---- data ------------------------------------------------------------------------------

async function send(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) {
      console.error('[tree-tabs]', message.type, response?.error);
      if (message.type !== 'ping') showToast(`That did not work: ${response?.error ?? 'no answer from the extension'}`);
    }
    return response?.result;
  } catch (error) {
    console.error('[tree-tabs]', message.type, error);
  }
}

/** A short notice at the bottom of the panel, for a few seconds. */
let toastTimer = null;
function showToast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 5000);
}
toastEl.addEventListener('click', () => { toastEl.hidden = true; });
/** For a browser call the panel makes itself: a notice when it fails. */
const failed = (error) => showToast(`That did not work: ${error?.message ?? error}`);

/**
 * Whether to close `count` tabs at once: at once below the setting confirmClose, else as the user answers in the dialog
 * (`text`; Enter or the Close button closes, Esc or Cancel does not).
 */
let pendingConfirm = null; // the answer of the dialog that is open, if one is
function confirmClose(count, text) {
  const from = Number(settings.confirmClose);
  if (!(count >= from)) return Promise.resolve(true);
  pendingConfirm?.(false); // a question asked again: the one before it is answered no
  closeMenu();
  const back = document.activeElement;
  document.getElementById('dialog-text').textContent = text;
  const ok = document.getElementById('dialog-ok');
  const cancel = document.getElementById('dialog-cancel');
  ok.textContent = `Close ${count} tabs`;
  dialogEl.hidden = false;
  ok.focus();
  const behind = [...document.body.children].filter((el) => el !== dialogEl && !el.inert);
  for (const el of behind) el.inert = true;
  return new Promise((resolve) => {
    const done = (answer) => {
      if (pendingConfirm !== done) return;
      pendingConfirm = null;
      dialogEl.hidden = true;
      for (const el of behind) el.inert = false;
      ok.removeEventListener('click', yes);
      cancel.removeEventListener('click', no);
      document.removeEventListener('keydown', key, true);
      dialogEl.removeEventListener('mousedown', outside);
      back?.focus?.();
      resolve(answer);
    };
    pendingConfirm = done;
    const yes = () => done(true);
    const no = () => done(false);
    const key = (event) => {
      event.stopPropagation(); // the panel's own keys wait until the dialog is answered
      if (event.key === 'Escape') no();
      else if (event.key === 'Enter') (document.activeElement === cancel ? no : yes)();
      else if (event.key === 'Tab') (document.activeElement === ok ? cancel : ok).focus();
      else if (event.key === ' ' && (document.activeElement === ok || document.activeElement === cancel)) return;
      event.preventDefault();
    };
    const outside = (event) => {
      if (event.target === dialogEl) no();
    };
    ok.addEventListener('click', yes);
    cancel.addEventListener('click', no);
    document.addEventListener('keydown', key, true);
    dialogEl.addEventListener('mousedown', outside);
  });
}

const tabsWord = (n) => `${n} ${n === 1 ? 'tab' : 'tabs'}`;

/** Close tab `id` and the tabs under it (`withSelf` false: those only), once confirmClose says so. */
async function closeTreeOf(id, withSelf = true) {
  const ids = subtree(forest, id);
  const count = withSelf ? ids.length : ids.length - 1;
  const title = clip(folderOf(tabsById.get(id))?.name ?? (tabsById.get(id)?.title || 'this tab'), 40);
  const text = withSelf ? `Close “${title}” and the ${tabsWord(count - 1)} under it?` : `Close the ${tabsWord(count)} under “${title}”?`;
  if (await confirmClose(count, text)) send({ type: withSelf ? 'closeTree' : 'closeChildren', tabId: id });
}

// ---- selection: the tabs selected in the tab strip (highlighted), which the panel selects too ----

let anchorId = null; // where a Shift+click range starts: the tab last clicked

/** The selected tabs of this window, in strip order (the active tab is one of them). */
const selectedIds = () => tabs.filter((tab) => tab.highlighted).sort((a, b) => a.index - b.index).map((tab) => tab.id);

/** Select the tabs `ids` (and the active tab, which stays the active one) in the tab strip. */
function select(ids) {
  const active = tabs.find((tab) => tab.active);
  const chosen = [active, ...[...ids].filter((id) => id !== active?.id).map((id) => tabsById.get(id))].filter(Boolean);
  if (chosen.length) chrome.tabs.highlight({ windowId, tabs: chosen.map((tab) => tab.index) }).catch(() => {});
}

/** Ctrl+click: the tab in or out of the selection (not the active tab, which is always in it). */
function toggleSelected(id) {
  anchorId = id;
  if (tabsById.get(id)?.active) return;
  const ids = new Set(selectedIds());
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  select(ids);
}

/** Shift+click: the rows from the last one clicked (or the active tab) to this one, as they show. */
function selectRange(id) {
  const from = rows.findIndex((row) => row.id === (anchorId ?? tabs.find((tab) => tab.active)?.id));
  const to = rows.findIndex((row) => row.id === id);
  if (from < 0 || to < 0) {
    toggleSelected(id);
    return;
  }
  select(rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((row) => row.id));
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
    const [found, groups] = await Promise.all([
      chrome.tabs.query({ windowId }),
      chrome.tabGroups.query({ windowId }).catch(() => []),
    ]);
    tabs = found;
    allGroups = new Map(groups.map((group) => [group.id, group]));
    const now = Date.now();
    let fresh = false;
    for (const group of groups) {
      if (!groupSeen.has(group.id)) groupSeen.set(group.id, now);
      if (now - groupSeen.get(group.id) < GROUP_GRACE_MS) fresh = true;
    }
    for (const id of groupSeen.keys()) if (!allGroups.has(id)) groupSeen.delete(id);
    if (fresh) setTimeout(scheduleUpdate, GROUP_GRACE_MS); // drawn once the moment has passed
    render();
  } finally {
    updating = false;
  }
}

let allGroups = new Map(); // this window's tab groups: id -> { title, color, collapsed }
let firstOfGroup = new Map(); // a user's group -> its first row (see renderRows)
/** The tab group of the user's own (one the worker did not make or take over) that tab `tab` is in, or null. */
const userGroupOf = (tab) => {
  if (!tab || tab.groupId === -1 || owned[tab.groupId] != null) return null;
  const group = allGroups.get(tab.groupId);
  return group && Date.now() - (groupSeen.get(group.id) ?? 0) >= GROUP_GRACE_MS ? group : null;
};
const groupSeen = new Map(); // group id -> when the panel first saw it (those there at its start: long ago)
const GROUP_GRACE_MS = 300; // the worker writes the groups it makes a moment after the browser tells of them
for (const event of [chrome.tabGroups.onCreated, chrome.tabGroups.onUpdated, chrome.tabGroups.onRemoved, chrome.tabGroups.onMoved]) {
  event.addListener((group) => {
    if (group.windowId === windowId) scheduleUpdate();
  });
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
  applyLook(settings);
  scheduleUpdate();
});

/**
 * How the panel looks, as the settings say: theme, row height, text size and indent, as attributes of the page that
 * sidepanel.css styles. Kept for look.js too, which sets them before the panel is first drawn.
 */
function applyLook({ theme, density, textSize, indent: most, unread, searchBox }) {
  const root = document.documentElement.dataset;
  Object.assign(root, { theme, density, textSize, indent: most, unread, searchBox });
  try {
    localStorage.setItem('look', JSON.stringify({ theme, density, textSize, indent: most, unread, searchBox }));
  } catch {
    // no storage for this page: the look comes a moment later, from the settings
  }
}

/** The other windows of this window's kind (incognito or not), for the menu's "Move tree to". */
let windowsQueued = null;
function refreshWindows() {
  clearTimeout(windowsQueued);
  windowsQueued = setTimeout(async () => {
    const all = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }).catch(() => null);
    const here = all?.find((win) => win.id === windowId);
    if (!all || !here) return;
    otherWindows = all.filter((win) => win.id !== windowId && win.incognito === here.incognito).map((win) => ({
      id: win.id,
      title: (win.tabs.find((tab) => tab.active)?.title || 'New Tab').trim(),
      count: win.tabs.length,
    }));
  }, 300);
}
chrome.windows.onCreated.addListener(refreshWindows);
chrome.windows.onRemoved.addListener(refreshWindows);
chrome.tabs.onActivated.addListener((info) => info.windowId !== windowId && refreshWindows());
chrome.tabs.onUpdated.addListener((id, change, tab) => tab.windowId !== windowId && 'title' in change && tab.active && refreshWindows());
chrome.tabs.onAttached.addListener(refreshWindows);
chrome.tabs.onDetached.addListener(refreshWindows);

function readTree(tree) {
  nodes = tree?.nodes ?? {};
  owned = tree?.groups ?? {};
  const out = tree?.leaving;
  leaving = out && out.windowId !== windowId ? new Set(out.tabs) : null;
}

// ---- rendering -------------------------------------------------------------------------

function render() {
  newTabEl.hidden = settings.newTabButton === 'hidden';
  const focusedAt = rows.findIndex((row) => row.id === focusedId); // in the rows as last drawn
  tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  if (menuTabId != null && !tabsById.has(menuTabId)) closeMenu(); // its tab closed or left
  forest = buildForest(placedTabs(), nodes);
  // The search box: its words, or a regular expression (the .* button); one that is none filters nothing.
  const search = makeSearch(filter, regexOn);
  const query = search ? `${regexOn ? 're' : 'words'}:${filter.trim()}` : '';
  filterEl.classList.toggle('invalid', !!search?.invalid);
  filterEl.title = search?.slow ? 'This pattern could take very long: it is not used' : search?.invalid ? 'Not a regular expression' : '';
  const matches = search && !search.invalid
    ? new Set(tabs.filter((tab) => !tab.pinned && search.test(searchable(tab), groupNameOf(tab))).map((tab) => tab.id))
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
  renderRows(query, search?.invalid ? null : search);
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

/** The name of the tab group the worker made for the tab's unit, which a search finds the tab by too ('' if none). */
function groupNameOf(tab) {
  const head = owned[tab.groupId];
  return head == null ? (userGroupOf(tab)?.title ?? '') : unitTitle(nodes, head, tabsById.get(head));
}

function renderRows(query, search) {
  // Indent less when the tree gets deep, so titles keep room in a narrow panel.
  const deepest = rows.reduce((max, row) => Math.max(max, row.depth), 0);
  const most = INDENTS[settings.indent] ?? INDENTS.normal;
  indent = deepest ? Math.max(Math.min(6, most), Math.min(most, Math.floor((treeEl.clientWidth * 0.4) / deepest))) : most;
  treeEl.style.setProperty('--indent', `${indent}px`);

  // The first row of each tab group of the user's own, as the rows show: it gets the group's name (see paintRow).
  firstOfGroup = new Map();
  for (const row of rows) {
    const tab = tabsById.get(row.id);
    if (userGroupOf(tab) && !firstOfGroup.has(tab.groupId)) firstOfGroup.set(tab.groupId, row.id);
  }

  let cursor = treeEl.firstElementChild;
  for (const [i, row] of rows.entries()) {
    let el = rowEls.get(row.id);
    if (!el) {
      el = rowTemplate.cloneNode(true);
      el.dataset.id = row.id;
      el.id = `tab-${row.id}`;
      el.querySelector('.favicon').addEventListener('error', () => faviconFailed(el));
      rowEls.set(row.id, el);
      // A row that comes once the panel is drawn eases in (not under the system's reduced motion: see sidepanel.css).
      if (drawnOnce) {
        el.classList.add('entering');
        el.addEventListener('animationend', () => el.classList.remove('entering'), { once: true });
      }
    }
    paintRow(el, row, tabsById.get(row.id), query, search);
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
  if (rows.length) drawnOnce = true;
}
let drawnOnce = false; // the panel has drawn its rows once: rows that come later ease in

function paintRow(el, row, tab, query, search) {
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
  const folder = folderOf(tab);
  classes.toggle('folder', !!folder);
  classes.toggle('unread', !!nodes[row.id]?.unread && !tab.active);
  paintColor(el, row);

  // A tab group of the user's own: a band in its colour on its tabs.
  const theirs = userGroupOf(tab);
  classes.toggle('in-group', !!theirs);
  if (theirs) el.style.setProperty('--group', `var(--tree-${theirs.color}-0)`);
  else el.style.removeProperty('--group');
  // The name of the tab group it heads, once the worker has made the group; or of the user's own group it is the first
  // tab of, as the panel shows them.
  const headOfTheirs = !!theirs && firstOfGroup.get(tab.groupId) === row.id;
  const name = Object.values(owned).includes(row.id) ? unitTitle(nodes, row.id, tab)
    : headOfTheirs ? theirs.title || 'Group' : '';
  const pill = el.querySelector('.group-name');
  pill.classList.toggle('theirs', headOfTheirs);
  if (pill.textContent !== name) {
    pill.textContent = name;
    if (name) el.setAttribute('aria-description', `Tab group ${name}`);
    else el.removeAttribute('aria-description');
  }
  pill.hidden = !name;

  const title = folder ? folder.name : tab.title || tab.url || 'New Tab';
  const titleKey = `${title}\u0000${query}\u0000${query ? tab.url || tab.pendingUrl : ''}`;
  if (el.dataset.titleKey !== titleKey) {
    el.dataset.titleKey = titleKey;
    setTitle(el.querySelector('.title'), title, search);
    // Only its address matched (the title alone does not): the address shows, marked.
    const url = el.querySelector('.url');
    const address = (tab.url || tab.pendingUrl || '').replace(/^https?:\/\/(www\.)?/, '');
    const shown = !!search && !folder && !!address && !search.test({ title }, '') && search.spans(address).length > 0;
    url.hidden = !shown;
    if (shown) setTitle(url, address, search);
    else url.textContent = '';
  }
  const tooltip = !folder && tab.url && tab.url !== title ? `${title}\n${tab.url}` : title;
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

/** The title, with the words of the search marked in it (see matchSpans). */
function setTitle(span, title, search) {
  const spans = search && title.toLowerCase().length === title.length ? search.spans(title) : [];
  if (!spans.length) {
    span.textContent = title;
    return;
  }
  span.textContent = '';
  let from = 0;
  for (const [start, end] of spans) {
    const mark = document.createElement('mark');
    mark.textContent = title.slice(start, end);
    span.append(title.slice(from, start), mark);
    from = end;
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
      el.draggable = true; // to reorder the pinned tabs (see the pinned drag below)
      el.innerHTML = '<span class="icon"><img class="favicon" alt="" draggable="false"><span class="emoji" aria-hidden="true"></span>'
        + '<span class="spinner"></span></span>';
      el.querySelector('.favicon').addEventListener('error', () => faviconFailed(el));
      pinEls.set(id, el);
    }
    el.classList.toggle('active', !!tab.active);
    el.classList.toggle('loading', tab.status === 'loading');
    el.title = folderOf(tab)?.name ?? (tab.title || tab.url || '');
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

/** The icon for a page that gives none: a gear for the browser's own pages (not a New Tab page), a puzzle piece for an extension's. */
function pageGlyph(url) {
  if (!url || /^(chrome|edge):\/\/(newtab|new-tab-page)\/?$/.test(url)) return '';
  if (/^(chrome|edge|about|brave|opera|vivaldi):/i.test(url)) return '⚙️';
  if (/^chrome-extension:/i.test(url)) return '🧩';
  return '';
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
  // A folder's icon is its emoji, from its URL: there whether its page has loaded or not.
  const folder = folderOf(tab);
  el.classList.toggle('folder', !!folder);
  if (folder) {
    const emoji = el.querySelector('.emoji');
    if (emoji.textContent !== folder.icon) emoji.textContent = folder.icon;
    return;
  }
  const pageUrl = tab.url || tab.pendingUrl;
  const own = tab.favIconUrl && /^(https?|data):/.test(tab.favIconUrl) ? tab.favIconUrl : '';
  // A page that gives no icon of its own: the browser's own pages and other extensions' get one that says so.
  const glyph = own ? '' : pageGlyph(pageUrl);
  el.classList.toggle('glyph', !!glyph);
  if (glyph) {
    const emoji = el.querySelector('.emoji');
    if (emoji.textContent !== glyph) emoji.textContent = glyph;
    return;
  }
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
  const modified = event.ctrlKey || event.metaKey;
  if (event.target.closest('.close')) {
    // Ctrl+click on ×: the tab and the tabs under it.
    if (modified && forest.children.get(id)?.length) closeTreeOf(id);
    else close(id);
  } else if (event.target.closest('.audio')) toggleMute(id);
  else if (event.target.closest('.add')) send({ type: 'newTabIn', tabId: id, first: modified });
  else if (event.target.closest('.twisty') && row?.hasChildren && !filter.trim()) setCollapsed(id, !row.collapsed);
  else if (modified) toggleSelected(id);
  else if (event.shiftKey) selectRange(id);
  else if (settings.clickToFold === 'click' && tabsById.get(id)?.active && row?.hasChildren && !filter.trim()
    && selectedIds().length < 2) {
    // A click on the active tab's own row folds the tabs under it (the setting clickToFold).
    anchorId = id;
    setFocus(id);
    setCollapsed(id, !row.collapsed);
  } else {
    anchorId = id;
    setFocus(id); // at once: a click on the active tab's row brings no tab event, and so no redraw
    // Switching tabs ends a selection; a click on the active tab's own row ends it too.
    if (tabsById.get(id)?.active && selectedIds().length > 1) select([]);
    activate(id);
  }
});

treeEl.addEventListener('mousedown', (event) => {
  treeEl.classList.remove('keyboard');
  if (event.button === 1) event.preventDefault(); // no autoscroll on middle click
});

treeEl.addEventListener('auxclick', (event) => {
  const id = rowIdAt(event.target);
  if (event.button !== 1 || id == null) return;
  event.preventDefault();
  if (event.target.closest('.add')) send({ type: 'newTabIn', tabId: id, first: event.ctrlKey || event.metaKey });
  else close(id);
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

// A pinned tab dragged onto another: before it (its left half) or after it (its right half), among the pinned tabs.
const PIN_TYPE = 'application/x-tree-tabs-pinned';
const clearPinDrop = () => {
  for (const el of pinnedEl.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
};
const pinDropAfter = (el, event) => {
  const rect = el.getBoundingClientRect();
  return event.clientX >= rect.left + rect.width / 2;
};
pinnedEl.addEventListener('dragstart', (event) => {
  const el = event.target.closest('.pin');
  if (!el) return;
  const tab = tabsById.get(Number(el.dataset.id));
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(PIN_TYPE, el.dataset.id);
  if (tab?.url) {
    event.dataTransfer.setData('text/uri-list', tab.url);
    event.dataTransfer.setData('text/plain', tab.url);
  }
});
pinnedEl.addEventListener('dragover', (event) => {
  if (!event.dataTransfer.types.includes(PIN_TYPE)) return;
  const el = event.target.closest('.pin');
  clearPinDrop();
  if (!el) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  el.classList.add(pinDropAfter(el, event) ? 'drop-after' : 'drop-before');
});
pinnedEl.addEventListener('dragleave', (event) => {
  if (!pinnedEl.contains(event.relatedTarget)) clearPinDrop();
});
pinnedEl.addEventListener('drop', (event) => {
  const el = event.target.closest('.pin');
  clearPinDrop();
  if (!el || !event.dataTransfer.types.includes(PIN_TYPE)) return;
  event.preventDefault();
  const tab = tabsById.get(Number(event.dataTransfer.getData(PIN_TYPE)));
  const target = tabsById.get(Number(el.dataset.id));
  if (!tab || !target || tab.id === target.id || !tab.pinned) return;
  let index = target.index + (pinDropAfter(el, event) ? 1 : 0);
  if (tab.index < index) index -= 1; // moved to the right, it leaves its place first
  if (index !== tab.index) chrome.tabs.move(tab.id, { index }).catch((error) => showToast(`That did not work: ${error.message}`));
});
pinnedEl.addEventListener('dragend', clearPinDrop);

pinnedEl.addEventListener('contextmenu', (event) => {
  const el = event.target.closest('.pin');
  if (!el) return;
  event.preventDefault();
  openTabMenu(Number(el.dataset.id), event.clientX, event.clientY);
});

/**
 * A new tab from the New tab button, or a middle-click or double-click below the list: where the setting newTabButton
 * says (the end of the window, or after the active tab's tree), or, with a key held, by the active tab: Shift its first
 * child, Ctrl (⌘) its last, Alt next to it.
 */
function newTabFrom(event) {
  const where = event.shiftKey ? 'firstChild'
    : event.ctrlKey || event.metaKey ? 'child'
      : event.altKey ? 'sibling'
        : settings.newTabButton === 'afterTree' ? 'afterTree' : 'end';
  send({ type: 'newTabAt', windowId, where });
}

newTabEl.addEventListener('click', newTabFrom);
newTabEl.title = 'New tab. Shift: as the first child of the active tab; Ctrl: as its last child; Alt: next to it';

const belowList = (target) => target === scrollerEl || target === treeEl || target === emptyEl;
scrollerEl.addEventListener('dblclick', (event) => {
  if (belowList(event.target)) newTabFrom(event);
});
scrollerEl.addEventListener('mousedown', (event) => {
  if (event.button === 1 && belowList(event.target)) event.preventDefault(); // no autoscroll
});
scrollerEl.addEventListener('auxclick', (event) => {
  if (event.button === 1 && belowList(event.target)) {
    event.preventDefault();
    newTabFrom(event);
  }
});

// A double-click on a row that has tabs under it folds them (the setting clickToFold 'double'; its first click
// switched to the tab).
treeEl.addEventListener('dblclick', (event) => {
  const id = rowIdAt(event.target);
  const row = id == null ? null : rowsById.get(id);
  if (settings.clickToFold !== 'double' || !row?.hasChildren || filter.trim()) return;
  if (event.target.closest('button, .twisty')) return;
  setCollapsed(id, !row.collapsed);
});

// ---- keyboard --------------------------------------------------------------------------

// The keys the tree handles (see below).
const TREE_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft', 'Enter', ' ', 'Delete', 'ContextMenu']);

treeEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && selectedIds().length > 1) {
    select([]); // the selection ends, whichever row has the focus
    event.preventDefault();
    return;
  }
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

// The .* button: the search is a regular expression (kept for this browser's panels).
const regexEl = document.getElementById('regex');
let regexOn = false;
try {
  regexOn = localStorage.getItem('regex') === '1';
} catch {
  // no storage for this page
}
regexEl.setAttribute('aria-pressed', String(regexOn));
regexEl.addEventListener('mousedown', (event) => event.preventDefault()); // the field keeps the focus
regexEl.addEventListener('click', () => {
  regexOn = !regexOn;
  regexEl.setAttribute('aria-pressed', String(regexOn));
  try {
    localStorage.setItem('regex', regexOn ? '1' : '0');
  } catch {
    // kept for this panel only
  }
  render();
  filterEl.focus();
});

// With the setting searchBox 'hide', the search box shows on Ctrl+F (or /) in the panel, until it is left empty.
const searchEl = filterEl.closest('.search');
function showSearch() {
  searchEl.classList.add('shown');
  filterEl.focus();
  filterEl.select();
}
document.addEventListener('keydown', (event) => {
  if (!dialogEl.hidden) return; // the dialog has the keys (see confirmClose)
  const typing = event.target instanceof HTMLInputElement;
  const letter = event.key.length === 1 && /[a-z]/i.test(event.key) ? event.key.toLowerCase() : event.code === 'KeyF' ? 'f' : '';
  const find = letter === 'f' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
  if (find || (event.key === '/' && !typing)) {
    event.preventDefault();
    showSearch();
  }
});
filterEl.addEventListener('blur', (event) => {
  if (!filterEl.value && !searchEl.contains(event.relatedTarget)) searchEl.classList.remove('shown');
});

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
  // On a tab of a selection: the menu for all the selected tabs.
  const chosen = selectedIds();
  if (chosen.length > 1 && chosen.includes(id)) {
    openSelectionMenu(chosen, id, x, y);
    return;
  }
  const hasChildren = !!forest.children.get(id)?.length;
  const nested = forest.parentOf.get(id) != null;
  const collapsed = !!nodes[id]?.collapsed;
  const muted = !!tab.mutedInfo?.muted;
  const folder = folderOf(tab);
  // The folders it can go into: of this window, not its own parent, nor one in its own subtree.
  const own = new Set(tab.pinned ? [] : subtree(forest, id));
  const folders = tab.pinned ? [] : tabs.filter((t) => !t.pinned && !own.has(t.id) && t.id !== forest.parentOf.get(id) && folderOf(t))
    .sort((a, b) => a.index - b.index);
  const what = hasChildren ? 'Move tree' : 'Move';
  openMenu(x, y, [
    folder && folderNameField(id, folder),
    folder && folderIcons(id, folder),
    folder && !tab.pinned && ['New tab in folder', () => send({ type: 'newTabIn', tabId: id })],
    !folder && !tab.pinned && ['New tab as child', () => send({ type: 'newChild', tabId: id })],
    !tab.pinned && ['New tab below', () => send({ type: 'newTabAt', windowId, where: 'sibling', tabId: id })],
    !folder && ['Reload', () => chrome.tabs.reload(id)],
    !folder && ['Duplicate', () => send({ type: 'duplicate', tabId: id })],
    [tab.pinned ? 'Unpin' : 'Pin', () => chrome.tabs.update(id, { pinned: !tab.pinned })],
    !folder && [muted ? 'Unmute' : 'Mute', () => chrome.tabs.update(id, { muted: !muted })],
    '-',
    !tab.pinned && !tab.incognito && ['New folder', () => send({ type: 'newFolder', tabId: id })],
    !tab.pinned && !tab.incognito && [`${what} to new folder`, () => send({ type: 'moveToNewFolder', tabIds: [id] })],
    folders.length > 0 && {
      label: `${what} to folder`,
      items: folders.map((f) => [`${folderOf(f).icon}  ${clip(folderOf(f).name, 40)}`,
        () => send({ type: 'moveToFolder', tabIds: [id], folderId: f.id })]),
    },
    '-',
    ...groupItems(id),
    ...userGroupItems([id], tab),
    hasChildren && [collapsed ? 'Expand tree' : 'Collapse tree', () => setCollapsed(id, !collapsed)],
    nested && ['Move to top level', () => send({ type: 'makeTopLevel', tabId: id })],
    [hasChildren ? 'Move tree to new window' : 'Move to new window', () => send({ type: 'moveToNewWindow', tabId: id })],
    // To the end of another window's tree, as a drop below the list in that window's panel does.
    !tab.pinned && otherWindows.length > 0 && {
      label: `${hasChildren ? 'Move tree' : 'Move'} to window`,
      items: otherWindows.map((win) => [`“${clip(win.title, 40)}” (${tabsWord(win.count)})`,
        () => send({ type: 'move', tabId: id, windowId: win.id, targetId: null, position: 'end' })]),
    },
    '-',
    hasChildren && ['Close children', () => closeTreeOf(id, false)],
    hasChildren && ['Close tree', () => closeTreeOf(id)],
    closeGroupItem(id),
    ['Close tab', () => close(id)],
  ], id);
}

/**
 * The menu for the selected tabs `ids` (in strip order), opened on `id`, one of them: what the tab menu does, for all
 * of them. Moves take each with the tabs under it; a pinned tab stays where it is.
 */
function openSelectionMenu(ids, id, x, y) {
  const chosen = ids.map((i) => tabsById.get(i)).filter(Boolean);
  const allPinned = chosen.every((t) => t.pinned);
  const muted = !!tabsById.get(id)?.mutedInfo?.muted;
  const movable = chosen.filter((t) => !t.pinned).map((t) => t.id);
  const inside = new Set(movable.flatMap((i) => subtree(forest, i)));
  const folders = tabs.filter((t) => !t.pinned && !inside.has(t.id) && folderOf(t)).sort((a, b) => a.index - b.index);
  const label = document.createElement('div');
  label.className = 'menu-label';
  label.textContent = `${tabsWord(chosen.length)} selected`;
  openMenu(x, y, [
    label,
    ['Reload', () => chosen.forEach((t) => chrome.tabs.reload(t.id))],
    ['Duplicate', async () => {
      for (const t of chosen) await send({ type: 'duplicate', tabId: t.id });
    }],
    [allPinned ? 'Unpin' : 'Pin', () => chosen.forEach((t) => chrome.tabs.update(t.id, { pinned: !allPinned }))],
    [muted ? 'Unmute' : 'Mute', () => chosen.forEach((t) => chrome.tabs.update(t.id, { muted: !muted }))],
    '-',
    ...userGroupItems(ids, tabsById.get(id)),
    '-',
    movable.length && !chosen[0]?.incognito && ['Move to new folder', () => send({ type: 'moveToNewFolder', tabIds: movable })],
    movable.length > 0 && folders.length > 0 && {
      label: 'Move to folder',
      items: folders.map((f) => [`${folderOf(f).icon}  ${clip(folderOf(f).name, 40)}`,
        () => send({ type: 'moveToFolder', tabIds: movable, folderId: f.id })]),
    },
    movable.length && ['Move to new window', () => send({ type: 'moveTabsToNewWindow', tabIds: movable })],
    movable.length > 0 && otherWindows.length > 0 && {
      label: 'Move to window',
      items: otherWindows.map((win) => [`“${clip(win.title, 40)}” (${tabsWord(win.count)})`,
        () => send({ type: 'moveTabs', tabIds: movable, windowId: win.id, targetId: null, position: 'end' })]),
    },
    '-',
    [`Close ${tabsWord(closingSet(ids).size)}`, () => closeSelected(ids)],
  ], id);
}

/** Close the selected tabs, and those that a collapsed one of them hides, once confirmClose says so. */
/** The tabs that closing the selected tabs `ids` closes: those, and the tabs a collapsed one of them hides. */
function closingSet(ids) {
  const all = new Set(ids);
  for (const i of ids) if (rowsById.get(i)?.collapsed) for (const below of subtree(forest, i)) all.add(below);
  return all;
}

async function closeSelected(ids) {
  const all = closingSet(ids);
  const hidden = all.size - ids.length;
  const text = `Close the ${tabsWord(ids.length)} you selected${hidden ? ` and the ${tabsWord(hidden)} hidden under them` : ''}?`;
  if (await confirmClose(all.size, text)) send({ type: 'closeTabs', tabIds: [...all] });
}

const clip = (text, most) => (text.length > most ? `${wholePrefix(text, most - 1).trimEnd()}…` : text);

/**
 * "Close group": every tab of the tab group of the unit that `id` is in, if the worker made that group, and it holds
 * other tabs than Close tree would close (another tree's part, or the tree's top tab and those above `id`).
 */
function closeGroupItem(id) {
  const unit = units.find((u) => u.tabs.includes(id));
  if (!unit || unit.optedOut || !Object.values(owned).includes(unit.head)) return null;
  const tree = new Set(subtree(forest, id));
  if (unit.tabs.every((t) => tree.has(t))) return null;
  return [`Close group (${unit.tabs.length} tabs)`, async () => {
    const text = `Close the ${tabsWord(unit.tabs.length)} of group “${clip(unitTitle(nodes, unit.head, tabsById.get(unit.head)), 40)}”?`;
    if (await confirmClose(unit.tabs.length, text)) send({ type: 'closeTabs', tabIds: unit.tabs });
  }];
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
 * The menu's items for a tab group of the user's own that tab `tab` is in: its name, its colour, folding it in the tab
 * strip, taking the tabs `ids` out of it, ungrouping, moving and closing it. For a tab in none of theirs: putting the
 * tabs `ids` into a new group, or one of theirs. (Not while the worker regroups the user's groups by tree.)
 */
function userGroupItems(ids, tab) {
  if (settings.groups !== 'off' && settings.ownGroups !== 'leave') return [];
  const movable = ids.filter((i) => !tabsById.get(i)?.pinned);
  const group = userGroupOf(tab);
  if (group) {
    const groupId = tab.groupId;
    const inGroup = tabs.filter((t) => t.groupId === groupId).map((t) => t.id);
    const name = group.title || 'Group';
    return [
      menuField({
        value: group.title ?? '', placeholder: 'Group name', label: 'Group name',
        keep: (title) => chrome.tabGroups.update(groupId, { title }),
      }),
      groupSwatches(groupId, group.color),
      [group.collapsed ? 'Expand group in tab strip' : 'Collapse group in tab strip',
        () => chrome.tabGroups.update(groupId, { collapsed: !group.collapsed })],
      ['Remove from group', () => chrome.tabs.ungroup(movable.filter((i) => tabsById.get(i)?.groupId === groupId)).catch(failed)],
      ['Ungroup', () => chrome.tabs.ungroup(inGroup).catch(failed)],
      ['Move group to new window', () => send({ type: 'moveGroupToNewWindow', groupId })],
      [`Close group (${tabsWord(inGroup.length)})`, async () => {
        if (!(await confirmClose(inGroup.length, `Close the ${tabsWord(inGroup.length)} of group “${clip(name, 40)}”?`))) return;
        const now = (await chrome.tabs.query({ windowId })).filter((t) => t.groupId === groupId).map((t) => t.id);
        if (now.length) send({ type: 'closeTabs', tabIds: now });
      }],
    ];
  }
  if (!movable.length) return [];
  const theirs = [...allGroups.values()].filter((g) => userGroupOf({ groupId: g.id }));
  return [
    [movable.length > 1 ? `Add ${tabsWord(movable.length)} to new group` : 'Add to new group',
      () => chrome.tabs.group({ tabIds: movable, createProperties: { windowId } }).catch(failed)],
    theirs.length > 0 && {
      label: 'Add to group',
      items: theirs.map((g) => [`“${clip(g.title || 'Group', 40)}”`,
        () => chrome.tabs.group({ groupId: g.id, tabIds: movable }).catch(failed)]),
    },
  ];
}

/** The tab group colours, as swatches, for a group of the user's own (`groupId`). */
function groupSwatches(groupId, current) {
  const row = document.createElement('div');
  row.className = 'swatches';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Group colour');
  for (const color of TREE_COLORS) {
    const name = color[0].toUpperCase() + color.slice(1);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch choice';
    button.title = name;
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-label', name);
    button.setAttribute('aria-checked', String(color === current));
    button.style.setProperty('--swatch', `var(--tree-${color}-0)`);
    button.addEventListener('click', () => {
      closeMenu();
      chrome.tabGroups.update(groupId, { color });
    });
    row.append(button);
  }
  return row;
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
  return menuField({
    value: nodes[head]?.groupName ?? '',
    placeholder: autoName(tabsById.get(head)) || 'Group name',
    label: 'Group name',
    keep: (name) => send({ type: 'setGroupName', tabId: head, name }),
  });
}

/** A folder's name, as nameField: an empty one is the default name ("Folder"). */
function folderNameField(id, folder) {
  return menuField({
    value: folder.name,
    placeholder: 'Folder name',
    label: 'Folder name',
    keep: (name) => send({ type: 'renameFolder', tabId: id, name }),
  });
}

/** A row of icons for a folder, as its page offers them (the first of them; the page has them all). */
function folderIcons(id, folder) {
  const row = document.createElement('div');
  row.className = 'icons';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Folder icon');
  for (const icon of FOLDER_ICONS.slice(0, 12)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-choice choice';
    button.textContent = icon;
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(icon === folder.icon));
    button.addEventListener('click', () => {
      closeMenu();
      send({ type: 'setFolderIcon', tabId: id, icon });
    });
    row.append(button);
  }
  // One stop for ↑ ↓ (see the menu's keys): the folder's icon, or the first if it has another.
  if (!row.querySelector('[aria-checked="true"]')) row.firstElementChild.dataset.stop = 'true';
  return row;
}

/** A text field in the menu: Enter (or leaving it) keeps what was typed (`keep`), Esc does not. */
function menuField({ value, placeholder, label: name, keep: onKeep }) {
  const label = document.createElement('label');
  label.className = 'group-field';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 200;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.value = value;
  input.placeholder = placeholder;
  input.setAttribute('aria-label', name);
  input.dir = 'auto';
  let saved = value;
  let cancelled = false;
  const keep = () => {
    const text = input.value.trim();
    if (cancelled || text === saved) return;
    saved = text;
    onKeep(text);
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
    button.className = 'swatch choice';
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
    ['Find a tab in any window…', () => send({ type: 'openSwitcher', windowId })],
    ['Folders and groups…', () => openJumpMenu(rect.right, rect.bottom + 4)],
    !tabs[0]?.incognito && ['New folder', () => send({ type: 'newFolder', windowId })],
    '-',
    ['Collapse all', () => send({ type: 'setAllCollapsed', windowId, collapsed: true })],
    ['Expand all', () => send({ type: 'setAllCollapsed', windowId, collapsed: false })],
    '-',
    ['Settings…', () => chrome.runtime.openOptionsPage()],
    ['Keyboard shortcuts…', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })],
  ]);
});

findEl.addEventListener('click', () => send({ type: 'openSwitcher', windowId }));

/** A menu of the window's folders and tab groups, in strip order: one switches to the folder, or the group's first tab. */
function openJumpMenu(x, y) {
  const items = [];
  const inOrder = [...tabs].sort((a, b) => a.index - b.index);
  for (const tab of inOrder) {
    const folder = folderOf(tab);
    if (folder && !tab.pinned) items.push([`${folder.icon}  ${clip(folder.name, 40)}`, () => jumpTo(tab.id)]);
  }
  const seen = new Set();
  for (const tab of inOrder) {
    if (tab.groupId === -1 || seen.has(tab.groupId) || !allGroups.has(tab.groupId)) continue;
    seen.add(tab.groupId);
    const head = owned[tab.groupId];
    const name = head != null ? unitTitle(nodes, head, tabsById.get(head)) : allGroups.get(tab.groupId).title || 'Group';
    items.push([`●  ${clip(name, 40)}`, () => jumpTo(head ?? tab.id)]);
  }
  if (!items.length) {
    const label = document.createElement('div');
    label.className = 'menu-label';
    label.textContent = 'No folders or tab groups in this window';
    items.push(label);
  }
  openMenu(x, y, items);
}

function jumpTo(id) {
  setFocus(id);
  activate(id);
}

// While the worker rebuilds the tree from its snapshot (after an extension update or a browser restart): a note.
const restoringEl = document.getElementById('restoring');
let restoringTimer = null;
function showRestoring(on) {
  restoringEl.hidden = !on;
  clearTimeout(restoringTimer);
  if (on) restoringTimer = setTimeout(() => { restoringEl.hidden = true; }, 20000); // should the worker stop meanwhile
}
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.restoring) showRestoring(!!changes.restoring.newValue);
});

/**
 * The user's own colours (the settings page's "Your own colours"), over the theme's: the panel's background, text,
 * current tab (in a gradient, if asked), hover and accent. Kept for look.js too.
 */
const COLOR_VARS = { bg: '--bg', fg: '--fg', active: '--active', activeFg: '--active-fg', hover: '--hover', accent: '--accent' };
function applyColors(colors) {
  const style = document.documentElement.style;
  const on = !!colors?.on;
  for (const [key, name] of Object.entries(COLOR_VARS)) {
    const value = on ? colors.values?.[key] : null;
    if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) style.setProperty(name, value);
    else style.removeProperty(name);
  }
  // The colours that go with them (the menu's, the fields', soft text...) follow from them: see sidepanel.css.
  if (on) document.documentElement.dataset.ownColors = '';
  else delete document.documentElement.dataset.ownColors;
  const to = on && colors.gradient && /^#[0-9a-f]{6}$/i.test(colors.gradientTo ?? '') ? colors.gradientTo : null;
  if (to) style.setProperty('--active-paint', `linear-gradient(90deg, var(--active), ${to})`);
  else style.removeProperty('--active-paint');
  try {
    localStorage.setItem('colors', JSON.stringify(on ? colors : null));
  } catch {
    // the colours come a moment later, from the settings
  }
}
chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.colors) applyColors(changes.colors.newValue);
});

/**
 * items: [label, action] pairs, elements, '-' for a separator; falsy items are skipped. A menu
 * for a tab (`tabId`) closes when the tab closes.
 */
function openMenu(x, y, items, tabId = null, back = null) {
  menuTabId = tabId;
  rebuilding = true; // the focused item goes with the old items: that is no leaving of the menu (see focusout)
  menuEl.replaceChildren();
  let separator = false;
  // In a submenu: first the way back to the menu it is in.
  const all = back ? [{ back }, '-', ...items] : items;
  for (const item of all) {
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
    if (item.back || item.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      if (item.back) {
        button.className = 'back';
        button.textContent = '‹ Back';
        button.addEventListener('click', () => openMenu(x, y, item.back.items, tabId, item.back.back));
      } else {
        button.className = 'submenu';
        button.setAttribute('aria-haspopup', 'menu');
        button.textContent = `${item.label} ›`;
        button.addEventListener('click', () => openMenu(x, y, item.items, tabId, { items, back }));
      }
      menuEl.append(button);
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
  menuEl.scrollTop = 0;
  const { width, height } = menuEl.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, innerWidth - width - 4));
  // Below the point, or above it, or else as high as it fits (a long menu scrolls: see .menu).
  const top = y + height <= innerHeight - 4 ? y : y - height >= 4 ? y - height : Math.max(4, innerHeight - height - 4);
  menuEl.style.left = `${left}px`;
  menuEl.style.top = `${top}px`;
  (menuEl.querySelector('button:not(.choice):not(.back)') ?? menuEl.querySelector('button:not(.choice)'))?.focus();
  setTimeout(() => { rebuilding = false; }, 0);
}
let rebuilding = false;

function closeMenu() {
  menuTabId = null;
  if (menuEl.hidden) return;
  const hadFocus = menuEl.contains(document.activeElement);
  menuEl.hidden = true;
  if (hadFocus) treeEl.focus();
}

menuEl.addEventListener('keydown', (event) => {
  // A row of choices (the colour swatches, a folder's icons) is one stop for ↑ ↓ (the checked one); ← → move in it.
  const stops = 'input, button:not(.choice), .choice[aria-checked="true"], .choice[data-stop]';
  const buttons = [...menuEl.querySelectorAll(stops)];
  const choice = document.activeElement?.closest('.choice');
  const stop = choice?.parentElement.querySelector('.choice[aria-checked="true"], .choice[data-stop]');
  const i = buttons.indexOf(choice ? stop : document.activeElement);
  if (choice && event.key === 'ArrowLeft') choice.previousElementSibling?.focus();
  else if (choice && event.key === 'ArrowRight') choice.nextElementSibling?.focus();
  else if (event.key === 'ArrowRight' && document.activeElement?.classList.contains('submenu')) document.activeElement.click();
  else if (event.key === 'ArrowLeft' && menuEl.querySelector('.back')) menuEl.querySelector('.back').click();
  else if (event.key === 'Escape') closeMenu();
  else if (event.key === 'ArrowDown') buttons[(i + 1) % buttons.length]?.focus();
  else if (event.key === 'ArrowUp') buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
  else if (event.key === 'Home') buttons[0]?.focus();
  else if (event.key === 'End') buttons.at(-1)?.focus();
  else return;
  event.preventDefault();
});

menuEl.addEventListener('focusout', (event) => {
  if (!rebuilding && !menuEl.contains(event.relatedTarget)) closeMenu();
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
  // A tab of a selection takes the selected tabs along, each with the tabs under it; with Ctrl (or ⌘) held as the drag
  // starts, a tab with children goes alone, and they stay.
  const chosen = selectedIds().filter((i) => !tabsById.get(i)?.pinned);
  const many = chosen.length > 1 && chosen.includes(id);
  const alone = !many && (event.ctrlKey || event.metaKey) && !!forest.children.get(id)?.length;
  const tabIds = many ? chosen : [id];
  drag = { tabId: id, tabIds, alone, block: new Set(alone ? [id] : tabIds.flatMap((i) => subtree(forest, i))) };
  closeMenu();
  event.dataTransfer.effectAllowed = alone ? 'copyMove' : 'move'; // Ctrl held may ask for a copy
  event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ tabId: id, tabIds, alone }));
  if (tab?.url && !many) {
    event.dataTransfer.setData('text/uri-list', tab.url);
    event.dataTransfer.setData('text/plain', tab.url);
  }
  for (const moving of alone ? [id] : tabIds) rowEls.get(moving)?.classList.add('dragging');
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
  event.dataTransfer.dropEffect = event.dataTransfer.effectAllowed === 'copyMove' && (event.ctrlKey || event.metaKey) ? 'copy' : 'move';
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
  const where = { windowId, targetId: target.targetId, position: target.position };
  if (dragged.tabIds?.length > 1) send({ type: 'moveTabs', tabIds: dragged.tabIds, ...where });
  else send({ type: 'move', tabId: dragged.tabId, alone: !!dragged.alone, ...where });
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
  // The middle: into it, as its last child or (the setting dropInto) its first.
  return { targetId: id, position: settings.dropInto === 'first' ? 'firstChild' : 'lastChild', into: true };
}

function showDrop(target) {
  dropRow?.classList.remove('drop-into');
  dropRow = null;
  dropLineEl.hidden = true;
  if (!target) return;
  if (target.into) {
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

const [initialTabs, stored, local, initialGroups] = await Promise.all([
  chrome.tabs.query({ windowId }),
  chrome.storage.session.get(['tree', 'restoring']),
  chrome.storage.local.get(['settings', 'colors']),
  chrome.tabGroups.query({ windowId }).catch(() => []),
]);
showRestoring(!!stored.restoring);
applyColors(local.colors);
tabs = initialTabs;
allGroups = new Map(initialGroups.map((group) => [group.id, group]));
for (const group of initialGroups) groupSeen.set(group.id, 0);
settings = readSettings(local.settings);
applyLook(settings);
refreshWindows();
if (!nodesFromEvent) readTree(stored.tree);
render();
send({ type: 'ping' }); // wakes the worker, which loads or restores the tree
