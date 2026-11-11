import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import {
  buildForest,
  colorsReachOtherWindows,
  displayOrder,
  flatten,
  NEW_TREE_COLORS,
  planBlockMove,
  rememberColor,
  removeNode,
  resolveDrop,
  shadeOf,
  storeColors,
  subtree,
  TREE_COLORS,
  treeColors,
} from '../extension/tree.js';

/** Tabs of one window in the given native order; `extra[id]` patches single tabs. */
function tabsInOrder(ids, extra = {}) {
  return ids.map((id, index) => ({ id, index, windowId: 1, pinned: false, ...extra[id] }));
}

/** nodes from { id: parentId }, with the listed ids collapsed. */
function nodesFrom(parents, collapsed = []) {
  const nodes = {};
  for (const [id, parent] of Object.entries(parents)) {
    nodes[id] = { parent, collapsed: collapsed.includes(Number(id)) };
  }
  return nodes;
}

/** A repeatable stream of random numbers in [0, 1). */
function seeded(seed) {
  return () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
}

/** Compact picture of a forest, e.g. "1(2 3(7 8)) 9". */
function shape(forest) {
  const draw = (id) => {
    const kids = forest.children.get(id);
    return kids ? `${id}(${kids.map(draw).join(' ')})` : String(id);
  };
  return forest.roots.map(draw).join(' ');
}

// Tab 1 is a search page; 2-6 were opened from its results, 7 and 8 from result 3.
// Chrome places each new tab after its opener's earlier children.
const searchTabs = tabsInOrder([1, 2, 3, 7, 8, 4, 5, 6]);
const searchNodes = nodesFrom({ 1: null, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 3, 8: 3 });

test('tabs opened from a page nest under it, and their own links one level deeper', () => {
  assert.equal(shape(buildForest(searchTabs, searchNodes)), '1(2 3(7 8) 4 5 6)');
});

test('siblings follow the native tab order', () => {
  const forest = buildForest(tabsInOrder([1, 4, 2, 3]), nodesFrom({ 1: null, 2: 1, 3: 1, 4: 1 }));
  assert.equal(shape(forest), '1(4 2 3)');
});

test('tabs can be passed in any order', () => {
  const shuffled = [...searchTabs].reverse();
  assert.equal(shape(buildForest(shuffled, searchNodes)), '1(2 3(7 8) 4 5 6)');
});

test('a closed parent is skipped in favour of the nearest open ancestor', () => {
  // 2 was closed but its node is still around (the worker removes it a moment later).
  const forest = buildForest(tabsInOrder([1, 3]), nodesFrom({ 1: null, 2: 1, 3: 2 }));
  assert.equal(shape(forest), '1(3)');
});

test('pinned tabs stay out of the tree and their children become top-level', () => {
  const forest = buildForest(
    tabsInOrder([1, 2, 3], { 1: { pinned: true } }),
    nodesFrom({ 1: null, 2: 1, 3: 2 }),
  );
  assert.deepEqual(forest.pinned, [1]);
  assert.equal(shape(forest), '2(3)');
});

test('a parent in another window does not count', () => {
  // Tab 9 lives in another window, so it is not among this window's tabs.
  const forest = buildForest(tabsInOrder([2, 3]), nodesFrom({ 9: null, 2: 9, 3: 2 }));
  assert.equal(shape(forest), '2(3)');
});

test('a tab without a node is top-level, whatever Chrome says its opener is', () => {
  // Chrome sets openerTabId to the active tab for Ctrl+T too, so it is not trusted.
  const tabs = tabsInOrder([1, 2], { 2: { openerTabId: 1 } });
  assert.equal(shape(buildForest(tabs, nodesFrom({ 1: null }))), '1 2');
});

test('corrupt parent cycles never hide tabs', () => {
  const forest = buildForest(tabsInOrder([1, 2, 3]), nodesFrom({ 1: 2, 2: 1, 3: 1 }));
  assert.deepEqual(displayOrder(forest).sort(), [1, 2, 3]);
});

test('subtree lists a tab and its descendants depth-first', () => {
  const forest = buildForest(searchTabs, searchNodes);
  assert.deepEqual(subtree(forest, 1), [1, 2, 3, 7, 8, 4, 5, 6]);
  assert.deepEqual(subtree(forest, 3), [3, 7, 8]);
  assert.deepEqual(subtree(forest, 8), [8]);
});

test('flatten leaves out the descendants of collapsed tabs and counts them', () => {
  const nodes = nodesFrom({ 1: null, 2: 1, 3: 2, 4: 1, 5: null }, [2]);
  const rows = flatten(buildForest(tabsInOrder([1, 2, 3, 4, 5]), nodes), nodes);
  assert.deepEqual(
    rows.map((r) => [r.id, r.depth, r.hasChildren, r.collapsed, r.descendants]),
    [
      [1, 0, true, false, 3],
      [2, 1, true, true, 1],
      [4, 1, false, false, 0],
      [5, 0, false, false, 0],
    ],
  );
});

test('filtering shows matches with their ancestors, even inside collapsed trees', () => {
  const nodes = nodesFrom({ 1: null, 2: 1, 3: 2, 4: 1, 5: null }, [1]);
  const rows = flatten(buildForest(tabsInOrder([1, 2, 3, 4, 5]), nodes), nodes, { matches: new Set([3]) });
  assert.deepEqual(
    rows.map((r) => [r.id, r.depth, r.dim, r.collapsed]),
    [
      [1, 0, true, false],
      [2, 1, true, false],
      [3, 2, false, false],
    ],
  );
});

test('closing a tab moves its children up to its parent', () => {
  const nodes = nodesFrom({ 1: null, 2: 1, 3: 2, 4: 2 });
  removeNode(nodes, 2);
  assert.deepEqual(nodes, nodesFrom({ 1: null, 3: 1, 4: 1 }));
  removeNode(nodes, 1);
  assert.deepEqual(nodes, nodesFrom({ 3: null, 4: null }));
});

test('a tree cannot be dropped into itself', () => {
  const forest = buildForest(searchTabs, searchNodes);
  const block = subtree(forest, 3);
  for (const position of ['before', 'afterTree', 'firstChild', 'lastChild']) {
    assert.equal(resolveDrop(forest, block, 7, position), null, position);
    assert.equal(resolveDrop(forest, block, 3, position), null, position);
  }
});

test('drop positions map to a parent and a native placement', () => {
  const forest = buildForest(searchTabs, searchNodes);
  assert.deepEqual(resolveDrop(forest, [5], 2, 'before'), { parent: 1, placement: { before: 2 } });
  assert.deepEqual(resolveDrop(forest, [6], 3, 'firstChild'), { parent: 3, placement: { after: 3 } });
  assert.deepEqual(resolveDrop(forest, [6], 3, 'lastChild'), { parent: 3, placement: { after: 8 } });
  assert.deepEqual(resolveDrop(forest, [2], 3, 'afterTree'), { parent: 1, placement: { after: 8 } });
  // The last tab of the target's tree is looked up without the dragged block.
  assert.deepEqual(resolveDrop(forest, [3, 7, 8], 1, 'lastChild'), { parent: 1, placement: { after: 6 } });
  assert.deepEqual(resolveDrop(forest, [3, 7, 8], null, 'end'), { parent: null, placement: { end: true } });
});

/** Chrome's tab strip: the moved tab is taken out and reinserted at `index`. */
function applyMoves(order, ops) {
  const current = [...order];
  for (const { tabId, index } of ops) {
    current.splice(current.indexOf(tabId), 1);
    current.splice(index, 0, tabId);
  }
  return current;
}

function expectedOrder(order, block, placement) {
  const rest = order.filter((id) => !block.includes(id));
  let at = rest.length;
  if (placement.before != null) at = rest.indexOf(placement.before);
  else if (placement.after != null) at = rest.indexOf(placement.after) + 1;
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

test('planned moves put the block together at its placement', () => {
  const random = seeded(7);
  const shuffle = (list) => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };

  for (let run = 0; run < 5000; run++) {
    const n = 1 + Math.floor(random() * 9);
    const order = shuffle(Array.from({ length: n }, (_, i) => i + 1));
    const block = shuffle([...order]).slice(0, 1 + Math.floor(random() * n));
    const rest = order.filter((id) => !block.includes(id));
    const pick = Math.floor(random() * (rest.length + 1));
    const placement = pick === rest.length
      ? { end: true }
      : { [random() < 0.5 ? 'before' : 'after']: rest[pick] };

    const ops = planBlockMove(order, block, placement);
    assert.deepEqual(
      applyMoves(order, ops),
      expectedOrder(order, block, placement),
      JSON.stringify({ order, block, placement }),
    );
  }
});

