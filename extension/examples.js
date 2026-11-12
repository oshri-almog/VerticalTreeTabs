// The small trees the settings page draws to show what a setting does (see options.js). Each is worked out by the
// extension's own code (tree.js, groups.js), so it shows what the extension really does: plain data, no chrome.* calls.
//
// A list is { label?, rows }; a row is { id, title, depth } and its marks: `current` (the tab you are on), `added` (a
// new tab, where it goes), `closing`, `dragging`, `moved` (where a dropped tab lands), `unread`, `group` (the colour of
// its tab group), `badge` (a word on its right).

import { buildForest, displayOrder, lastOfSubtree, nextAfterClose, placeNear, removeNode, resolveDrop } from './tree.js';
import { groupUnits, stacksGroups } from './groups.js';

const NEW = 100;

/** A window of tabs from [id, title, parent] in strip order: { tabs, nodes, titles }. */
function windowOf(list, extra = {}) {
  return {
    tabs: list.map(([id], index) => ({ id, index, pinned: false })),
    nodes: Object.fromEntries(list.map(([id, , parent]) => [id, { parent: parent ?? null, collapsed: false, ...extra[id] }])),
    titles: new Map(list.map(([id, title]) => [id, title])),
  };
}

/** The rows the panel would show for `win`, in its order: { id, title, depth, ...marks(id) }. */
function rowsOf(win, marks = () => ({})) {
  const forest = buildForest(win.tabs, win.nodes);
  return displayOrder(forest).map((id) => {
    let depth = 0;
    for (let at = forest.parentOf.get(id); at != null; at = forest.parentOf.get(at)) depth++;
    return { id, title: win.titles.get(id), depth, ...marks(id) };
  });
}

/** `win` with tab `id` (titled `title`, under `parent`) right after tab `after` in the strip, or at the end (null). */
function withTab(win, id, title, parent, after) {
  const tabs = win.tabs.filter((tab) => tab.id !== id);
  const index = after == null ? Math.max(...tabs.map((tab) => tab.index)) + 1 : tabs.find((tab) => tab.id === after).index + 0.5;
  return {
    tabs: [...tabs, { id, index, pinned: false }],
    nodes: { ...win.nodes, [id]: { parent, collapsed: false } },
    titles: new Map([...win.titles, [id, title]]),
  };
}

/** `win` without tab `id`, its nodes as `nodes`. */
const without = (win, id, nodes = win.nodes) => ({ tabs: win.tabs.filter((tab) => tab.id !== id), nodes, titles: win.titles });

// ---- tab groups ----------------------------------------------------------------------------------

// News opened Article and Sports; Article opened Comments, then Author; Comments opened Reply.
const NEWS = [[1, 'News'], [2, 'Article', 1], [3, 'Comments', 2], [4, 'Reply', 3], [6, 'Author', 2], [5, 'Sports', 1]];
const NEWS_LINKS = { 1: { firstLink: 2 }, 2: { firstLink: 3 }, 3: { firstLink: 4 } };
export const GROUP_COLORS = ['blue', 'orange', 'pink', 'green', 'purple', 'cyan'];

/** The tab groups of the setting `groups` (mode): { lists, groups: [{ color, tabs: [titles] }] }. */
export function groupsExample(mode) {
  let win = windowOf(NEWS, NEWS_LINKS);
  let units = mode === 'off' ? [] : groupUnits(buildForest(win.tabs, win.nodes), win.nodes, mode);
  // Where groups stack (see stacksGroups), each is one run in the tab strip, right after its parent's, and the panel
  // shows the tabs under a tab in the strip's order (see buildForest).
  if (stacksGroups(mode)) {
    const strip = [...units.flatMap((unit) => unit.tabs), ...win.tabs.map((tab) => tab.id)];
    win = { ...win, tabs: win.tabs.map((tab) => ({ ...tab, index: strip.indexOf(tab.id) })) };
    units = groupUnits(buildForest(win.tabs, win.nodes), win.nodes, mode);
  }
  const colorOf = new Map();
  units.forEach((unit, i) => {
    for (const id of unit.tabs) colorOf.set(id, GROUP_COLORS[i % GROUP_COLORS.length]);
  });
  return {
    lists: [{ rows: rowsOf(win, (id) => ({ group: colorOf.get(id) ?? null })) }],
    groups: units.map((unit) => ({ color: colorOf.get(unit.head), tabs: unit.tabs.map((id) => win.titles.get(id)) })),
  };
}

// ---- where new tabs go ---------------------------------------------------------------------------

// Docs, with Guide (the current tab, with Section under it) and FAQ under it; Mail on its own.
const DOCS = [[1, 'Docs'], [2, 'Guide', 1], [3, 'Section', 2], [4, 'FAQ', 1], [5, 'Mail']];
const GUIDE = 2;

