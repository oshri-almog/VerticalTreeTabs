// Pure tree logic shared by the service worker, the side panel and the unit tests.
// Nothing in this file touches the chrome.* APIs.
//
// The extension keeps one node per tab:  nodes[tabId] = { parent, collapsed, color?, lastColor?, heir? }
// `parent` is the id of the tab it was opened from, or null for a top-level tab.
// `color` is the colour of the tree the tab heads; after a colour pass, a tab that heads a tree
// has no other colour. `lastColor` is the colour it had the last time it headed one, and `heir`
// the colour of the tree it was last in: the one it is in, or that of a closed tab whose place it
// took (see storeColors and removeNode).
// Sibling order is never stored: siblings always follow the tabs' native strip order.

/**
 * The tree colours: the nine colours of Chrome's tab groups, in the order the colour menu shows
 * them. sidepanel.css defines --tree-<colour>-<shade> for each, in both themes.
 */
export const TREE_COLORS = ['blue', 'cyan', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'grey'];

/**
 * The order new trees take colours in: the first few stay far apart for colour-blind eyes too.
 * Grey is only ever picked by hand.
 */
export const NEW_TREE_COLORS = ['blue', 'orange', 'pink', 'green', 'cyan', 'purple', 'red', 'yellow'];

const isColor = (color) => TREE_COLORS.includes(color);

/**
 * The colour of the tree a node (or a saved tab) heads, or else the tree colour it was handed
 * (`heir`): that of the tree it was last in below the top, or of a closed tab whose place it took.
 * Its own colour from when it headed a tree (`lastColor`) is never handed down.
 */
export const colorOf = (node) => node?.color ?? node?.heir;

/** The shade of its tree's colour that a tab at `depth` heads: 0 for the tree, then 1 2 1 2... */
export function shadeOf(depth) {
  return depth === 0 ? 0 : 1 + ((depth - 1) % 2);
}

/**
 * Build the tree for one window from its tabs (any order) and the stored nodes.
 *
 * A tab hangs under its nearest recorded ancestor that is an unpinned tab of this
 * window, so ancestors that were closed, pinned or moved to another window are skipped.
 * A tab without a node yet is top-level. (Chrome's openerTabId is no substitute: Chrome
 * also sets it to the active tab for Ctrl+T and New Tab button tabs.)
 *
 * Returns { roots, children, parentOf, pinned, order }: `order` is the native order of
 * the tree (unpinned) tabs, `pinned` the pinned tab ids, `children` a Map id -> ids.
 */
export function buildForest(tabs, nodes) {
  const sorted = [...tabs].sort((a, b) => a.index - b.index);
  const pinned = [];
  const order = [];
  for (const tab of sorted) (tab.pinned ? pinned : order).push(tab.id);

  const members = new Set(order);
  const parentOf = new Map();
  for (const tab of sorted) {
    if (!tab.pinned) parentOf.set(tab.id, nearestMember(tab, nodes, members));
  }
  breakCycles(parentOf);

  const roots = [];
  const children = new Map();
  for (const id of order) {
    const parent = parentOf.get(id);
    if (parent == null) roots.push(id);
    else if (children.has(parent)) children.get(parent).push(id);
    else children.set(parent, [id]);
  }
  return { roots, children, parentOf, pinned, order };
}

function nearestMember(tab, nodes, members) {
  const seen = new Set([tab.id]);
  let parent = nodes[tab.id]?.parent ?? null;
  while (parent != null && !members.has(parent)) {
    if (seen.has(parent)) return null;
    seen.add(parent);
    parent = nodes[parent]?.parent ?? null;
  }
  return parent === tab.id ? null : parent;
}

// A cycle would leave its tabs unreachable from any root, so they would vanish from the
// panel. The worker never creates one, but stored data can be stale; cut any we find.
function breakCycles(parentOf) {
  const state = new Map(); // 1 = on the current path, 2 = known to reach a root
  for (const start of parentOf.keys()) {
    const path = [];
    let id = start;
    while (id != null && !state.has(id)) {
      state.set(id, 1);
      path.push(id);
      id = parentOf.get(id);
    }
    if (id != null && state.get(id) === 1) parentOf.set(id, null);
    for (const visited of path) state.set(visited, 2);
  }
}