test('no moves are planned when the block is already in place', () => {
  assert.deepEqual(planBlockMove([1, 2, 3, 4], [2, 3], { before: 4 }), []);
  assert.deepEqual(planBlockMove([1, 2, 3, 4], [3, 4], { end: true }), []);
  assert.deepEqual(planBlockMove([1, 2, 3, 4], [2, 3], { after: 1 }), []);
});

// ---- tree colours ----

/** { top tab id: colour } as the panel draws them. */
const colorsOf = (forest, nodes) => Object.fromEntries(treeColors(forest, nodes));

/** A window's tabs and nodes, from [[id, parent], ...] in strip order. */
function windowOf(list, windowId = 1) {
  const tabs = list.map(([id], index) => ({ id, index, windowId, pinned: false }));
  return { tabs, nodes: nodesFrom(Object.fromEntries(list)) };
}

/** What the worker does after a change: store the colours of these windows' trees. */
const settle = (nodes, ...windows) => storeColors(windows.map((tabs) => buildForest(tabs, nodes)), nodes);

/** The same tabs in a new strip order. */
const reorder = (tabs, order) => order.map((id, index) => ({ ...tabs.find((t) => t.id === id), index }));

const tabAt = (id, index, windowId = 1) => ({ id, index, windowId, pinned: false });

test('trees take colours in turn from the top; single tabs get none', () => {
  // Trees 1, 4 and 6 with single tabs 3 and 8 between them.
  const { tabs, nodes } = windowOf([[1, null], [2, 1], [3, null], [4, null], [5, 4], [6, null], [7, 6], [8, null]]);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), { 1: 'blue', 4: 'orange', 6: 'pink' });
  assert.equal(settle(nodes, tabs), true);
  assert.deepEqual([nodes[1].color, nodes[4].color, nodes[6].color, nodes[3].color], ['blue', 'orange', 'pink', undefined]);
  assert.equal(settle(nodes, tabs), false, 'a second pass changes nothing');
});

test('a tree keeps its colour when the trees around it close, move or collapse', () => {
  let { tabs, nodes } = windowOf([[1, null], [2, 1], [3, null], [4, 3], [5, null], [6, 5]]);
  settle(nodes, tabs); // 1 blue, 3 orange, 5 pink
  tabs = reorder(tabs, [1, 3, 4, 5, 6]);
  removeNode(nodes, 2); // tree 1 is a single tab now
  settle(nodes, tabs);
  tabs = reorder(tabs, [5, 6, 1, 3, 4]);
  nodes[3].collapsed = true;
  settle(nodes, tabs);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), { 5: 'pink', 3: 'orange' });
});

test('a tab that stops heading a tree gets its colour back, and new trees leave it alone', () => {
  // 1 and 3 are trees, 5 a single tab just below 3.
  let { tabs, nodes } = windowOf([[1, null], [2, 1], [3, null], [4, 3], [5, null]]);
  settle(nodes, tabs); // 1 blue, 3 orange
  tabs = reorder(tabs, [1, 2, 3, 5]);
  removeNode(nodes, 4); // tree 3 loses its only child
  settle(nodes, tabs);
  assert.deepEqual([nodes[3].color, nodes[3].lastColor], [undefined, 'orange']);
  nodes[6] = { parent: 5, collapsed: false }; // a link opened from 5 makes it a tree
  tabs = [...tabs, tabAt(6, 4)];
  settle(nodes, tabs);
  nodes[7] = { parent: 3, collapsed: false }; // 3 heads a tree again
  tabs = reorder([...tabs, tabAt(7, 5)], [1, 2, 3, 7, 5, 6]);
  settle(nodes, tabs);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), { 1: 'blue', 3: 'orange', 5: 'pink' });
});

test('a tree dropped into another is drawn in its shades, and gets its colour back when dragged out', () => {
  const { tabs, nodes } = windowOf([[1, null], [2, 1], [3, null], [4, 3]]);
  settle(nodes, tabs); // 1 blue, 3 orange
  nodes[3].parent = 1;
  settle(nodes, tabs);
  const forest = buildForest(tabs, nodes);
  assert.deepEqual(flatten(forest, nodes, { colors: treeColors(forest, nodes) }).map((r) => r.color), ['blue', 'blue', 'blue', 'blue']);
  assert.equal(nodes[3].lastColor, 'orange');
  nodes[3].parent = null;
  settle(nodes, tabs);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), { 1: 'blue', 3: 'orange' });
});

test('"Move to top level" gives a subtree a colour of its own, also after its tree was pinned', () => {
  // 1 heads a tree: the subtree 2(3) and the single tab 4.
  let { tabs, nodes } = windowOf([[1, null], [2, 1], [3, 2], [4, 1]]);
  settle(nodes, tabs);
  settle(nodes, tabs.map((t) => (t.id === 1 ? { ...t, pinned: true } : t))); // 2 carries on in blue
  settle(nodes, tabs); // unpinned: 1 takes blue back
  nodes[2].parent = null; // moved to the top level, right after its old tree
  tabs = reorder(tabs, [1, 4, 2, 3]);
  settle(nodes, tabs);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), { 1: 'blue', 2: 'orange' });
});

test('closing the top of a tree: its first subtree carries on in its colour, before and after the worker forgets it', () => {
  // 1 heads the subtrees 2(3) and 5(6) and the single tab 4; 7(8) is another tree.
  let { tabs, nodes } = windowOf([[1, null], [2, 1], [3, 2], [4, 1], [5, 1], [6, 5], [7, null], [8, 7]]);
  settle(nodes, tabs); // 1 blue, 7 orange
  tabs = reorder(tabs, [2, 3, 4, 5, 6, 7, 8]);
  const early = colorsOf(buildForest(tabs, nodes), nodes); // the panel, before the worker hears of it
  removeNode(nodes, 1);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), early);
  assert.deepEqual(early, { 2: 'blue', 5: 'pink', 7: 'orange' });
  settle(nodes, tabs);
  assert.equal(nodes[4].heir, 'blue', 'the single tab is handed it');
});

test('closing the top of a tree draws the same colours before and after the worker forgets it, with many trees too', () => {
  // Eight trees in the eight colours, then tree 1 (blue again), which heads the single tab 2 and
  // the subtree 3(4). With more trees than colours, 3 carries on blue although tree 100 has it.
  const list = [];
  for (let k = 0; k < 8; k++) list.push([100 + k, null], [200 + k, 100 + k]);
  let { tabs, nodes } = windowOf([...list, [1, null], [2, 1], [3, 1], [4, 3]]);
  settle(nodes, tabs);
  assert.equal(nodes[1].color, 'blue');
  tabs = tabs.filter((t) => t.id !== 1);
  const early = colorsOf(buildForest(tabs, nodes), nodes);
  removeNode(nodes, 1);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), early);
  settle(nodes, tabs);
  assert.equal(nodes[3].color, early[3]);
  assert.equal(early[3], 'blue');

  // The blue tree 10(11), and the orange tree 1 with the subtree 2(3), which headed a blue tree
  // once, and the single tab 4. Blue is taken, so 2 carries on orange.
  ({ tabs, nodes } = windowOf([[10, null], [11, 10], [1, null], [2, 1], [3, 2], [4, 1]]));
  settle(nodes, tabs);
  nodes[2].lastColor = 'blue';
  tabs = tabs.filter((t) => t.id !== 1);
  const before = colorsOf(buildForest(tabs, nodes), nodes);
  removeNode(nodes, 1);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), before);
  assert.deepEqual(before, { 10: 'blue', 2: 'orange' });
});

