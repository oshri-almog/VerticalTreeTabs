import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildForest, nextAfterClose, placeNear, removeNode } from '../extension/tree.js';

// Tabs 1..7 in strip order: 1 heads 2 (which heads 3) and 4; 5 is alone; 6 heads 7. Tab 9 is pinned.
const tabs = [1, 2, 3, 4, 5, 6, 7].map((id, index) => ({ id, index, pinned: false }));
tabs.push({ id: 9, index: 7, pinned: true });
const makeNodes = () => ({
  1: { parent: null }, 2: { parent: 1 }, 3: { parent: 2 }, 4: { parent: 1 }, 5: { parent: null }, 6: { parent: null },
  7: { parent: 6 }, 9: { parent: null },
});

test('a new tab goes by the current tab: after its tree, next to it, or under it, first or last', () => {
  const forest = buildForest(tabs, makeNodes());
  assert.deepEqual(placeNear(forest, 2, 'afterTree'), { parent: null, after: 4 }, 'after the tree 2 is in (1\'s, which ends at 4)');
  assert.deepEqual(placeNear(forest, 2, 'sibling'), { parent: 1, after: 3 }, 'next to 2: after the tabs under it, under its parent');
  assert.deepEqual(placeNear(forest, 2, 'child'), { parent: 2, after: 3 }, 'under 2, the last');
  assert.deepEqual(placeNear(forest, 2, 'firstChild'), { parent: 2, after: 2 }, 'under 2, the first');
  assert.deepEqual(placeNear(forest, 5, 'sibling'), { parent: null, after: 5 }, 'a tab alone: right after it');
  assert.equal(placeNear(forest, 9, 'child'), null, 'a pinned tab is in no tree');
  assert.equal(placeNear(forest, 42, 'child'), null, 'nor a tab of another window');
  assert.equal(placeNear(forest, 2, 'browser'), null, 'the browser\'s place: no move');
  // The new tab itself may be in the forest already (the browser put it right after 3): it is not its own neighbour.
  const withNew = buildForest([...tabs.slice(0, 3), { id: 8, index: 3 }, ...tabs.slice(3).map((t) => ({ ...t, index: t.index + 1 }))],
    { ...makeNodes(), 8: { parent: null } });
  assert.deepEqual(placeNear(withNew, 2, 'child', new Set([8])), { parent: 2, after: 3 });
});

test('when the current tab closes, the tree gives its first child, else the tab next to it, else its parent', () => {
  const order = [1, 2, 3, 4, 5, 6, 7];
  const openAfter = (closed) => new Set(order.filter((id) => id !== closed));
  assert.equal(nextAfterClose(order, 1, makeNodes(), openAfter(1)), 2, 'its first child');
  assert.equal(nextAfterClose(order, 3, makeNodes(), openAfter(3)), 2, 'no child, no sibling: its parent');
  assert.equal(nextAfterClose(order, 2, makeNodes(), openAfter(2)), 3, 'its child first');
  const nodes = makeNodes();
  delete nodes[3];
  assert.equal(nextAfterClose([1, 2, 4, 5, 6, 7], 2, nodes, new Set([1, 4, 5, 6, 7])), 4, 'the next tab of its parent, below it');
  assert.equal(nextAfterClose([1, 2, 4, 5, 6, 7], 4, nodes, new Set([1, 2, 5, 6, 7])), 2, 'the last one: the one above it');
  assert.equal(nextAfterClose(order, 5, makeNodes(), openAfter(5)), 6, 'at the top level: the next tree');
  assert.equal(nextAfterClose([5], 5, { 5: { parent: null } }, new Set()), null, 'nothing left: the browser\'s pick');
  assert.equal(nextAfterClose([2], 2, { 1: { parent: null }, 2: { parent: 1 } }, new Set([1])), 1, 'its position unknown: its parent');
});

test('a closing tab\'s first child can take its place, with its other children under it', () => {
  const nodes = makeNodes();
  removeNode(nodes, 1, 2);
  assert.deepEqual([nodes[2].parent, nodes[4].parent, nodes[3].parent], [null, 2, 2], '2 in 1\'s place; 4 and 3 under 2');
  const plain = makeNodes();
  removeNode(plain, 1);
  assert.deepEqual([plain[2].parent, plain[4].parent, plain[3].parent], [null, null, 2], 'without: they move up a level');
  const wrong = makeNodes();
  removeNode(wrong, 1, 7);
  assert.deepEqual([wrong[2].parent, wrong[4].parent, wrong[7].parent], [null, null, 6], 'not one of its children: as without');
});

test('the heir of a closed tab opens if it was collapsed and gets the closed tab\'s other tabs, unless the closed tab was collapsed', () => {
  const nodes = { 1: { parent: null }, 2: { parent: 1, collapsed: true }, 3: { parent: 2 }, 4: { parent: 1 } };
  removeNode(nodes, 1, 2);
  assert.deepEqual([nodes[2].collapsed, nodes[4].parent], [false, 2], '4 under 2, which shows it');
  const folded = { 1: { parent: null, collapsed: true }, 2: { parent: 1, collapsed: true }, 4: { parent: 1 } };
  removeNode(folded, 1, 2);
  assert.equal(folded[2].collapsed, true, 'a collapsed tree stays collapsed');
});