/** `id` followed by all its descendants, in display (depth-first) order. */
export function subtree(forest, id) {
  const out = [];
  const stack = [id];
  while (stack.length) {
    const current = stack.pop();
    out.push(current);
    const kids = forest.children.get(current);
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

/** Every tree tab of the window in display order. */
export function displayOrder(forest) {
  return forest.roots.flatMap((id) => subtree(forest, id));
}

/**
 * The colour of every tree of one window (a top-level tab with children), as a Map from the
 * tree's top tab to its colour, in display order. The worker stores it (storeColors), and the
 * panel draws a tree the worker has not stored yet in the colour it will get.
 *
 * A top tab that has a `color` keeps it, whatever colours the other trees have. Every other tree
 * asks for the colour its top tab had when it last headed a tree (`lastColor`), and then for the
 * colour of the tree it was last in (`heir`; without one, the tree colour of the nearest recorded
 * ancestor that has one: a tab just closed or pinned, or in another window). It gets the first of
 * them that no tree has yet. With more trees than colours, which repeat then anyway, it may also
 * get one that only trees further away have and that no other tree took in this pass: the colour
 * of the tree it was last in if a tab right under its top tab holds it as the colour of its tree
 * (the tree is drawn in it already), or else its own. (A tab opened from the subtree's top tab
 * since the last pass holds no colour yet, unlike one opened from a tab that is pinned or has
 * closed or left the window since, which holds that tab's tree colour: a subtree with only the
 * former right under its top tab does not get the colour this way, should the top tab of its tree
 * close or be pinned before the next pass.) Trees that get none of them take a new colour: the
 * least used, then one that no other tab of the window would ask for, then the first in
 * NEW_TREE_COLORS. A tree without a `color` never gets that of the tree just above or below it.
 */
export function treeColors(forest, nodes) {
  const heads = forest.roots.filter((id) => forest.children.has(id));
  const colors = new Map();
  const uses = new Map(TREE_COLORS.map((color) => [color, 0]));
  const take = (id, color) => {
    colors.set(id, color);
    uses.set(color, uses.get(color) + 1);
  };
  for (const id of heads) if (isColor(nodes[id]?.color)) take(id, nodes[id].color);
  const kept = new Map(uses);

  // Colours that other tabs of the window would ask for if they headed a tree: a new tree leaves
  // them to those tabs as long as other colours are free. (Inside a tree, `heir` is the colour
  // of that tree.)
  const members = new Set(forest.order);
  const isHead = new Set(heads);
  const remembered = new Set();
  for (const id of [...forest.order, ...forest.pinned]) {
    if (isHead.has(id)) continue;
    const node = nodes[id];
    remembered.add(node?.color ?? node?.lastColor);
    if (forest.parentOf.get(id) == null) remembered.add(node?.heir ?? inheritedColor(nodes, id, members));
  }
  const rank = (color) => uses.get(color) * 2 + (remembered.has(color) ? 1 : 0);
  const near = (i) => [colors.get(heads[i - 1]), colors.get(heads[i + 1])];

  const crowded = heads.length > NEW_TREE_COLORS.length;
  const free = (color) => isColor(color) && uses.get(color) === 0;
  const shared = (color, i) => crowded && isColor(color) && uses.get(color) === kept.get(color)
    && !near(i).includes(color);
  // Whether a tab right under a tree's top tab holds `color` as the colour of its tree: the same
  // before and after the worker forgets a closed tab between them. (A tab opened from the top tab
  // since the last pass holds none yet.)
  const drawnIn = (id, color) => forest.children.get(id)
    .some((kid) => (nodes[kid]?.heir ?? inheritedColor(nodes, kid, members)) === color);

  // The trees that get a colour they ask for go first, so that no new colour takes it from them.
  const rest = [];
  heads.forEach((id, i) => {
    if (colors.has(id)) return;
    // The same before and after the worker forgets a closed parent: removeNode hands the colour
    // of its tree down as `heir`.
    const own = nodes[id]?.lastColor;
    const carried = nodes[id]?.heir ?? inheritedColor(nodes, id, members);
    if (free(own)) take(id, own);
    else if (free(carried) || (shared(carried, i) && drawnIn(id, carried))) take(id, carried);
    else if (shared(own, i)) take(id, own);
    else rest.push(i);
  });
  for (const i of rest) {
    const avoid = near(i);
    let best = null;
    for (const color of NEW_TREE_COLORS) {
      if (!avoid.includes(color) && (best == null || rank(color) < rank(best))) best = color;
    }
    take(heads[i], best);
  }
  return new Map(heads.map((id) => [id, colors.get(id)]));
}

/**
 * The tree colour (see colorOf) of the nearest recorded ancestor that has one, among those up to
 * the first tree tab of the window (`members`): ancestors that were closed, pinned or moved to
 * another window.
 */
function inheritedColor(nodes, id, members) {
  const seen = new Set([id]);
  let parent = nodes[id]?.parent;
  while (parent != null && !members.has(parent) && !seen.has(parent)) {
    seen.add(parent);
    const color = colorOf(nodes[parent]);
    if (color) return color;
    parent = nodes[parent]?.parent;
  }
  return null;
}

/**
 * Store what treeColors decides, for the forests of every window: a tree's top tab gets its
 * colour as `color` and no other, any other tab that has a `color` keeps it as `lastColor`, and
 * every tab inside a tree gets the colour of that tree as `heir`. Every window is decided before
 * any is stored, since a tree can inherit from a tab in another window. Returns whether a node
 * changed.
 */
export function storeColors(forests, nodes) {
  const decided = forests.map((forest) => [forest, treeColors(forest, nodes)]);
  let changed = false;
  for (const [forest, colors] of decided) {
    const treeOf = new Map();
    for (const [head, color] of colors) for (const id of subtree(forest, head)) treeOf.set(id, color);
    for (const id of [...forest.order, ...forest.pinned]) {
      const node = nodes[id];
      const color = colors.get(id);
      if (!node) continue;
      if (color) {
        if (node.color !== color || 'lastColor' in node || 'heir' in node) {
          node.color = color;
          delete node.lastColor;
          delete node.heir;
          changed = true;
        }
        continue;
      }
      if (rememberColor(node)) changed = true;
      // The colour to carry on, should the top tab of its tree close or leave.
      const tree = treeOf.get(id);
      if (tree && node.heir !== tree) {
        node.heir = tree;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Whether storing the colours of one window alone, whose tabs are `tabs`, could change those of
 * another window, or, with `top`, storing them and then moving the tree that `top` heads to a new
 * window. The trees of another window depend on this one only through a tab outside it (in another
 * window, or closed) whose parent is here (see buildForest and inheritedColor), and storing its
 * colours changes nothing once they are stored. The move lets go of the top tab's parent, which
 * matters there only through a tab outside the tree whose parent is in it, and only if the top tab
 * has no tree colour (see colorOf) or its recorded ancestors leave this window. (The top tab keeps
 * its colour: see attached in background.js.)
 */
export function colorsReachOtherWindows(tabs, nodes, top = null) {
  const here = new Set(tabs.map((tab) => tab.id));
  const hangsFrom = (ids) => Object.entries(nodes).some(([id, node]) => ids.has(node?.parent) && !ids.has(Number(id)));
  if (!hangsFrom(here)) return false;
  const trial = structuredClone(nodes);
  if (storeColors([buildForest(tabs, trial)], trial)) return true;
  if (nodes[top]?.parent == null || !hangsFrom(new Set(subtree(buildForest(tabs, nodes), top)))) return false;
  if (!colorOf(nodes[top])) return true;
  const seen = new Set([top]);
  for (let id = nodes[top].parent; id != null && !seen.has(id); id = nodes[id]?.parent) {
    if (!here.has(id)) return true;
    seen.add(id);
  }
  return false;
}

/** Keep a tab's tree colour as `lastColor`, for when it heads a tree again. Returns whether it had one. */
export function rememberColor(node) {
  if (node?.color == null) return false;
  node.lastColor = node.color;
  delete node.color;
  return true;
}

/**
 * The rows to show, depth-first. Descendants of collapsed tabs are left out.
 * With `matches` (a Set of tab ids) only matching tabs and their ancestors are shown,
 * whether collapsed or not, and ancestors that don't match themselves get `dim: true`.
 * With `colors` (see treeColors) every row gets its tree's `color`; a lone tab gets null.
 * With `units` (a Map from the head of a tab group unit below the top level to its colour, see
 * unitColors in groups.js) the rows of such a unit get its colour instead. Every row also gets its
 * `palette`: the colours drawn at its levels, as [colour, depth it starts at] pairs from the top
 * down: its tree's from depth 0, then its unit's, if it is in one, from the unit's head.
 */
export function flatten(forest, nodes, { matches = null, colors = null, units = null } = {}) {
  const sizes = new Map();
  const descendants = (id) => {
    let size = sizes.get(id);
    if (size === undefined) {
      size = 0;
      for (const kid of forest.children.get(id) ?? []) size += 1 + descendants(kid);
      sizes.set(id, size);
    }
    return size;
  };

  let keep = null;
  if (matches) {
    keep = new Set();
    const mark = (id) => {
      let hit = matches.has(id);
      for (const kid of forest.children.get(id) ?? []) if (mark(kid)) hit = true;
      if (hit) keep.add(id);
      return hit;
    };
    for (const id of forest.roots) mark(id);
  }

  const rows = [];
  const visit = (id, depth, palette) => {
    if (keep && !keep.has(id)) return;
    const own = units?.get(id);
    if (own) palette = [...palette, [own, depth]];
    const kids = forest.children.get(id) ?? [];
    const collapsed = !keep && kids.length > 0 && !!nodes[id]?.collapsed;
    rows.push({
      id,
      depth,
      hasChildren: kids.length > 0,
      collapsed,
      descendants: descendants(id),
      dim: !!keep && !matches.has(id),
      color: palette.at(-1)?.[0] ?? null,
      palette,
    });
    if (!collapsed) for (const kid of kids) visit(kid, depth + 1, palette);
  };
  for (const id of forest.roots) {
    const color = colors?.get(id);
    visit(id, 0, color ? [[color, 0]] : []);
  }
  return rows;
}

/**
 * Forget a closed tab; its children move up to its parent. Those that have no `heir` yet are
 * handed the tab's tree colour (see colorOf) as one, so the first subtree that becomes a tree
 * carries it on. (A child that heads a tree of its own gets it too; the next colour pass drops it
 * if the child still heads a tree then.) If it was its parent's first link, or another of the tabs of
 * its parent's branch, they take its place there (see handOnFirstLink).
 */
export function removeNode(nodes, id) {
  const node = nodes[id];
  const parent = node ? node.parent : null;
  const color = colorOf(node);
  const kids = [];
  for (const key in nodes) {
    const child = nodes[key];
    if (child.parent !== id) continue;
    child.parent = parent;
    if (color && child.heir == null) child.heir = color;
    kids.push(Number(key));
  }
  handOnFirstLink(nodes, parent, id, kids);
  delete nodes[id];
}

/**
 * Tab `id` leaves `parent`, and its children `kids` move up into its place (see removeNode, and leaveTree in
 * groups.js). If it was the first link of `parent` (`firstLink`, see groups.js), the one it had of its own takes that
 * over, if it is one of them, or else the oldest of them (the lowest tab id), and the rest stay in the branch as
 * `alsoLinks` (see branchKids in groups.js); without them, the first of the `alsoLinks` takes it over, and with none
 * `parent` has none recorded until the next group pass. One of the `alsoLinks` that leaves is replaced there by its
 * children.
 */
export function handOnFirstLink(nodes, parent, id, kids) {
  const node = parent == null ? null : nodes[parent];
  if (!node) return;
  const also = node.alsoLinks ?? [];
  let rest;
  if (node.firstLink === id) {
    const own = nodes[id]?.firstLink;
    const next = kids.includes(own) ? own : kids.length ? Math.min(...kids) : null;
    rest = [...also, ...kids.filter((kid) => kid !== next)];
    if (next != null) node.firstLink = next;
    else if (rest.length) node.firstLink = rest.shift();
    else delete node.firstLink;
  } else if (also.includes(id)) {
    rest = [...also.filter((link) => link !== id), ...kids];
  } else return;
  if (rest.length) node.alsoLinks = rest;
  else delete node.alsoLinks;
}

/** The member of `id`'s subtree, outside `exclude`, that comes last in native order. */
export function lastOfSubtree(forest, id, exclude = new Set()) {
  const position = new Map(forest.order.map((tabId, i) => [tabId, i]));
  let last = id;
  for (const member of subtree(forest, id)) {
    if (!exclude.has(member) && position.get(member) > position.get(last)) last = member;
  }
  return last;
}

/**
 * Where a dragged subtree lands. `block` is the dragged tab followed by its descendants.
 *
 * position: 'before'     sibling just before the target
 *           'afterTree'  sibling just after the target and its whole subtree
 *           'firstChild' / 'lastChild' of the target
 *           'end'        top level, after every other tab (target ignored)
 *
 * Returns { parent, placement } with placement { before: id } | { after: id } | { end: true }
 * in native-order terms, or null when the drop is not allowed (onto the block itself).
 */
export function resolveDrop(forest, block, targetId, position) {
  if (position === 'end') return { parent: null, placement: { end: true } };
  const dragged = new Set(block);
  if (targetId == null || dragged.has(targetId) || !forest.parentOf.has(targetId)) return null;
  const siblingParent = forest.parentOf.get(targetId) ?? null;
  switch (position) {
    case 'before':
      return { parent: siblingParent, placement: { before: targetId } };
    case 'afterTree':
      return { parent: siblingParent, placement: { after: lastOfSubtree(forest, targetId, dragged) } };
    case 'firstChild':
      return { parent: targetId, placement: { after: targetId } };
    case 'lastChild':
      return { parent: targetId, placement: { after: lastOfSubtree(forest, targetId, dragged) } };
    default:
      return null;
  }
}

/**
 * Plan the chrome.tabs.move calls that put `block` together, in its own order, at
 * `placement` in a window whose tabs are currently in `order` (all tab ids, pinned too).
 *
 * Each step moves one tab, with tab-strip semantics: the tab is taken out and reinserted
 * so that it ends up exactly at `index`. (Moving several tabs in a single call does not
 * keep them together when they move to the right, hence one tab per call.)
 */
export function planBlockMove(order, block, placement) {
  const inBlock = new Set(block);
  let anchor = null; // first tab that should follow the block; null = end of window
  if (placement.before != null) {
    anchor = placement.before;
  } else if (placement.after != null) {
    const rest = order.filter((id) => !inBlock.has(id));
    const i = rest.indexOf(placement.after);
    anchor = i >= 0 && i + 1 < rest.length ? rest[i + 1] : null;
  }

  // Work backwards: each tab goes just before the tab that should follow it. The tail of
  // the block is then always together already, and tabs that are in place never move.
  const current = [...order];
  const ops = [];
  let next = anchor;
  for (let k = block.length - 1; k >= 0; k--) {
    const id = block[k];
    const from = current.indexOf(id);
    if (from < 0) continue;
    const at = next == null ? -1 : current.indexOf(next);
    let to;
    if (at < 0) to = current.length - 1;
    else to = from < at ? at - 1 : at;
    if (to !== from) {
      current.splice(from, 1);
      current.splice(to, 0, id);
      ops.push({ tabId: id, index: to });
    }
    next = id;
  }
  return ops;
}