test('a new tree leaves alone the colour a closed tab hands down, also before the worker forgets the tab', () => {
  // Trees 1, 3 and 5 are blue, orange and pink. 7, pinned, was in a green tree, and 8 was opened
  // from it. 7 closes just as a link opened from 9 makes 9 a tree.
  const { tabs, nodes } = windowOf([[1, null], [2, 1], [3, null], [4, 3], [5, null], [6, 5], [8, 7], [9, null], [10, 9]]);
  nodes[1].color = 'blue';
  nodes[3].color = 'orange';
  nodes[5].color = 'pink';
  nodes[7] = { parent: null, collapsed: false, heir: 'green' };
  const early = colorsOf(buildForest(tabs, nodes), nodes);
  removeNode(nodes, 7);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), early);
  assert.equal(early[9], 'cyan');
});

test('a subtree that headed a tree before takes its colour back if it is free, and the next subtree carries on', () => {
  // Tree 1 (blue) heads 2(3), which headed a green tree once, and 4(5).
  const closeTop = (green) => {
    const { tabs, nodes } = windowOf([[1, null], [2, 1], [3, 2], [4, 1], [5, 4], ...(green ? [[6, null], [7, 6]] : [])]);
    settle(nodes, tabs);
    if (green) nodes[6].color = 'green';
    nodes[2].lastColor = 'green';
    const rest = tabs.filter((t) => t.id !== 1);
    removeNode(nodes, 1);
    return colorsOf(buildForest(rest, nodes), nodes);
  };
  assert.deepEqual(closeTop(false), { 2: 'green', 4: 'blue' });
  // Another tree is green: 2 carries on blue itself, and 4 takes a new colour.
  assert.deepEqual(closeTop(true), { 2: 'blue', 4: 'orange', 6: 'green' });
});

test('a new tree never takes the colour that a tree further down carries on', () => {
  // 1 (blue) heads 2(3) and closes; in the same pass the single tab 5 above it becomes a tree.
  const { tabs, nodes } = windowOf([[5, null], [1, null], [2, 1], [3, 2]]);
  settle(nodes, tabs);
  assert.equal(nodes[1].color, 'blue');
  nodes[6] = { parent: 5, collapsed: false };
  removeNode(nodes, 1);
  const now = [tabAt(5, 0), tabAt(6, 1), tabAt(2, 2), tabAt(3, 3)];
  assert.deepEqual(colorsOf(buildForest(now, nodes), nodes), { 5: 'orange', 2: 'blue' });
});

test('with more trees than colours, only the first subtree carries on the colour of its tree', () => {
  // Eight trees in the eight colours, then tree 1 (blue again) with the subtrees 2(3), 4(5), 6(7).
  const list = [];
  for (let k = 0; k < 8; k++) list.push([100 + k, null], [200 + k, 100 + k]);
  const { tabs, nodes } = windowOf([...list, [1, null], [2, 1], [3, 2], [4, 1], [5, 4], [6, 1], [7, 6]]);
  settle(nodes, tabs);
  const rest = tabs.filter((t) => t.id !== 1);
  removeNode(nodes, 1);
  const colors = colorsOf(buildForest(rest, nodes), nodes);
  assert.equal(colors[2], 'blue');
  assert.notEqual(colors[4], 'blue');
  assert.notEqual(colors[6], 'blue');
});

test('with more trees than colours, the next subtree carries the colour on when the first has a tree of it next to it', () => {
  // Nine trees, the last (108) blue and right above the blue tree 1, which heads 2(3) and 4(5). 1
  // closes: 2 has 108 above it, so 4 carries blue on.
  const kept = ['blue', 'orange', 'pink', 'green', 'cyan', 'purple', 'red', 'yellow', 'blue'];
  const list = kept.flatMap((color, k) => [[100 + k, null], [200 + k, 100 + k]]);
  let { tabs, nodes } = windowOf([...list, [1, null], [2, 1], [3, 2], [4, 1], [5, 4]]);
  kept.forEach((color, k) => { nodes[100 + k].color = color; });
  nodes[1].color = 'blue';
  settle(nodes, tabs);
  tabs = tabs.filter((t) => t.id !== 1);
  const early = colorsOf(buildForest(tabs, nodes), nodes);
  removeNode(nodes, 1);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), early);
  assert.notEqual(early[2], 'blue');
  assert.equal(early[4], 'blue');
});

test('up to eight trees, a colour picked for two trees is not carried on', () => {
  // 1 is blue as the first tree, and 3 is set to blue by hand, with the tree 7 between them. 3
  // closes, and its subtree 4(5) takes a free colour.
  const { tabs, nodes } = windowOf([[1, null], [2, 1], [7, null], [8, 7], [3, null], [4, 3], [5, 4]]);
  settle(nodes, tabs);
  nodes[3].color = 'blue';
  settle(nodes, tabs);
  const rest = tabs.filter((t) => t.id !== 3);
  removeNode(nodes, 3);
  assert.deepEqual(colorsOf(buildForest(rest, nodes), nodes), { 1: 'blue', 7: 'orange', 4: 'pink' });
});

test('with more trees than colours, a subtree keeps the free colour it is drawn in rather than take back one another tree has', () => {
  // Eight trees, red among them; then 1 (the only yellow tree) heads the single tab 2 and the red
  // tree 3(4), dropped into it. 1 closes.
  const kept = ['blue', 'orange', 'pink', 'green', 'cyan', 'purple', 'red', 'blue'];
  const list = kept.flatMap((color, k) => [[100 + k, null], [200 + k, 100 + k]]);
  let { tabs, nodes } = windowOf([...list, [1, null], [2, 1], [3, null], [4, 3]]);
  kept.forEach((color, k) => { nodes[100 + k].color = color; });
  nodes[1].color = 'yellow';
  nodes[3].color = 'red';
  settle(nodes, tabs);
  nodes[3].parent = 1;
  settle(nodes, tabs);
  assert.deepEqual([nodes[3].lastColor, nodes[3].heir], ['red', 'yellow']);
  tabs = tabs.filter((t) => t.id !== 1);
  const early = colorsOf(buildForest(tabs, nodes), nodes);
  removeNode(nodes, 1);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), early);
  assert.equal(early[3], 'yellow');
});

test('with more trees than colours, a subtree carries on a shared colour rather than take back one of its own that a tree further away has', () => {
  // Eight trees, red among them; 1 is blue like 100. The red tree 3(4) is dropped into 1, then 1
  // closes: no tree next to 3 is blue, so 3 carries blue on.
  const kept = ['blue', 'orange', 'pink', 'green', 'cyan', 'purple', 'red', 'yellow'];
  const list = kept.flatMap((color, k) => [[100 + k, null], [200 + k, 100 + k]]);
  let { tabs, nodes } = windowOf([...list, [1, null], [2, 1], [3, null], [4, 3]]);
  kept.forEach((color, k) => { nodes[100 + k].color = color; });
  nodes[1].color = 'blue';
  nodes[3].color = 'red';
  settle(nodes, tabs);
  nodes[3].parent = 1;
  settle(nodes, tabs);
  tabs = tabs.filter((t) => t.id !== 1);
  const early = colorsOf(buildForest(tabs, nodes), nodes);
  removeNode(nodes, 1);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), early);
  assert.equal(early[3], 'blue');
});

test('with more trees than colours, a subtree carries the colour on as its top tab closes, also when a tab under it that holds the colour closes and links open from both meanwhile', () => {
  // Nine trees, two of them blue, then tree 1 (blue too), which heads 2(3). Links opened from 2
  // and 3 add 4 and 5, and 1 and 3 close, all at once: 2 carries on blue before, between and
  // after the worker forgets 3 and 1.
  const kept = ['blue', 'orange', 'blue', 'pink', 'green', 'cyan', 'purple', 'red', 'yellow'];
  const list = kept.flatMap((color, k) => [[100 + k, null], [200 + k, 100 + k]]);
  let { tabs, nodes } = windowOf([...list, [1, null], [2, 1], [3, 2]]);
  kept.forEach((color, k) => { nodes[100 + k].color = color; });
  nodes[1].color = 'blue';
  settle(nodes, tabs);
  Object.assign(nodes, nodesFrom({ 4: 2, 5: 3 }));
  tabs = [...tabs.filter((t) => t.id !== 1 && t.id !== 3), tabAt(4, 100), tabAt(5, 101)];
  const drawn = [colorsOf(buildForest(tabs, nodes), nodes)];
  removeNode(nodes, 3);
  drawn.push(colorsOf(buildForest(tabs, nodes), nodes));
  removeNode(nodes, 1);
  drawn.push(colorsOf(buildForest(tabs, nodes), nodes));
  assert.deepEqual(drawn.map((colors) => colors[2]), ['blue', 'blue', 'blue']);
});