/**
 * Where a new tab goes by the current tab, Guide: `where` as placeNear takes it ('afterTree', 'sibling', 'child'),
 * 'end' at the end at the top level (where the browser puts a New Tab page), or 'none' (no new tab).
 */
export function placementExample(where) {
  const win = windowOf(DOCS);
  const marks = (id) => ({ current: id === GUIDE, added: id === NEW, badge: id === NEW ? 'new' : null });
  if (where === 'none') return { lists: [{ rows: rowsOf(win, marks) }] };
  const place = where === 'end' ? null : placeNear(buildForest(win.tabs, win.nodes), GUIDE, where);
  return { lists: [{ rows: rowsOf(withTab(win, NEW, 'New tab', place?.parent ?? null, place?.after ?? null), marks) }] };
}

// Recipes opened Cake (which opened Icing) and Bread; Mail on its own.
const RECIPES = [[1, 'Recipes'], [2, 'Cake', 1], [3, 'Icing', 2], [4, 'Bread', 1], [5, 'Mail']];

/**
 * Where a tab that Recipes opens from a link goes (the setting linkPlacement): 'first' right under it, 'last' after
 * the tabs under it, as placeLink in background.js; 'browser' where the browser puts it, which with the tabs Recipes
 * opened just before is after them (as 'last' here).
 */
export function linkExample(where) {
  const win = windowOf(RECIPES);
  const after = where === 'first' ? 1 : lastOfSubtree(buildForest(win.tabs, win.nodes), 1);
  const next = withTab(win, NEW, 'Link', 1, after);
  return { lists: [{ rows: rowsOf(next, (id) => ({ current: id === 1, added: id === NEW, badge: id === NEW ? (where === 'browser' ? 'usually' : 'new') : null })) }] };
}

// ---- when tabs close -----------------------------------------------------------------------------

/** Recipes closes (the setting closeParent): 'up', its tabs move up a level; 'promote', the first takes its place. */
export function closeParentExample(mode) {
  const before = windowOf(RECIPES);
  const nodes = structuredClone(before.nodes);
  // The first of its children in the strip, as the worker picks it (see closed in background.js).
  removeNode(nodes, 1, mode === 'promote' ? 2 : null);
  return {
    lists: [
      { label: 'Before', rows: rowsOf(before, (id) => ({ closing: id === 1, badge: id === 1 ? 'closes' : null })) },
      { label: 'After', rows: rowsOf(without(before, 1, nodes)) },
    ],
  };
}

/**
 * Bread, the current tab, closes (the setting afterClose): 'tree', the tab nextAfterClose gives is the current one;
 * 'browser', the browser's own pick, which depends on what it remembers of who opened what: none shown.
 */
export function afterCloseExample(mode) {
  const before = windowOf(RECIPES);
  const order = before.tabs.map((tab) => tab.id);
  const pick = mode === 'tree' ? nextAfterClose(order, 4, before.nodes, new Set(order.filter((id) => id !== 4))) : null;
  return {
    lists: [
      { label: 'Before', rows: rowsOf(before, (id) => ({ current: id === 4, closing: id === 4, badge: id === 4 ? 'closes' : null })) },
      { label: 'After', rows: rowsOf(without(before, 4), (id) => ({ current: id === pick, badge: id === pick ? 'next' : null })) },
    ],
    pick: pick == null ? null : before.titles.get(pick),
  };
}

// ---- mouse and dragging --------------------------------------------------------------------------

const DROP = [[1, 'Recipes'], [2, 'Cake', 1], [3, 'Bread', 1], [5, 'Mail'], [6, 'Pie']];

/** Pie dropped onto the middle of Recipes (the setting dropInto): 'last' or 'first' under it (see resolveDrop). */
export function dropExample(where) {
  const before = windowOf(DROP);
  const drop = resolveDrop(buildForest(before.tabs, before.nodes), [6], 1, where === 'first' ? 'firstChild' : 'lastChild');
  return {
    lists: [
      { label: 'Before', rows: rowsOf(before, (id) => ({ dragging: id === 6, badge: id === 6 ? 'drag' : null })) },
      { label: 'After', rows: rowsOf(withTab(before, 6, 'Pie', drop.parent, drop.placement.after), (id) => ({ moved: id === 6, badge: id === 6 ? 'dropped' : null })) },
    ],
  };
}

// ---- how the panel looks -------------------------------------------------------------------------

/** A few rows for the look's preview: Article the current tab, Comments and Mail unread. */
export function lookExample() {
  const win = windowOf([[1, 'News'], [2, 'Article', 1], [3, 'Comments', 2], [4, 'Sports', 1], [5, 'Mail']]);
  return { lists: [{ rows: rowsOf(win, (id) => ({ current: id === 2, unread: id === 3 || id === 5 })) }] };
}