test('with more trees than colours, a tab with no colour of its own, handed one that other trees have, takes a new colour as new trees do when a link makes it a tree', () => {
  // Nine trees, red on two of them far up, and none yellow. The single tab 1 was handed red when
  // the top of its tree closed; a link opened from it makes it a tree.
  const kept = ['blue', 'red', 'orange', 'pink', 'green', 'red', 'cyan', 'purple', 'blue'];
  const list = kept.flatMap((color, k) => [[100 + k, null], [200 + k, 100 + k]]);
  let { tabs, nodes } = windowOf([...list, [1, null]]);
  kept.forEach((color, k) => { nodes[100 + k].color = color; });
  nodes[1].heir = 'red';
  settle(nodes, tabs);
  nodes[2] = { parent: 1, collapsed: false };
  tabs = [...tabs, tabAt(2, tabs.length)];
  settle(nodes, tabs);
  assert.equal(nodes[1].color, 'yellow');
});

test('with more trees than colours, trees grown from a pinned tab do not all take the colour it holds', () => {
  // Nine trees, pink on one far up, yellow on none. 10 is pinned and holds pink from the tree 9(10)
  // it was in. A tab opened from 10, and a link from that tab: the new tree inherits pink from 10,
  // but was never drawn in it, so it takes the colour no tree has.
  const kept = ['blue', 'pink', 'orange', 'green', 'cyan', 'purple', 'red', 'blue', 'orange'];
  const list = kept.flatMap((color, k) => [[100 + k, null], [200 + k, 100 + k]]);
  let { tabs, nodes } = windowOf([...list, [9, null], [10, 9]]);
  kept.forEach((color, k) => { nodes[100 + k].color = color; });
  nodes[9].color = 'pink';
  settle(nodes, tabs);
  tabs = tabs.filter((t) => t.id !== 9);
  removeNode(nodes, 9);
  settle(nodes, tabs);
  tabs = tabs.map((t) => (t.id === 10 ? { ...t, pinned: true, index: -1 } : t));
  settle(nodes, tabs);
  assert.equal(nodes[10].heir, 'pink');
  Object.assign(nodes, nodesFrom({ 20: 10, 21: 20 }));
  tabs = [...tabs, tabAt(20, 100), tabAt(21, 101)];
  settle(nodes, tabs);
  assert.equal(nodes[20].color, 'yellow');
});

test('with more trees than colours, a tree gets its own colour back though a tree further away has it', () => {
  // Ten trees; 100 is set to yellow by hand, like 107. 100 loses its only child, then heads a tree again.
  const list = [];
  for (let k = 0; k < 10; k++) list.push([100 + k, null], [200 + k, 100 + k]);
  let { tabs, nodes } = windowOf(list);
  settle(nodes, tabs);
  assert.equal(nodes[107].color, 'yellow');
  nodes[100].color = 'yellow';
  settle(nodes, tabs);
  tabs = tabs.filter((t) => t.id !== 200);
  removeNode(nodes, 200);
  settle(nodes, tabs);
  assert.equal(nodes[100].lastColor, 'yellow');
  nodes[300] = { parent: 100, collapsed: false };
  tabs = [...tabs, tabAt(300, tabs.length)];
  settle(nodes, tabs);
  assert.equal(nodes[100].color, 'yellow');
});

test('a tree moved into a window with eight trees keeps its colour, unless it lands next to a tree of that colour', () => {
  // Window 2 has eight trees in the eight colours, pink third from the top. The pink tree 1(2)
  // moves in at the end, or right after the pink tree.
  for (const after of [null, 202]) {
    const there = [];
    for (let k = 0; k < 8; k++) there.push([100 + k, null], [200 + k, 100 + k]);
    const nodes = nodesFrom({ ...Object.fromEntries(there), 1: null, 2: 1 });
    const strip = there.map(([id]) => id);
    settle(nodes, strip.map((id, index) => tabAt(id, index, 2)), [tabAt(1, 0, 1), tabAt(2, 1, 1)]);
    nodes[1].color = 'pink';
    settle(nodes, [tabAt(1, 0, 1), tabAt(2, 1, 1)]);
    rememberColor(nodes[1]); // as moveTree does
    strip.splice(after == null ? strip.length : strip.indexOf(after) + 1, 0, 1, 2);
    const moved = strip.map((id, index) => tabAt(id, index, 2));
    settle(nodes, moved);
    if (after == null) assert.equal(nodes[1].color, 'pink', 'at the end');
    else assert.notEqual(nodes[1].color, 'pink', 'right after the pink tree');
  }
});

test('the first subtree carries on the colour of the tree it was in, whatever tab sits above it', () => {
  // Tree 1 (blue) heads the single tab 2 and 3, which headed an orange tree once and heads 4(5).
  // Then 3 is pinned, moved to another window on its own, or closed together with 1.
  const start = () => {
    const { tabs, nodes } = windowOf([[1, null], [2, 1], [3, 1], [4, 3], [5, 4]]);
    settle(nodes, tabs);
    nodes[3].lastColor = 'orange';
    return { tabs, nodes };
  };
  const without = (tabs, ...ids) => tabs.filter((t) => !ids.includes(t.id));

  let { tabs, nodes } = start();
  tabs = tabs.map((t) => (t.id === 3 ? { ...t, pinned: true } : t));
  settle(nodes, tabs); // 4(5) is in tree 1 now
  tabs = without(tabs, 1);
  removeNode(nodes, 1);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), { 4: 'blue' });

  ({ tabs, nodes } = start());
  nodes[6] = { parent: 3, collapsed: false }; // in the other window, 3 heads the tree 3(6)
  tabs = without(tabs, 3);
  settle(nodes, tabs, [tabAt(3, 0, 2), tabAt(6, 1, 2)]);
  assert.equal(nodes[3].color, 'orange');
  tabs = without(tabs, 1);
  removeNode(nodes, 1);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), { 4: 'blue' });

  ({ tabs, nodes } = start());
  tabs = without(tabs, 1, 3);
  const early = colorsOf(buildForest(tabs, nodes), nodes);
  removeNode(nodes, 3);
  removeNode(nodes, 1);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), early);
  assert.deepEqual(early, { 4: 'blue' });
});

test('a colour handed down by a closed tab gives way to the tree the tab moves into', () => {
  // Search 1 (blue) with the results 2, 3 and 4; Orders 5 (orange) with 6.
  const joined = () => {
    let { tabs, nodes } = windowOf([[1, null], [2, 1], [3, 1], [4, 1], [5, null], [6, 5]]);
    settle(nodes, tabs);
    tabs = tabs.filter((t) => t.id !== 1);
    removeNode(nodes, 1); // Search closes: its results are handed blue
    settle(nodes, tabs);
    assert.deepEqual([nodes[2].heir, nodes[3].heir, nodes[4].heir], ['blue', 'blue', 'blue']);
    nodes[3].parent = 5; // 3 is dropped into Orders, and a link opened from it makes it a subtree
    nodes[7] = { parent: 3, collapsed: false };
    tabs = reorder([...tabs, tabAt(7, 6)], [2, 4, 5, 6, 3, 7]);
    settle(nodes, tabs);
    assert.deepEqual([nodes[3].heir, nodes[7].heir], ['orange', 'orange']);
    return { tabs, nodes };
  };

  let { tabs, nodes } = joined();
  tabs = tabs.filter((t) => t.id !== 5);
  removeNode(nodes, 5); // Orders closes: 3's subtree carries on in orange
  settle(nodes, tabs);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), { 3: 'orange' });

  ({ tabs, nodes } = joined());
  tabs = tabs.map((t) => (t.id === 5 ? { ...t, pinned: true } : t)); // Orders is pinned instead
  settle(nodes, tabs);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), { 3: 'orange' });

  // The tree 8(9) is dropped into Orders 5, then 8 closes and 9 heads a subtree: when Orders
  // closes, 9 carries on Orders' colour, not the one 8 had.
  ({ tabs, nodes } = windowOf([[5, null], [6, 5], [8, null], [9, 8]]));
  settle(nodes, tabs); // 5 blue, 8 orange
  nodes[8].parent = 5;
  settle(nodes, tabs);
  tabs = tabs.filter((t) => t.id !== 8);
  removeNode(nodes, 8);
  nodes[10] = { parent: 9, collapsed: false };
  tabs = [...tabs, tabAt(10, 4)];
  settle(nodes, tabs);
  tabs = tabs.filter((t) => t.id !== 5);
  removeNode(nodes, 5);
  settle(nodes, tabs);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), { 9: 'blue' });
});

test('pinning the top of a tree and unpinning it gives the same colours back', () => {
  const { tabs, nodes } = windowOf([[1, null], [2, 1], [3, 2], [4, 1], [5, null], [6, 5]]);
  settle(nodes, tabs); // 1 blue, 5 orange
  const pinned = tabs.map((t) => (t.id === 1 ? { ...t, pinned: true } : t));
  assert.deepEqual(colorsOf(buildForest(pinned, nodes), nodes), { 2: 'blue', 5: 'orange' });
  settle(nodes, pinned);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), { 1: 'blue', 5: 'orange' });
  settle(nodes, tabs);
  assert.deepEqual([nodes[1].color, nodes[2].color, nodes[2].lastColor], ['blue', undefined, 'blue']);
});

test('up to eight trees all differ; beyond that a new tree avoids the trees next to it', () => {
  const list = [];
  for (let k = 0; k < 20; k++) list.push([100 + k, null], [200 + k, 100 + k]);
  const { tabs, nodes } = windowOf(list);
  settle(nodes, tabs);
  const colors = Object.values(colorsOf(buildForest(tabs, nodes), nodes));
  assert.deepEqual(colors.slice(0, 8), NEW_TREE_COLORS);
  colors.slice(1).forEach((color, i) => assert.notEqual(color, colors[i], `trees ${i} and ${i + 1}`));
  const counts = {};
  for (const color of colors) counts[color] = (counts[color] ?? 0) + 1;
  assert.equal(counts.grey, undefined, 'grey is only picked by hand');
  assert.ok(Math.max(...Object.values(counts)) - Math.min(...Object.values(counts)) <= 1, JSON.stringify(counts));
});

test('beyond eight trees a new tree never takes the colour of the tree next to it, even the least used one', () => {
  // Fifteen kept trees: blue once, every other colour twice. The new tree 1 comes right after
  // the blue tree, then right before it.
  const kept = ['blue', ...NEW_TREE_COLORS.slice(1).flatMap((color) => [color, color])];
  for (const after of [true, false]) {
    const list = kept.flatMap((color, k) => [[100 + k, null], [200 + k, 100 + k]]);
    list.splice(after ? 2 : 0, 0, [1, null], [2, 1]);
    const { tabs, nodes } = windowOf(list);
    kept.forEach((color, k) => { nodes[100 + k].color = color; });
    settle(nodes, tabs);
    assert.notEqual(nodes[1].color, 'blue', after ? 'right after the blue tree' : 'right before it');
  }
});

test('kept colours never change, even shared or picked ones', () => {
  const { tabs, nodes } = windowOf([[1, null], [2, 1], [3, null], [4, 3]]);
  nodes[1].color = 'grey'; // picked from the menu
  nodes[3].color = 'grey';
  settle(nodes, tabs);
  assert.deepEqual([nodes[1].color, nodes[3].color], ['grey', 'grey']);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), { 1: 'grey', 3: 'grey' });
});

test('every tab inside a tree holds the colour of its tree, and a pass that only changes that says so', () => {
  const nodes = nodesFrom({ 1: null, 2: 1, 3: 2 });
  nodes[1].color = 'cyan';
  const tabs = tabsInOrder([1, 2, 3]);
  assert.equal(settle(nodes, tabs), true);
  assert.deepEqual([nodes[2].heir, nodes[3].heir], ['cyan', 'cyan']);
  assert.equal(settle(nodes, tabs), false);
});

test('a tree moved to another window keeps its colour there, unless a tree there has it', () => {
  const nodes = nodesFrom({ 1: null, 2: 1, 3: null, 4: 3, 9: null });
  settle(nodes, [tabAt(1, 0, 1), tabAt(2, 1, 1)], [tabAt(3, 0, 2), tabAt(4, 1, 2)], [tabAt(9, 0, 3)]); // 1 and 3 blue
  rememberColor(nodes[1]); // 1(2) moves into window 2, after 3(4)
  const second = [tabAt(3, 0, 2), tabAt(4, 1, 2), tabAt(1, 2, 2), tabAt(2, 3, 2)];
  settle(nodes, second);
  assert.deepEqual(colorsOf(buildForest(second, nodes), nodes), { 3: 'blue', 1: 'orange' });
  rememberColor(nodes[1]); // then on into window 3, where no tree has orange
  const third = [tabAt(9, 0, 3), tabAt(1, 1, 3), tabAt(2, 2, 3)];
  settle(nodes, third);
  assert.deepEqual(colorsOf(buildForest(third, nodes), nodes), { 1: 'orange' });
});

test('storeColors decides every window before it stores any', () => {
  // 3 (window 2) was opened from 1 (window 1), and both become trees in the same pass: 3 is
  // decided from what 1 has now, as window 2's panel draws it, whichever window comes first.
  const a = [tabAt(0, 0, 1), tabAt(9, 1, 1), tabAt(1, 2, 1), tabAt(2, 3, 1)];
  const b = [tabAt(3, 0, 2), tabAt(4, 1, 2)];
  const start = () => {
    const nodes = nodesFrom({ 0: null, 9: 0, 1: null, 2: 1, 3: 1, 4: 3 });
    nodes[0].color = 'blue';
    return nodes;
  };
  const one = start();
  const two = start();
  const drawn = colorsOf(buildForest(b, one), one);
  settle(one, a, b);
  settle(two, b, a);
  assert.deepEqual(one, two);
  assert.deepEqual([one[1].color, one[3].color], ['orange', 'blue']);
  assert.deepEqual(drawn, { 3: 'blue' });
});

test('a window\'s colours stored alone can change those of another: colorsReachOtherWindows tells when', () => {
  // Window 1: the blue tree 1(2), and 3(4), which no pass has stored yet. Window 2: 5(6), 5 opened
  // from 3 and dragged there; 3 holds no colour yet, so window 2's panel draws 5's tree blue.
  const one = [tabAt(1, 0, 1), tabAt(2, 1, 1), tabAt(3, 2, 1), tabAt(4, 3, 1)];
  const two = [tabAt(5, 0, 2), tabAt(6, 1, 2)];
  const start = () => {
    const nodes = nodesFrom({ 1: null, 2: 1, 3: null, 4: 3, 5: 3, 6: 5 });
    nodes[1].color = 'blue';
    nodes[2].heir = 'blue';
    return nodes;
  };
  const nodes = start();
  assert.deepEqual(colorsOf(buildForest(two, nodes), nodes), { 5: 'blue' });
  assert.equal(colorsReachOtherWindows(one, nodes), true);
  assert.deepEqual(nodes, start(), 'it changes no node');
  const alone = start();
  settle(alone, one); // 3 gets orange, which 5 then carries on
  assert.deepEqual(colorsOf(buildForest(two, alone), alone), { 5: 'orange' });
  settle(nodes, one, two);
  assert.deepEqual(colorsOf(buildForest(two, nodes), nodes), { 5: 'blue' });
  assert.equal(colorsReachOtherWindows(one, nodes), false, 'once they are stored');
  const unlinked = start();
  unlinked[5].parent = null;
  assert.equal(colorsReachOtherWindows(one, unlinked), false, 'with no tab elsewhere whose parent is in window 1');
});

/**
 * Three windows of random tabs, for `random` (see seeded). A tab was opened from an earlier tab of
 * its window, from one in another window (dragged there since), or from one just closed that the
 * worker has not forgotten yet; any tab may hold any colour, stored or not.
 */
function randomWindows(random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const tabs = [];
  for (let windowId = 1; windowId <= 3; windowId++) {
    const n = 2 + Math.floor(random() * (random() < 0.2 ? 14 : 7));
    for (let index = 0; index < n; index++) tabs.push({ id: tabs.length + 1, index, windowId, pinned: index < 2 && random() < 0.15 });
  }
  const closed = [tabs.length + 1, tabs.length + 2];
  const nodes = {};
  for (const id of [...tabs.map((t) => t.id), ...closed]) {
    const tab = tabs.find((t) => t.id === id);
    const same = tabs.filter((t) => tab && t.windowId === tab.windowId && t.index < tab.index);
    const r = random();
    let parent = null;
    if (r < 0.45 && same.length) parent = pick(same).id;
    else if (r < 0.6) parent = pick(tabs.filter((t) => t.windowId !== tab?.windowId)).id;
    else if (r < 0.7) parent = pick(closed.filter((other) => other !== id));
    const node = { parent, collapsed: false };
    for (const [key, chance] of [['color', 0.35], ['lastColor', 0.2], ['heir', 0.3]]) {
      if (random() < chance) node[key] = pick(TREE_COLORS);
    }
    nodes[id] = node;
  }
  return { nodes, windows: [1, 2, 3].map((w) => tabs.filter((t) => t.windowId === w)) };
}

test('random windows: storing one alone changes another only when colorsReachOtherWindows says it may', () => {
  const random = seeded(3);
  let needed = 0;
  for (let run = 0; run < 3000; run++) {
    const { nodes, windows } = randomWindows(random);
    const drawn = (nodes) => windows.map((list) => [...treeColors(buildForest(list, nodes), nodes)]);
    const before = drawn(nodes);
    const copy = structuredClone(nodes);
    const reaches = colorsReachOtherWindows(windows[0], nodes);
    assert.deepEqual(nodes, copy, 'colorsReachOtherWindows changes no node');
    settle(copy, windows[0]);
    const after = drawn(copy);
    assert.deepEqual(after[0], before[0], 'window 1 draws the same once its colours are stored');
    if (!reaches) assert.deepEqual(after.slice(1), before.slice(1), 'the other windows draw the same once window 1\'s are stored alone');
    else if (!isDeepStrictEqual(after.slice(1), before.slice(1))) needed++;
    settle(nodes, ...windows);
    assert.deepEqual(drawn(nodes), before, 'every window draws the same once all are stored');
  }
  assert.ok(needed > 0, 'some runs need every window stored');
});

test('a tree moved to a new window keeps its colour, and so does a tree elsewhere that takes its colour from the top tab', () => {
  // Window 1: the pink tree 1(2), stored. Window 2: 5(6), 5 opened from 1 into a window of its own
  // (Shift+click), which no pass has stored yet: window 2's panel draws it pink.
  const one = [tabAt(1, 0, 1), tabAt(2, 1, 1)];
  const two = [tabAt(5, 0, 2), tabAt(6, 1, 2)];
  const start = () => {
    const nodes = nodesFrom({ 1: null, 2: 1, 5: 1, 6: 5 });
    nodes[1].color = 'pink';
    nodes[2].heir = 'pink';
    return nodes;
  };
  const nodes = start();
  assert.deepEqual(colorsOf(buildForest(two, nodes), nodes), { 5: 'pink' });
  assert.equal(colorsReachOtherWindows(one, nodes, 1), false, 'storing window 1\'s colours alone, or the move, changes nothing there');
  // 1(2) in a window of its own, where 1 keeps its colour (see attached in background.js).
  const moved = [tabAt(1, 0, 3), tabAt(2, 1, 3)];
  settle(nodes, two, moved);
  assert.deepEqual([colorsOf(buildForest(moved, nodes), nodes), colorsOf(buildForest(two, nodes), nodes)], [{ 1: 'pink' }, { 5: 'pink' }]);
  const forgot = start();
  rememberColor(forgot[1]); // as a tab dragged to another window does
  assert.deepEqual(colorsOf(buildForest(two, forgot), forgot), { 5: 'blue' }, 'had 1 let go of its colour, 5\'s tree would take another');
});

test('a tree moved to a new window lets go of its top tab\'s parent: colorsReachOtherWindows tells when that can change a tree elsewhere', () => {
  // Window 1: the pink tree 1(2), 1 opened from 10 in window 2. Window 2: the blue tree 10(11), 11
  // opened from 1 and dragged there (it hangs under 10 through 1), and 12(13), which no pass has
  // stored yet: 12 asks for the blue it had, which 10's tree has, so window 2's panel draws it orange.
  const one = [tabAt(1, 0, 1), tabAt(2, 1, 1)];
  const two = [tabAt(10, 0, 2), tabAt(11, 1, 2), tabAt(12, 2, 2), tabAt(13, 3, 2)];
  const start = () => {
    const nodes = nodesFrom({ 1: 10, 2: 1, 10: null, 11: 1, 12: null, 13: 12 });
    nodes[1].color = 'pink';
    nodes[2].heir = 'pink';
    nodes[10].color = 'blue';
    nodes[11].heir = 'blue';
    nodes[12].lastColor = 'blue';
    return nodes;
  };
  const nodes = start();
  assert.deepEqual(colorsOf(buildForest(two, nodes), nodes), { 10: 'blue', 12: 'orange' });
  assert.equal(colorsReachOtherWindows(one, nodes), false, 'storing window 1\'s colours alone changes nothing');
  assert.equal(colorsReachOtherWindows(one, nodes, 1), true, 'moving 1\'s tree can');
  assert.deepEqual(nodes, start(), 'it changes no node');
  const moved = (nodes) => {
    nodes[1].parent = null;
    return colorsOf(buildForest(two, nodes), nodes);
  };
  assert.deepEqual(moved(start()), { 12: 'blue' }, 'then 11 hangs under nothing there, and 12 gets its blue');
  const stored = start();
  settle(stored, one, two);
  assert.deepEqual(moved(stored), { 12: 'orange' }, 'unless every window\'s colours are stored first');
  assert.equal(colorsReachOtherWindows(one, nodes, 2), false, 'moving 2 alone: nothing elsewhere hangs from it');
  const below = start();
  below[11].parent = 2;
  assert.equal(colorsReachOtherWindows(one, below, 2), true, 'unless something does, and the tabs 2 hangs from lead out of window 1');
  below[1].parent = null;
  assert.equal(colorsReachOtherWindows(one, below, 2), false, 'they do not');
  // 11 can also hang there through a tab of window 1 outside 2's tree: 3, opened from 2 and pinned.
  const withPinned = [{ ...tabAt(3, 0, 1), pinned: true }, tabAt(1, 1, 1), tabAt(2, 2, 1)];
  const through = start();
  through[3] = { parent: 2, collapsed: false };
  through[11].parent = 3;
  assert.deepEqual(colorsOf(buildForest(two, through), through), { 10: 'blue', 12: 'orange' });
  assert.equal(colorsReachOtherWindows(withPinned, through, 2), true, 'so can a tab of its window outside its tree, such as a pinned one');
  through[2].parent = null;
  assert.deepEqual(colorsOf(buildForest(two, through), through), { 12: 'blue' }, 'once 2 has no parent, 11 hangs under nothing');
  // 21, a tab that heads no tree and holds no tree colour (only the red it had when it headed one,
  // which is never handed down), was opened from 20, pinned, which holds green as the colour of the
  // tree it was in. 22(23), opened from 21 elsewhere, takes that green through 21, until 21 has no
  // parent.
  const pinned = [{ ...tabAt(20, 0, 1), pinned: true }, tabAt(21, 1, 1)];
  const elsewhere = [tabAt(22, 0, 2), tabAt(23, 1, 2)];
  const lone = nodesFrom({ 20: null, 21: 20, 22: 21, 23: 22 });
  lone[20].heir = 'green';
  lone[21].lastColor = 'red';
  assert.deepEqual(colorsOf(buildForest(elsewhere, lone), lone), { 22: 'green' });
  assert.equal(colorsReachOtherWindows(pinned, lone), false, 'storing its window\'s colours alone changes nothing');
  assert.equal(colorsReachOtherWindows(pinned, lone, 21), true, 'moving 21 can, though its parent is in its window');
  lone[21].parent = null;
  assert.deepEqual(colorsOf(buildForest(elsewhere, lone), lone), { 22: 'blue' });
});

test('random windows: moving a tree to a new window changes another only when colorsReachOtherWindows says it may', () => {
  // What the worker does (see moveToNewWindow and attached): store the colours of the tree's window
  // alone, or every window's when colorsReachOtherWindows says so; move the tree to a window of its
  // own, its top tab without its parent, the other tabs without their colours; then store every
  // window's. Compared with every window's stored first. Most of the time every window was stored
  // before the last few changes.
  const random = seeded(12);
  const pick = (list) => list[Math.floor(random() * list.length)];
  let needed = 0;
  for (let run = 0; run < 3000; run++) {
    const { nodes, windows } = randomWindows(random);
    const tabs = windows.flat();
    if (random() < 0.7) {
      settle(nodes, ...windows);
      for (let k = Math.floor(random() * 3); k > 0; k--) {
        const tab = pick(tabs);
        const r = random();
        if (r < 0.5) nodes[tab.id].parent = pick(tabs.filter((t) => t !== tab)).id;
        else if (r < 0.75) delete nodes[tab.id].heir;
        else delete nodes[tab.id].color;
      }
    }
    const unpinned = windows[0].filter((t) => !t.pinned);
    if (!unpinned.length) continue;
    const top = pick(unpinned).id;
    const others = windows.slice(1);
    const drawn = (nodes) => others.map((list) => [...treeColors(buildForest(list, nodes), nodes)]);
    const before = drawn(nodes);
    const copy = structuredClone(nodes);
    const reaches = colorsReachOtherWindows(windows[0], nodes, top);
    assert.deepEqual(nodes, copy, 'colorsReachOtherWindows changes no node');
    const block = subtree(buildForest(windows[0], nodes), top);
    const left = windows[0].filter((t) => !block.includes(t.id));
    const moved = block.map((id, index) => ({ ...windows[0].find((t) => t.id === id), windowId: 4, index }));
    const move = (alone) => {
      const after = structuredClone(nodes);
      settle(after, ...(alone ? windows.slice(0, 1) : windows));
      after[top].parent = null;
      for (const id of block.slice(1)) rememberColor(after[id]);
      const during = drawn(after);
      settle(after, left, ...others, moved);
      return { during, after: drawn(after) };
    };
    const every = move(false);
    if (reaches) {
      if (!colorsReachOtherWindows(windows[0], nodes) && !isDeepStrictEqual(move(true), every)) needed++;
      continue;
    }
    const alone = move(true);
    assert.deepEqual(alone.during, before, 'the other windows draw the same while the tree moves');
    assert.deepEqual(alone.after, every.after, 'the other windows draw the same once all are stored');
  }
  assert.ok(needed > 0, 'some runs need every window stored because of the move');
});

test('a new tree inherits from the nearest ancestor that has a tree colour, however far up', () => {
  // 3(4) was opened from 2, and 2 from 1; both are pinned, and only 1 has one: that of the tree
  // it was in. 2 headed a red tree once, but that colour is its own.
  const tabs = [{ ...tabAt(1, 0), pinned: true }, { ...tabAt(2, 1), pinned: true }, tabAt(3, 2), tabAt(4, 3)];
  const nodes = nodesFrom({ 1: null, 2: 1, 3: 2, 4: 3 });
  nodes[1].heir = 'green';
  nodes[2].lastColor = 'red';
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), { 3: 'green' });
});

test('a pinned tab keeps the colour of the tree it was in, and hands it on when it closes', () => {
  // 1 is in the green tree 0(1). 1 is pinned, then 0 closes, and 2(3) is opened from 1.
  let { tabs, nodes } = windowOf([[0, null], [1, 0]]);
  nodes[0].color = 'green';
  settle(nodes, tabs);
  tabs = tabs.map((t) => (t.id === 1 ? { ...t, pinned: true } : t));
  settle(nodes, tabs);
  tabs = tabs.filter((t) => t.id !== 0);
  removeNode(nodes, 0);
  settle(nodes, tabs);
  assert.equal(nodes[1].heir, 'green');
  Object.assign(nodes, nodesFrom({ 2: 1, 3: 2 }));
  tabs = [...tabs, tabAt(2, 2), tabAt(3, 3)];
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), { 2: 'green' });
  tabs = tabs.filter((t) => t.id !== 1);
  const early = colorsOf(buildForest(tabs, nodes), nodes);
  removeNode(nodes, 1);
  assert.equal(nodes[2].heir, 'green');
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), early);
  assert.deepEqual(early, { 2: 'green' });
});

test('closing a tab hands down the colour of a tree it was in, never one of its own', () => {
  // 9 heads a green tree and is pinned. 3 is opened from it, and 3(4) becomes a tree just as 9 closes.
  let { tabs, nodes } = windowOf([[5, null], [6, 5], [9, null], [10, 9]]);
  nodes[9].color = 'green';
  settle(nodes, tabs); // 5 blue
  tabs = tabs.map((t) => (t.id === 9 ? { ...t, pinned: true } : t));
  settle(nodes, tabs);
  assert.deepEqual([nodes[9].lastColor, nodes[9].heir], ['green', undefined]);
  Object.assign(nodes, nodesFrom({ 3: 9, 4: 3 }));
  tabs = [...tabs.filter((t) => t.id !== 9), tabAt(3, 4), tabAt(4, 5)];
  const early = colorsOf(buildForest(tabs, nodes), nodes);
  removeNode(nodes, 9);
  assert.equal(nodes[3].heir, undefined);
  assert.deepEqual(colorsOf(buildForest(tabs, nodes), nodes), early);
  assert.deepEqual(early, { 5: 'blue', 3: 'orange' });
});

test('a new tree leaves alone the colour a pinned tab remembers, and the tab gets it back when unpinned', () => {
  // 1 heads a blue tree, loses its only child and is pinned; then 7, below the orange tree 5,
  // becomes a tree.
  let { tabs, nodes } = windowOf([[1, null], [2, 1], [5, null], [6, 5], [7, null]]);
  settle(nodes, tabs); // 1 blue, 5 orange
  tabs = tabs.filter((t) => t.id !== 2).map((t) => (t.id === 1 ? { ...t, pinned: true } : t));
  removeNode(nodes, 2);
  settle(nodes, tabs);
  assert.equal(nodes[1].lastColor, 'blue');
  nodes[8] = { parent: 7, collapsed: false };
  tabs = [...tabs, tabAt(8, 5)];
  settle(nodes, tabs);
  assert.equal(nodes[7].color, 'pink');
  nodes[9] = { parent: 1, collapsed: false };
  tabs = [...tabs.map((t) => (t.id === 1 ? { ...t, pinned: false } : t)), tabAt(9, 6)];
  settle(nodes, tabs);
  assert.equal(nodes[1].color, 'blue');
});

test('unknown colour names are ignored', () => {
  const { tabs, nodes } = windowOf([[1, null], [2, 1]]);
  nodes[1].color = 'chartreuse';
  settle(nodes, tabs);
  assert.equal(nodes[1].color, 'blue');
});

test('flatten gives every row its tree\'s colour; single tabs get none', () => {
  const nodes = nodesFrom({ 1: null, 2: 1, 3: 2, 4: null });
  const forest = buildForest(tabsInOrder([1, 2, 3, 4]), nodes);
  const rows = flatten(forest, nodes, { colors: new Map([[1, 'cyan']]) });
  assert.deepEqual(rows.map((r) => [r.id, r.color]), [[1, 'cyan'], [2, 'cyan'], [3, 'cyan'], [4, null]]);
  assert.deepEqual(flatten(forest, nodes).map((r) => r.color), [null, null, null, null]);
});

test('subtrees take the next shades of their tree\'s colour: 0, then 1 2 1 2...', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(shadeOf), [0, 1, 2, 1, 2, 1, 2]);
});

test('closing a tab hands its tree colour to the children that hold none', () => {
  const nodes = nodesFrom({ 1: null, 2: 1, 3: 1, 4: 1 });
  nodes[1].color = 'red';
  nodes[3].lastColor = 'green';
  nodes[4].heir = 'cyan';
  removeNode(nodes, 1);
  assert.deepEqual(nodes, {
    2: { parent: null, collapsed: false, heir: 'red' },
    3: { parent: null, collapsed: false, lastColor: 'green', heir: 'red' },
    4: { parent: null, collapsed: false, heir: 'cyan' },
  });
});

/**
 * Random changes to two windows, checking after each what the colour pass promises. A dense run
 * starts every window with more trees than there are colours: sixteen top tabs, most of which
 * the other tabs of the window were opened from.
 */
function randomChanges({ seed, runs, steps, dense = false }) {
  const random = seeded(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  let nextId = 1;
  for (let run = 0; run < runs; run++) {
    let tabs = [];
    const nodes = {};
    const windows = () => [...new Set(tabs.map((t) => t.windowId))];
    const tabsOf = (w) => tabs.filter((t) => t.windowId === w);
    const forests = () => new Map(windows().map((w) => [w, buildForest(tabsOf(w), nodes)]));
    const colorsIn = (all) => new Map([...all].map(([w, forest]) => [w, treeColors(forest, nodes)]));
    const renumber = (w) => tabsOf(w).sort((a, b) => a.index - b.index).forEach((t, i) => { t.index = i; });
    const add = (windowId, parent, index = Infinity) => {
      const id = nextId++;
      for (const t of tabsOf(windowId)) if (t.index >= index) t.index++;
      tabs.push({ id, index: Math.min(index, tabsOf(windowId).length), windowId, pinned: false });
      nodes[id] = { parent, collapsed: false };
    };
    for (let i = 0; i < (dense ? 80 : run % 2 ? 30 : 6); i++) {
      const w = 1 + (i % 2);
      add(w, !dense || i < 32 ? null : pick(random() < 0.8 ? tabsOf(w).slice(0, 16) : tabsOf(w)).id);
    }
    storeColors([...forests().values()], nodes);
    let before = colorsIn(forests());

    for (let step = 0; step < steps && tabs.length > 3; step++) {
      const op = pick(['link', 'link', 'link', 'close', 'pin', 'drag', 'top', 'window', 'newtab', 'pick']);
      const tab = pick(tabs);
      let exempt = null; // a tree whose colour this step changes on purpose
      // The colour of the tree whose top tab this step closes or pins, and the other tabs of it.
      const headed = op === 'close' || (op === 'pin' && !tab.pinned) ? before.get(tab.windowId)?.get(tab.id) : undefined;
      const family = headed ? subtree(buildForest(tabsOf(tab.windowId), nodes), tab.id).slice(1) : [];
      if (op === 'link') add(tab.windowId, tab.id, tab.index + 1);
      else if (op === 'newtab') add(pick([1, 2]), null);
      else if (op === 'close') {
        tabs = tabs.filter((t) => t !== tab);
        renumber(tab.windowId);
        const early = colorsIn(forests());
        removeNode(nodes, tab.id);
        assert.deepEqual(colorsIn(forests()), early, 'the same before and after the worker forgets a closed tab');
      } else if (op === 'pin') tab.pinned = !tab.pinned;
      else if (op === 'drag' || op === 'top') {
        const forest = buildForest(tabsOf(tab.windowId), nodes);
        const target = op === 'drag' ? pick(tabsOf(tab.windowId).filter((t) => !t.pinned)) : null;
        if (forest.parentOf.has(tab.id) && !(target && subtree(forest, tab.id).includes(target.id))) nodes[tab.id].parent = target?.id ?? null;
      } else if (op === 'window') {
        const from = tab.windowId;
        tab.windowId = from === 1 ? 2 : 1;
        tab.index = tabsOf(tab.windowId).length - 1;
        renumber(from);
        rememberColor(nodes[tab.id]);
      } else if (op === 'pick') {
        const heads = [...(before.get(tab.windowId)?.keys() ?? [])];
        if (heads.length) {
          exempt = pick(heads);
          nodes[exempt].color = pick(TREE_COLORS);
          delete nodes[exempt].lastColor;
          delete nodes[exempt].heir;
        }
      }

      const now = forests(); // a colour pass changes no parents, so these hold after it too
      const predicted = colorsIn(now);
      const own = new Map(family.map((id) => [id, nodes[id]?.lastColor]));
      const copy = structuredClone(nodes);
      assert.equal(storeColors([...now.values()], nodes), !isDeepStrictEqual(nodes, copy), 'storeColors says whether it changed a node');
      const stored = colorsIn(now);
      for (const [w, forest] of now) {
        const colors = stored.get(w);
        assert.deepEqual([...colors], [...predicted.get(w)], 'the panel predicts what the worker stores');
        assert.equal(storeColors([forest], nodes), false, 'a second pass changes nothing');
        const treeOf = new Map();
        for (const [head, color] of colors) for (const id of subtree(forest, head)) treeOf.set(id, color);
        for (const id of [...forest.order, ...forest.pinned]) {
          const node = nodes[id];
          if (colors.has(id)) {
            assert.deepEqual([node.color, node.lastColor, node.heir], [colors.get(id), undefined, undefined], `tree ${id} has its colour, and no other`);
          } else {
            assert.equal(node.color, undefined, `tab ${id} heads no tree`);
            if (treeOf.has(id)) assert.equal(node.heir, treeOf.get(id), `tab ${id} holds the colour of its tree`);
          }
        }
        const was = before.get(w) ?? new Map();
        const kept = (head) => head !== exempt && was.has(head);
        for (const [head, color] of colors) if (kept(head)) assert.equal(color, was.get(head), `tree ${head} kept its colour`);
        const heads = [...colors.keys()];
        heads.forEach((head, i) => {
          if (kept(head) || head === exempt) return;
          if (i > 0) assert.notEqual(colors.get(head), colors.get(heads[i - 1]), `new tree ${head} matches the tree above`);
          if (kept(heads[i + 1])) assert.notEqual(colors.get(head), colors.get(heads[i + 1]), `new tree ${head} matches the tree below`);
        });
        if (colors.size <= NEW_TREE_COLORS.length) {
          // Up to eight trees, only colours that were kept (or just picked) can repeat.
          const first = new Map();
          for (const [head, color] of colors) {
            const other = first.get(color);
            if (other != null) {
              const explained = [head, other].every((id) => kept(id) || id === exempt);
              assert.ok(explained, `needless duplicate ${color}: ${other} and ${head}`);
            }
            if (other == null) first.set(color, head);
          }
        }
      }
      if (headed) {
        // Its subtrees, top to bottom: one whose own colour no tree has takes it back. The first
        // that does not carries the tree's colour on if no other tree had it, or, with more than
        // eight trees, if neither tree next to it has it; when one does, the next subtree may.
        const colors = stored.get(tab.windowId) ?? new Map();
        const heads = [...colors.keys()];
        const subtrees = family.filter((id) => colors.has(id)).sort((a, b) => heads.indexOf(a) - heads.indexOf(b));
        const others = [...before.get(tab.windowId)].filter(([id]) => id !== tab.id).map(([, color]) => color);
        const unique = !others.includes(headed);
        const crowded = heads.length > NEW_TREE_COLORS.length;
        const taken = new Set(others);
        for (const id of subtrees) {
          const mine = own.get(id);
          if (TREE_COLORS.includes(mine) && !taken.has(mine)) {
            assert.equal(colors.get(id), mine, `${op} ${tab.id}: subtree ${id} does not take back its own ${mine}`);
            taken.add(mine);
            if (mine === headed) break;
            continue;
          }
          const i = heads.indexOf(id);
          const nextTo = colors.get(heads[i - 1]) === headed
            || (!family.includes(heads[i + 1]) && colors.get(heads[i + 1]) === headed);
          if (unique || (crowded && !nextTo)) {
            assert.equal(colors.get(id), headed, `${op} ${tab.id}: subtree ${id} does not carry on ${headed}`);
            break;
          }
          if (!crowded) break;
        }
      }
      before = stored;
    }
  }
}

test('random changes: kept colours stay, the panel predicts what is stored, no needless duplicates', () => {
  randomChanges({ seed: 11, runs: 300, steps: 60 });
});

test('random changes with more trees in a window than there are colours', () => {
  randomChanges({ seed: 5, runs: 40, steps: 120, dense: true });
});
