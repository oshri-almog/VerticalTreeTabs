import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildForest, NEW_TREE_COLORS, removeNode, treeColors } from '../extension/tree.js';
import {
  autoName,
  groupUnits,
  joinTree,
  leaveTree,
  MAX_NAME,
  NO_GROUP,
  oneLine,
  planGroups,
  readSettings,
  storeFirstLinks,
  storeUnitColors,
  unitCollapsed,
  unitColors,
  unitTitle,
} from '../extension/groups.js';

/** Tabs of one window in the given native order; `extra[id]` patches single tabs. */
function tabsInOrder(ids, extra = {}) {
  return ids.map((id, index) => ({ id, index, windowId: 1, pinned: false, groupId: NO_GROUP, title: `t${id}`, url: `https://site.test/${id}`, ...extra[id] }));
}

/** nodes from { id: parentId }, with the listed ids collapsed. */
function nodesFrom(parents, collapsed = []) {
  const nodes = {};
  for (const [id, parent] of Object.entries(parents)) nodes[id] = { parent, collapsed: collapsed.includes(Number(id)) };
  return nodes;
}

// The user's FreshRSS window: the main stream (79) opened three category pages, each of which
// opened videos.
const rssOrder = [79, 2, 21, 22, 23, 14, 41, 42, 43, 26, 61, 62];
const rssParents = { 79: null, 2: 79, 21: 2, 22: 2, 23: 2, 14: 79, 41: 14, 42: 14, 43: 14, 26: 79, 61: 26, 62: 26 };

// ---- settings and names --------------------------------------------------------------------

test('settings default to one group per tree, leaving the user\'s own groups alone, and to the browser\'s look', () => {
  const look = {
    theme: 'system', density: 'normal', textSize: 'normal', indent: 'normal', confirmClose: '5', closeParent: 'up',
    afterClose: 'browser', linkPlacement: 'browser', newTabPlacement: 'browser', bookmarkPlacement: 'browser',
    bookmarkActive: 'no', dropInto: 'last', newTabButton: 'end', clickToFold: 'off', stripMoves: 'keep', unread: 'dot',
    searchBox: 'show',
  };
  assert.deepEqual(readSettings(undefined), { groups: 'trees', ownGroups: 'leave', ...look });
  assert.deepEqual(readSettings({ groups: 'innermost', ownGroups: 'regroup' }), { groups: 'innermost', ownGroups: 'regroup', ...look });
  assert.deepEqual(readSettings({ groups: 'nested', ownGroups: 7 }), { groups: 'trees', ownGroups: 'leave', ...look });
  assert.deepEqual(readSettings({ groups: 'pages' }), { groups: 'pages', ownGroups: 'leave', ...look });
  assert.deepEqual(readSettings({ groups: 'branches' }), { groups: 'branches', ownGroups: 'leave', ...look });
  assert.deepEqual(readSettings({ theme: 'dark', density: 'compact', textSize: 'large', indent: 'wide' }),
    { ...look, groups: 'trees', ownGroups: 'leave', theme: 'dark', density: 'compact', textSize: 'large', indent: 'wide' });
  // How many tabs closing at once asks first.
  for (const confirmClose of ['2', '10', 'never']) assert.equal(readSettings({ confirmClose }).confirmClose, confirmClose);
  assert.equal(readSettings({ confirmClose: '3' }).confirmClose, '5', 'not one of the choices: the default');
  assert.deepEqual(readSettings({ theme: 'sepia', density: 3, textSize: null, indent: 'deep' }), { groups: 'trees', ownGroups: 'leave', ...look });
});

test('a group is named after the gist of its head page\'s title', () => {
  const name = (title, url = 'https://freshrss.example.org/i/') => autoName({ title, url });
  assert.equal(name('(2) Comedy · freshrss.example.org'), 'Comedy');
  assert.equal(name('(14) DEFCONConference · freshrss.example.org'), 'DEFCONConference');
  assert.equal(name('(79) · freshrss.example.org'), 'freshrss.example.org');
  assert.equal(name('Inbox (3) - Mail', 'https://mail.example.com/'), 'Inbox');
  assert.equal(name('(99+) Feed | Reader', 'https://reader.example.com/'), 'Feed');
  assert.equal(name('Men Should Not Be Allowed in Adult Delivery Rooms | Steve Hili - YouTube', 'https://www.youtube.com/watch?v=x'),
    'Men Should Not Be Allowed in Adult Delivery Rooms');
  assert.equal(name('GitHub - owner/repo: a tool', 'https://github.com/owner/repo'), 'owner/repo: a tool');
  assert.equal(name('YouTube', 'https://www.youtube.com/'), 'YouTube');
  assert.equal(name('Wi-Fi setup – Help', 'https://help.example.com/'), 'Wi-Fi setup');
  assert.equal(name('Tree (data structure) - Wikipedia', 'https://en.wikipedia.org/'), 'Tree (data structure)');
});

test('without a title, a group is named after the site', () => {
  assert.equal(autoName({ title: '', url: 'https://www.example.com/a' }), 'example.com');
  assert.equal(autoName({ title: 'https://www.example.com/a', url: 'https://www.example.com/a' }), 'example.com');
  assert.equal(autoName({ title: '', url: '', pendingUrl: 'https://news.example.org/' }), 'news.example.org');
  assert.equal(autoName({ title: '  ' }), '');
  assert.equal(autoName(undefined), '');
});

test('a long name is cut at a word, with an ellipsis', () => {
  const long = autoName({ title: 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen', url: 'https://a.test/' });
  assert.ok(long.length <= MAX_NAME, long);
  assert.ok(long.endsWith('…'), long);
  assert.ok(!long.includes('  '));
  const word = autoName({ title: 'x'.repeat(100), url: 'https://a.test/' });
  assert.equal(word.length, MAX_NAME);
});

test('a group\'s name is one line: control characters and runs of spaces become one space', () => {
  assert.equal(oneLine('  Two\nlines\tand\u0007  more  '), 'Two lines and more');
  assert.equal(autoName({ title: 'Weird\r\ntitle - Site', url: 'https://site.test/' }), 'Weird title');
  assert.equal(oneLine(undefined), '');
});

test('a name the user gave wins over the automatic one', () => {
  const tab = { title: '(2) Comedy · freshrss.example.org', url: 'https://freshrss.example.org/' };
  assert.equal(unitTitle({ 2: { groupName: 'Stand-up' } }, 2, tab), 'Stand-up');
  assert.equal(unitTitle({ 2: { groupName: '' } }, 2, tab), 'Comedy');
  assert.equal(unitTitle({ 2: {} }, 2, tab), 'Comedy');
});

// ---- units ---------------------------------------------------------------------------------

test('one group per tree holds the top tab and everything under it', () => {
  const forest = buildForest(tabsInOrder([...rssOrder, 90, 91, 92]), nodesFrom({ ...rssParents, 90: null, 91: null, 92: 91 }));
  assert.deepEqual(groupUnits(forest, {}, 'trees'), [
    { head: 79, tabs: rssOrder, optedOut: false },
    { head: 91, tabs: [91, 92], optedOut: false },
  ]);
});

test('one group per innermost subtree: a tab with its children, none of which has children', () => {
  const forest = buildForest(tabsInOrder([...rssOrder, 90, 91, 92]), nodesFrom({ ...rssParents, 90: null, 91: null, 92: 91 }));
  assert.deepEqual(groupUnits(forest, {}, 'innermost').map((u) => [u.head, u.tabs]), [
    [2, [2, 21, 22, 23]], [14, [14, 41, 42, 43]], [26, [26, 61, 62]], [91, [91, 92]],
  ]);
});

test('an innermost group breaks up once one of its tabs opens a tab', () => {
  // 1 opened 2 3 4; then 3 opened 5.
  const before = buildForest(tabsInOrder([1, 2, 3, 4]), nodesFrom({ 1: null, 2: 1, 3: 1, 4: 1 }));
  assert.deepEqual(groupUnits(before, {}, 'innermost').map((u) => u.head), [1]);
  const after = buildForest(tabsInOrder([1, 2, 3, 5, 4]), nodesFrom({ 1: null, 2: 1, 3: 1, 4: 1, 5: 3 }));
  assert.deepEqual(groupUnits(after, {}, 'innermost').map((u) => [u.head, u.tabs]), [[3, [3, 5]]]);
});

// The user's case: 1 opened 2 to 6; 4, in the middle, opened 7; then 4 opened 8, and 7 opened 9.
const pageParents = { 1: null, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 };
const unitsOf = (order, parents, mode) => groupUnits(buildForest(tabsInOrder(order), nodesFrom(parents)), {}, mode).map((u) => [u.head, u.tabs]);

test('one group per page: a tab that opens a tab leaves its group and leads one with the tabs it opened', () => {
  assert.deepEqual(unitsOf([1, 2, 3, 4, 5, 6], pageParents, 'pages'), [[1, [1, 2, 3, 4, 5, 6]]]);
  assert.deepEqual(unitsOf([1, 2, 3, 4, 7, 5, 6], { ...pageParents, 7: 4 }, 'pages'), [[1, [1, 2, 3, 5, 6]], [4, [4, 7]]]);
  assert.deepEqual(unitsOf([1, 2, 3, 4, 7, 8, 5, 6], { ...pageParents, 7: 4, 8: 4 }, 'pages'),
    [[1, [1, 2, 3, 5, 6]], [4, [4, 7, 8]]], 'a further link from 4 joins its group');
  assert.deepEqual(unitsOf([1, 2, 3, 4, 7, 9, 8, 5, 6], { ...pageParents, 7: 4, 8: 4, 9: 7 }, 'pages'),
    [[1, [1, 2, 3, 5, 6]], [4, [4, 8]], [7, [7, 9]]], 'a link from 7 makes 7 leave in turn');
  assert.deepEqual(unitsOf([1, 2, 3], { 1: null, 2: 1, 3: 2 }, 'pages'), [[1, [1]], [2, [2, 3]]], 'a page left alone keeps a unit of one');
});

test('one group per branch: a tab that opens a tab leads a group of its first branch; each further link starts one', () => {
  assert.deepEqual(unitsOf([1, 2, 3, 4, 7, 5, 6], { ...pageParents, 7: 4 }, 'branches'), [[1, [1, 2, 3, 5, 6]], [4, [4, 7]]]);
  assert.deepEqual(unitsOf([1, 2, 3, 4, 7, 9, 8, 5, 6], { ...pageParents, 7: 4, 8: 4, 9: 7 }, 'branches'),
    [[1, [1, 2, 3, 5, 6]], [4, [4, 7, 9]], [8, [8]]], 'what 7 opens stays in 4\'s branch; 8, a further link, starts its own');
  assert.deepEqual(unitsOf([1, 2, 3, 4, 7, 9, 10, 8, 5, 6], { ...pageParents, 7: 4, 8: 4, 9: 7, 10: 9 }, 'branches'),
    [[1, [1, 2, 3, 5, 6]], [4, [4, 7, 9, 10]], [8, [8]]], 'no split below the branches');
  // The browser puts 4's later link 8 just after 4, before 7: 7, the older, is still the first link.
  assert.deepEqual(unitsOf([1, 2, 3, 5, 6, 4, 8, 7, 9], { ...pageParents, 7: 4, 8: 4, 9: 7 }, 'branches'),
    [[1, [1, 2, 3, 5, 6]], [4, [4, 7, 9]], [8, [8]]], 'the first link is the oldest, not the leftmost');
});

test('stacked groups made in one pass from one group are made in reverse, so that each lands after its parent\'s', () => {
  // One group per tree, then per page: 1 opened 2 to 7; 4 opened 41 and 42; 41 opened 411, which opened 4111; 6 opened 61.
  const nodes = nodesFrom({ 1: null, 2: 1, 3: 1, 4: 1, 41: 4, 411: 41, 4111: 411, 42: 4, 5: 1, 6: 1, 61: 6, 7: 1 });
  nodes[1].color = 'orange';
  const order = [1, 2, 3, 4, 41, 411, 4111, 42, 5, 6, 61, 7];
  const tabs = tabsInOrder(order, grouped(order, 50));
  const groups = [{ id: 50, title: 't1', color: 'orange', collapsed: false }];
  const made = plan(tabs, nodes, { groups, owned: { 50: 1 }, mode: 'pages' }).filter((op) => op.type === 'group').map((op) => op.head);
  assert.deepEqual(made, [6, 411, 41, 4], 'in reverse unit order (4, 41, 411, 6)');
});

test('branches: a tab put into a branch\'s group goes under its first link, not beside it as a further link', () => {
  // 1 opened 2 3 4; 4 opened 41 (its group [4 41]); the user puts 900 into that group, after 41.
  const nodes = nodesFrom({ 1: null, 2: 1, 3: 1, 4: 1, 41: 4, 900: null });
  const tabs = tabsInOrder([1, 2, 3, 4, 41, 900]);
  joinTree(tabs, nodes, 900, 4, 'branches');
  assert.equal(nodes[900].parent, 41);
  const again = nodesFrom({ 1: null, 2: 1, 3: 1, 4: 1, 41: 4, 900: null });
  joinTree(tabs, again, 900, 4, 'pages');
  assert.equal(again[900].parent, 4, 'one group per page: beside 41, in 4\'s group');
});

test('stacked groups: tabs that leave their group for a new one are not ungrouped first, and the old group stays', () => {
  // 1 opened 2 to 6, all in 1's group 50; 4 opened 7, which the browser put in group 50 after 4.
  const nodes = nodesFrom({ ...pageParents, 7: 4 });
  nodes[1].color = 'orange';
  const tabs = tabsInOrder([1, 2, 3, 4, 7, 5, 6], grouped([1, 2, 3, 4, 7, 5, 6], 50));
  const groups = [{ id: 50, title: 't1', color: 'orange', collapsed: false }];
  for (const mode of ['pages', 'branches']) {
    const ops = plan(tabs, nodes, { groups, owned: { 50: 1 }, mode });
    assert.deepEqual(ops.filter((op) => op.type !== 'update'), [{ type: 'group', groupId: null, head: 4, tabIds: [4, 7] }], mode);
    assert.ok(!ops.some((op) => op.groupId === 50), `group 50 kept as it is: ${JSON.stringify(ops)}`);
  }
  // Innermost subtrees break the group up instead.
  assert.ok(plan(tabs, nodes, { groups, owned: { 50: 1 }, mode: 'innermost' }).some((op) => op.type === 'ungroup'));
  // A further link of 4's in branch mode: a new group of one.
  const more = nodesFrom({ ...pageParents, 7: 4, 8: 4 });
  more[1].color = 'orange';
  const after = tabsInOrder([1, 2, 3, 5, 6, 4, 7, 8], { ...grouped([1, 2, 3, 5, 6], 50), ...grouped([4, 7, 8], 51) });
  const both = [...groups, { id: 51, title: 't4', color: 'cyan', collapsed: false }];
  assert.deepEqual(plan(after, more, { groups: both, owned: { 50: 1, 51: 4 }, mode: 'branches' }).filter((op) => op.type !== 'update'),
    [{ type: 'group', groupId: null, head: 8, tabIds: [8] }]);
});

// 'branches': 1 opened 2, 3 and 4; 4 opened 7 (its first link), then 8 (a further link); 7 opened 9.
const branchParents = { 1: null, 2: 1, 3: 1, 4: 1, 7: 4, 8: 4, 9: 7 };
const branchOrder = [1, 2, 3, 4, 7, 9, 8];
const branchesOf = (order, nodes) => groupUnits(buildForest(tabsInOrder(order), nodes), nodes, 'branches').map((u) => [u.head, u.tabs]);
const storeLinks = (order, nodes) => storeFirstLinks(buildForest(tabsInOrder(order), nodes), nodes);

test('branches: the first link is kept, so that a child with an older id does not take its place (Edge\'s kept-ready New Tab page)', () => {
  const nodes = nodesFrom(branchParents);
  assert.equal(storeLinks(branchOrder, nodes), true);
  assert.deepEqual([nodes[1].firstLink, nodes[4].firstLink, nodes[7].firstLink], [2, 7, 9]);
  assert.equal(storeLinks(branchOrder, nodes), false, 'kept as they are');
  nodes[5] = { parent: 4, collapsed: false }; // "New tab as child" of 4: id 5, older than 7
  const now = [...branchOrder, 5];
  assert.equal(storeLinks(now, nodes), false);
  assert.deepEqual(branchesOf(now, nodes), [[1, [1, 2, 3]], [4, [4, 7, 9]], [8, [8]], [5, [5]]]);
  assert.deepEqual(branchesOf(now, { ...nodesFrom(branchParents), 5: { parent: 4, collapsed: false } }),
    [[1, [1, 2, 3]], [4, [4, 5]], [7, [7, 9]], [8, [8]]], 'by the lowest id alone, 5 would lead');
});

test('branches: a first link that closes hands its place on to the first tab it opened, not to an older further link', () => {
  const nodes = nodesFrom(branchParents);
  storeLinks(branchOrder, nodes);
  removeNode(nodes, 7);
  assert.equal(nodes[4].firstLink, 9);
  assert.deepEqual(branchesOf([1, 2, 3, 4, 9, 8], nodes), [[1, [1, 2, 3]], [4, [4, 9]], [8, [8]]]);
  const plain = nodesFrom(branchParents);
  removeNode(plain, 7);
  assert.deepEqual(branchesOf([1, 2, 3, 4, 9, 8], plain), [[1, [1, 2, 3]], [4, [4, 8]], [9, [9]]], 'by the lowest id alone, 8 would lead');
  // With no tab of its own to hand it on to, none is recorded: the oldest child leads, until a pass records it.
  removeNode(nodes, 9);
  assert.equal(nodes[4].firstLink, undefined);
  // One that leaves its tree (dragged out of its group in the tab strip) hands it on too, but not to a tab that left with it.
  const left = nodesFrom(branchParents);
  storeLinks(branchOrder, left);
  leaveTree(left, 7);
  assert.equal(left[4].firstLink, 9);
  const both = nodesFrom(branchParents);
  storeLinks(branchOrder, both);
  leaveTree(both, 7, new Set([9]));
  assert.equal(both[4].firstLink, undefined);
  // Pinned, it keeps its place, and the tab it opened leads meanwhile.
  const pinned = nodesFrom(branchParents);
  storeLinks(branchOrder, pinned);
  const forest = buildForest(tabsInOrder([7, 1, 2, 3, 4, 9, 8], { 7: { pinned: true } }), pinned);
  assert.equal(storeFirstLinks(forest, pinned), false);
  assert.deepEqual(groupUnits(forest, pinned, 'branches').map((u) => [u.head, u.tabs]), [[1, [1, 2, 3]], [4, [4, 9]], [8, [8]]]);
  // The tab it opened first takes its place even when an older one moves up with it (2, dropped under 7 in the panel;
  // or Edge's kept-ready New Tab page as a "New tab as child" of 7), and the other stays in the branch (see branchKids).
  const older = nodesFrom(branchParents);
  storeLinks(branchOrder, older);
  older[2].parent = 7;
  storeLinks([1, 3, 4, 7, 9, 2, 8], older);
  removeNode(older, 7);
  assert.deepEqual([older[4].firstLink, older[4].alsoLinks], [9, [2]]);
  assert.deepEqual(branchesOf([1, 3, 4, 9, 2, 8], older), [[1, [1, 3]], [4, [4, 9, 2]], [8, [8]]]);
  // So does a tab that took the place of a first link that closed before it: 11 in 9's, not 10, which is older.
  const links = nodesFrom({ 1: null, 2: 1, 3: 1, 4: 1, 7: 4, 8: 4, 9: 7, 10: 7, 11: 9 });
  const linkOrder = [1, 2, 3, 4, 7, 9, 11, 10, 8];
  storeLinks(linkOrder, links);
  removeNode(links, 9);
  storeLinks(linkOrder.filter((id) => id !== 9), links);
  removeNode(links, 7);
  assert.deepEqual([links[4].firstLink, links[4].alsoLinks], [11, [10]]);
});

test('branches: the other tabs that a first link opened stay in the branch when it closes, leaves its tree or is pinned', () => {
  // 1 opened 2 and 3; 3 opened 4 (its first link) and then 5; 4 opened 6 and 7.
  const parents = { 1: null, 2: 1, 3: 1, 4: 3, 5: 3, 6: 4, 7: 4 };
  const strip = [1, 2, 3, 4, 6, 7, 5];
  const fresh = () => {
    const nodes = nodesFrom(parents);
    storeLinks(strip, nodes);
    assert.deepEqual(branchesOf(strip, nodes), [[1, [1, 2]], [3, [3, 4, 6, 7]], [5, [5]]]);
    return nodes;
  };
  const closed = fresh();
  removeNode(closed, 4);
  assert.deepEqual([closed[3].firstLink, closed[3].alsoLinks], [6, [7]]);
  assert.equal(storeLinks([1, 2, 3, 6, 7, 5], closed), false, 'kept as they are');
  assert.deepEqual(branchesOf([1, 2, 3, 6, 7, 5], closed), [[1, [1, 2]], [3, [3, 6, 7]], [5, [5]]], 'not 7 in a group of its own');
  const left = fresh();
  leaveTree(left, 4); // dragged out of its group in the tab strip
  assert.deepEqual(branchesOf([1, 2, 3, 6, 7, 5, 4], left), [[1, [1, 2]], [3, [3, 6, 7]], [5, [5]]]);
  const pinned = fresh();
  const forest = buildForest(tabsInOrder([4, 1, 2, 3, 6, 7, 5], { 4: { pinned: true } }), pinned);
  assert.equal(storeFirstLinks(forest, pinned), false);
  assert.deepEqual(groupUnits(forest, pinned, 'branches').map((u) => [u.head, u.tabs]), [[1, [1, 2]], [3, [3, 6, 7]], [5, [5]]]);
  // Then 6 closes too, before 4 or after it: 7 carries the branch on, and 5 keeps its own group.
  for (const closes of [[4, 6], [6, 4]]) {
    const nodes = fresh();
    for (const id of closes) {
      removeNode(nodes, id);
      storeLinks(strip.filter((tab) => nodes[tab]), nodes);
    }
    assert.deepEqual(branchesOf([1, 2, 3, 7, 5], nodes), [[1, [1, 2]], [3, [3, 7]], [5, [5]]], closes.join(' then '));
  }
  // A first link that the user moves away (6, dropped under 5 in the panel) hands its place to the first of the others.
  const moved = fresh();
  removeNode(moved, 4);
  moved[6].parent = 5;
  storeLinks([1, 2, 3, 7, 5, 6], moved);
  assert.deepEqual([moved[3].firstLink, moved[3].alsoLinks], [7, undefined]);
  assert.deepEqual(branchesOf([1, 2, 3, 7, 5, 6], moved), [[1, [1, 2]], [3, [3, 7]], [5, [5, 6]]], 'not 5, a further link');
  // One of those that closes leaves the tabs it opened in its place; one that the user moves away leaves the branch.
  const deeper = nodesFrom({ ...parents, 8: 7 });
  storeLinks([1, 2, 3, 4, 6, 7, 8, 5], deeper);
  removeNode(deeper, 4);
  removeNode(deeper, 7);
  assert.deepEqual([deeper[3].firstLink, deeper[3].alsoLinks], [6, [8]]);
  assert.deepEqual(branchesOf([1, 2, 3, 6, 8, 5], deeper), [[1, [1, 2]], [3, [3, 6, 8]], [5, [5]]]);
  deeper[8].parent = 5; // dropped under 5 in the panel
  assert.equal(storeLinks([1, 2, 3, 6, 5, 8], deeper), true);
  assert.equal(deeper[3].alsoLinks, undefined);
  assert.deepEqual(branchesOf([1, 2, 3, 6, 5, 8], deeper), [[1, [1, 2]], [3, [3, 6]], [5, [5, 8]]]);
});

test('branches: a first link that is pinned or in another window keeps its place, with no tab in it or with some', () => {
  // 1 opened 2; 2 opened 21 (its first link, which opened nothing), then 22 and 23; 22 opened 221, 23 opened 231.
  const nodes = nodesFrom({ 1: null, 2: 1, 21: 2, 22: 2, 23: 2, 221: 22, 231: 23 });
  storeLinks([1, 2, 21, 23, 231, 22, 221], nodes);
  // 21 pinned: 22, a further link, keeps its group, rather than take 21's place in 2's.
  const pinned = buildForest(tabsInOrder([21, 1, 2, 23, 231, 22, 221], { 21: { pinned: true } }), nodes);
  assert.equal(storeFirstLinks(pinned, nodes), false);
  assert.deepEqual(groupUnits(pinned, nodes, 'branches').map((u) => [u.head, u.tabs]), [[1, [1]], [2, [2]], [23, [23, 231]], [22, [22, 221]]]);
  // A tab put into 2's group meanwhile goes under 21, and so stays in 2's group once 21 is back.
  nodes[24] = { parent: null, collapsed: false };
  joinTree(tabsInOrder([21, 1, 2, 24, 23, 231, 22, 221], { 21: { pinned: true } }), nodes, 24, 2, 'branches');
  assert.equal(nodes[24].parent, 21);
  assert.deepEqual(branchesOf([1, 2, 21, 24, 23, 231, 22, 221], nodes), [[1, [1]], [2, [2, 21, 24]], [23, [23, 231]], [22, [22, 221]]]);
  // One that closed gives way, as before: to the oldest child (21 gone without a hand-on, so its record is stale).
  const closed = nodesFrom({ 1: null, 2: 1, 21: 2, 22: 2, 23: 2, 221: 22, 231: 23 });
  storeLinks([1, 2, 21, 23, 231, 22, 221], closed);
  delete closed[21];
  assert.deepEqual(branchesOf([1, 2, 23, 231, 22, 221], closed), [[1, [1]], [2, [2, 22, 221]], [23, [23, 231]]]);
  // The tab that took a closed first link's place, pinned or in another window: the other tabs of the branch stay in it,
  // a further link stays out (2 opened 3, which opened 4 and 6; 2 opened 5 in between; 3 closed).
  const kept = nodesFrom({ 1: null, 2: 1, 3: 2, 4: 3, 5: 2, 6: 3 });
  storeLinks([1, 2, 3, 4, 6, 5], kept);
  removeNode(kept, 3);
  assert.deepEqual([kept[2].firstLink, kept[2].alsoLinks], [4, [6]]);
  const pin4 = buildForest(tabsInOrder([4, 1, 2, 6, 5], { 4: { pinned: true } }), kept);
  assert.equal(storeFirstLinks(pin4, kept), false);
  assert.deepEqual(groupUnits(pin4, kept, 'branches').map((u) => [u.head, u.tabs]), [[1, [1]], [2, [2, 6]], [5, [5]]], '4 pinned');
  assert.deepEqual(branchesOf([1, 2, 6, 5], kept), [[1, [1]], [2, [2, 6]], [5, [5]]], '4 in another window');
  // The branch all pinned (its last tab promoted into the first link's place): a tab added later, older than the further
  // link, does not take it (20 opened 21, then 22; 21 opened 23 and 24; 21 closed, 24 was pinned, 23 closed; then
  // Edge's "New tab as child" of 20, with the older id 5).
  const promo = nodesFrom({ 10: null, 20: 10, 21: 20, 22: 20, 23: 21, 24: 21 });
  storeLinks([10, 20, 21, 23, 24, 22], promo);
  removeNode(promo, 21);
  removeNode(promo, 23);
  assert.deepEqual([promo[20].firstLink, promo[20].alsoLinks], [24, undefined]);
  promo[5] = { parent: 20, collapsed: false };
  const pin24 = buildForest(tabsInOrder([24, 10, 20, 22, 5], { 24: { pinned: true } }), promo);
  assert.equal(storeFirstLinks(pin24, promo), false, 'the record stays');
  assert.deepEqual(groupUnits(pin24, promo, 'branches').map((u) => [u.head, u.tabs]), [[10, [10]], [20, [20]], [22, [22]], [5, [5]]]);
  // A tab of the branch that the user moves away while the head has no other tab here leaves the branch for good: back
  // under the head, it is a further tab (2 opened 3, which opened 4 and 6; 3 closed; 4 pinned; 6 dropped to the top
  // level in the panel, then back under 2).
  const stale = nodesFrom({ 1: null, 2: 1, 3: 2, 4: 3, 6: 3 });
  storeLinks([1, 2, 3, 4, 6], stale);
  removeNode(stale, 3);
  const pinFour = (order) => storeFirstLinks(buildForest(tabsInOrder(order, { 4: { pinned: true } }), stale), stale);
  pinFour([4, 1, 2, 6]);
  stale[6].parent = null;
  pinFour([4, 1, 2, 6]);
  assert.equal(stale[2].alsoLinks, undefined);
  stale[6].parent = 2;
  pinFour([4, 1, 2, 6]);
  storeLinks([1, 4, 2, 6], stale); // 4 unpinned
  assert.deepEqual(branchesOf([1, 4, 2, 6], stale), [[1, [1]], [2, [2, 4]], [6, [6]]]);
});

test('branches: a tab dropped under a branch\'s head, older than its links, becomes a further link', () => {
  const nodes = nodesFrom(branchParents);
  storeLinks(branchOrder, nodes);
  nodes[2].parent = 4; // the panel's drop of 2 as 4's last child
  const now = [1, 3, 4, 7, 9, 8, 2];
  storeLinks(now, nodes);
  assert.deepEqual(branchesOf(now, nodes), [[1, [1, 3]], [4, [4, 7, 9]], [8, [8]], [2, [2]]]);
  // A tab put into the branch's group goes under its first link: 7, not 2, the oldest child.
  nodes[5] = { parent: null, collapsed: false };
  joinTree(tabsInOrder([1, 3, 4, 7, 9, 5, 8, 2]), nodes, 5, 4, 'branches');
  assert.equal(nodes[5].parent, 7);
});

test('stacked groups: a group whose head heads no unit carries on with the topmost unit whose head is in it', () => {
  // 'branches': 1 opened 2, 3 and 4; 4 opened 5, which opened 6, which opened 7: groups 50 [1 2 3] and 51 [4 5 6 7].
  // "Move to top level" on 5: 5 keeps group 51, and 6's group is made after it (not 5's after 6's).
  const nodes = nodesFrom({ 1: null, 2: 1, 3: 1, 4: 1, 5: null, 6: 5, 7: 6 });
  nodes[1].color = 'orange';
  const tabs = tabsInOrder([1, 2, 3, 4, 5, 6, 7], { ...grouped([1, 2, 3], 50), ...grouped([4, 5, 6, 7], 51) });
  const groups = [{ id: 50, title: 't1', color: 'orange', collapsed: false }, { id: 51, title: 't4', color: 'cyan', collapsed: false }];
  assert.deepEqual(plan(tabs, nodes, { groups, owned: { 50: 1, 51: 4 }, mode: 'branches' }).filter((op) => op.type !== 'update'), [
    { type: 'own', groupId: 51, head: 5 },
    { type: 'group', groupId: null, head: 6, tabIds: [6, 7] },
    { type: 'group', groupId: 50, head: 1, tabIds: [4] },
  ]);
  // 'innermost', then 'branches': 1 opened 2, 4 and 3; 4 opened 5 (which opened 6: group 60 [5 6]), and then 8 in the
  // foreground, which the browser put right after 4. 4 does not join group 60 over 8 (that would put 8's group before
  // 4's): it gets a new group where it is.
  const two = nodesFrom({ 1: null, 2: 1, 4: 1, 8: 4, 5: 4, 6: 5, 3: 1 });
  const strip = tabsInOrder([1, 2, 4, 8, 5, 6, 3], grouped([5, 6], 60));
  const made = plan(strip, two, { groups: [{ id: 60, title: 't5', color: 'blue', collapsed: false }], owned: { 60: 5 }, mode: 'branches' });
  assert.deepEqual(made.filter((op) => op.type !== 'update').map((op) => [op.type, op.groupId, op.head, op.tabIds]), [
    ['release', 60, undefined, undefined], ['group', null, 8, [8]], ['group', null, 4, [4, 5, 6]], ['group', null, 1, [1, 2, 3]],
  ]);
  // A head that the browser put far from the group (unpinned, it comes first) takes it on all the same, and joins it there.
  const three = nodesFrom({ 1: null, 2: 1, 3: 1, 4: 1, 41: 4, 411: 41, 42: 4 });
  const back = tabsInOrder([4, 1, 2, 3, 42, 41, 411], { ...grouped([1, 2, 3], 50), ...grouped([42], 52), ...grouped([41, 411], 51) });
  const groups3 = [50, 51, 52].map((id) => ({ id, title: `g${id}`, color: 'blue', collapsed: false }));
  assert.deepEqual(plan(back, three, { groups: groups3, owned: { 50: 1, 51: 41, 52: 42 }, mode: 'branches' }).filter((op) => op.type === 'own'),
    [{ type: 'own', groupId: 51, head: 4 }]);
  // A head before the group with only tabs of its own unit between takes the group on: it jumps over none (one group per
  // innermost subtree, then per branch: 411's group 100 [411 4111] carries on with 4's branch, 41 joins it with 4).
  const four = nodesFrom({ 1: null, 2: 1, 3: 1, 4: 1, 41: 4, 411: 41, 4111: 411, 42: 4, 5: 1 });
  const inner = tabsInOrder([1, 2, 3, 4, 41, 411, 4111, 42, 5], grouped([411, 4111], 100));
  const groups4 = [{ id: 100, title: 't411', color: 'blue', collapsed: false }];
  assert.deepEqual(plan(inner, four, { groups: groups4, owned: { 100: 411 }, mode: 'branches' }).filter((op) => op.type !== 'update')
    .map((op) => [op.type, op.groupId, op.head, op.tabIds]), [
    ['own', 100, 4, undefined], ['group', null, 42, [42]], ['group', 100, 4, [4, 41]], ['group', null, 1, [1, 2, 3, 5]],
  ]);
});

test('no groups when they are off; an opted-out unit is listed but marked', () => {
  const forest = buildForest(tabsInOrder(rssOrder), nodesFrom(rssParents));
  assert.deepEqual(groupUnits(forest, {}, 'off'), []);
  const units = groupUnits(forest, { 14: { parent: 79, noGroup: true } }, 'innermost');
  assert.deepEqual(units.map((u) => [u.head, u.optedOut]), [[2, false], [14, true], [26, false]]);
});

test('pinned tabs are in no group', () => {
  const forest = buildForest(tabsInOrder([1, 2, 3], { 1: { pinned: true } }), nodesFrom({ 1: null, 2: 1, 3: 2 }));
  assert.deepEqual(groupUnits(forest, {}, 'trees').map((u) => u.tabs), [[2, 3]]);
});

test('a group is collapsed when its tabs are hidden in the panel', () => {
  const forest = buildForest(tabsInOrder(rssOrder), nodesFrom(rssParents));
  const [comedy, defcon] = groupUnits(forest, {}, 'innermost');
  const nodes = nodesFrom(rssParents, [2]);
  assert.equal(unitCollapsed(forest, nodes, comedy), true);
  assert.equal(unitCollapsed(forest, nodes, defcon), false);
  const top = nodesFrom(rssParents, [79]);
  assert.equal(unitCollapsed(forest, top, defcon), true, 'hidden under its collapsed parent');
  const [tree] = groupUnits(forest, {}, 'trees');
  assert.equal(unitCollapsed(forest, top, tree), true);
  assert.equal(unitCollapsed(forest, nodes, tree), false, 'a tab inside collapsed, not its top');
});

// ---- colours -------------------------------------------------------------------------------

test('a whole-tree group has its tree\'s colour', () => {
  const tabs = tabsInOrder([1, 2, 3, 4]);
  const nodes = nodesFrom({ 1: null, 2: 1, 3: null, 4: 3 });
  nodes[1].color = 'green';
  const forest = buildForest(tabs, nodes);
  const units = groupUnits(forest, nodes, 'trees');
  const colors = unitColors(forest, nodes, units, treeColors(forest, nodes));
  assert.equal(colors.get(1), 'green');
  assert.notEqual(colors.get(3), 'green');
});

test('innermost subtrees get colours of their own: not their tree\'s, and not their neighbours\'', () => {
  const nodes = nodesFrom(rssParents);
  nodes[79].color = 'blue';
  const forest = buildForest(tabsInOrder(rssOrder), nodes);
  const units = groupUnits(forest, nodes, 'innermost');
  const colors = unitColors(forest, nodes, units, treeColors(forest, nodes));
  const [a, b, c] = [colors.get(2), colors.get(14), colors.get(26)];
  assert.ok([a, b, c].every((color) => NEW_TREE_COLORS.includes(color) && color !== 'blue'), `${a} ${b} ${c}`);
  assert.notEqual(a, b);
  assert.notEqual(b, c);
});

test('a nested unit keeps its colour, and gets it back when it heads one again if it is free', () => {
  const nodes = nodesFrom(rssParents);
  nodes[79].color = 'blue';
  nodes[2].groupColor = 'red';
  nodes[14].lastGroupColor = 'cyan';
  nodes[26].lastGroupColor = 'red'; // taken by 2
  const forest = buildForest(tabsInOrder(rssOrder), nodes);
  const units = groupUnits(forest, nodes, 'innermost');
  const colors = unitColors(forest, nodes, units, treeColors(forest, nodes));
  assert.equal(colors.get(2), 'red');
  assert.equal(colors.get(14), 'cyan');
  assert.notEqual(colors.get(26), 'red');
  assert.equal(storeUnitColors(forest, nodes, units, colors), true);
  assert.equal(nodes[14].groupColor, 'cyan');
  assert.equal('lastGroupColor' in nodes[14], false);
  assert.equal(storeUnitColors(forest, nodes, units, colors), false, 'stored already');
});

test('a tab that stops heading a nested unit keeps its colour as lastGroupColor', () => {
  const nodes = nodesFrom(rssParents);
  nodes[2].groupColor = 'red';
  const forest = buildForest(tabsInOrder(rssOrder), nodes);
  // Whole trees: no nested units.
  const units = groupUnits(forest, nodes, 'trees');
  storeUnitColors(forest, nodes, units, unitColors(forest, nodes, units, treeColors(forest, nodes)));
  assert.equal(nodes[2].groupColor, undefined);
  assert.equal(nodes[2].lastGroupColor, 'red');
});

// ---- planning ------------------------------------------------------------------------------

/** planGroups for one window, worked out the way the worker does. */
function plan(tabs, nodes, { groups = [], owned = {}, adopted = new Set(), mode = 'trees', policy = 'leave' } = {}) {
  const forest = buildForest(tabs, nodes);
  const units = groupUnits(forest, nodes, mode);
  const colors = unitColors(forest, nodes, units, treeColors(forest, nodes));
  return planGroups({ tabs, groups, forest, units, colors, nodes, owned, adopted, policy, mode });
}

const grouped = (ids, groupId) => Object.fromEntries(ids.map((id) => [id, { groupId }]));

test('a new tree gets a new group, named and coloured, not collapsed', () => {
  const nodes = nodesFrom({ 1: null, 2: 1, 3: 1 });
  nodes[1].color = 'orange';
  const tabs = tabsInOrder([1, 2, 3], { 1: { title: '(2) Comedy · rss.test', active: true } });
  assert.deepEqual(plan(tabs, nodes), [
    { type: 'group', groupId: null, head: 1, tabIds: [1, 2, 3] },
    { type: 'update', groupId: null, head: 1, props: { title: 'Comedy', color: 'orange', collapsed: false } },
  ]);
});

test('an owned group takes in the tree\'s new tab, and lets go of a tab that left the tree', () => {
  const nodes = nodesFrom({ 1: null, 2: 1, 3: 1, 4: null });
  nodes[1].color = 'orange';
  const tabs = tabsInOrder([1, 2, 4, 3], { ...grouped([1, 2, 4], 7), 1: { groupId: 7, title: 'one' } });
  const groups = [{ id: 7, title: 'one', color: 'orange', collapsed: false }];
  assert.deepEqual(plan(tabs, nodes, { groups, owned: { 7: 1 } }), [
    { type: 'ungroup', tabIds: [4] },
    { type: 'group', groupId: 7, head: 1, tabIds: [3] },
  ]);
});

test('the group of a tree that ends is dissolved', () => {
  const nodes = nodesFrom({ 1: null, 2: null });
  const tabs = tabsInOrder([1, 2], grouped([1, 2], 7));
  const groups = [{ id: 7, title: 'one', color: 'orange', collapsed: false }];
  assert.deepEqual(plan(tabs, nodes, { groups, owned: { 7: 1 } }), [
    { type: 'release', groupId: 7 },
    { type: 'ungroup', tabIds: [1, 2] },
  ]);
});

test('tabs are ungrouped from the ends of their group inwards, so that each keeps its place', () => {
  // 1(2) and 5(6) were one tree's group 7 with 3 4 between them; now only 1(2) is a tree.
  const nodes = nodesFrom({ 1: null, 2: 1, 3: null, 4: null, 5: null, 6: null });
  nodes[1].color = 'orange';
  const tabs = tabsInOrder([1, 2, 3, 4, 5, 6], grouped([1, 2, 3, 4, 5, 6], 7));
  const groups = [{ id: 7, title: 't1', color: 'orange', collapsed: false }];
  assert.deepEqual(plan(tabs, nodes, { groups, owned: { 7: 1 } }), [{ type: 'ungroup', tabIds: [6, 5, 4, 3] }]);
});

test('tabs moving to a new group leave the group they are in first, so that the new group forms where they are', () => {
  // 30(31) was dropped before 1(2 3), all in 1's group 7 (the browser keeps a tab in its group when it moves to the
  // group's edge): grouped straight away, 30 and 31 would go after the rest of group 7.
  const nodes = nodesFrom({ 30: null, 31: 30, 1: null, 2: 1, 3: 1 });
  nodes[1].color = 'blue';
  nodes[30].color = 'orange';
  const tabs = tabsInOrder([30, 31, 1, 2, 3], grouped([30, 31, 1, 2, 3], 7));
  const groups = [{ id: 7, title: 't1', color: 'blue', collapsed: false }];
  assert.deepEqual(plan(tabs, nodes, { groups, owned: { 7: 1 } }).slice(0, 2), [
    { type: 'ungroup', tabIds: [30, 31] },
    { type: 'group', groupId: null, head: 30, tabIds: [30, 31] },
  ]);
});

test('when the top tab closes, the group carries on with the subtree that holds most of its tabs', () => {
  // 1 headed 2(3) and 4(5 6); 1 closed: 2 and 4 head trees of their own.
  const nodes = nodesFrom({ 2: null, 3: 2, 4: null, 5: 4, 6: 4 });
  nodes[2].color = 'orange';
  nodes[4].color = 'pink';
  const tabs = tabsInOrder([2, 3, 4, 5, 6], grouped([2, 3, 4, 5, 6], 7));
  const groups = [{ id: 7, title: 'one', color: 'orange', collapsed: false }];
  const ops = plan(tabs, nodes, { groups, owned: { 7: 1 } });
  assert.deepEqual(ops.slice(0, 1), [{ type: 'own', groupId: 7, head: 4 }]);
  assert.deepEqual(ops.filter((op) => op.type === 'group'), [{ type: 'group', groupId: null, head: 2, tabIds: [2, 3] }]);
});

test('a foreign group that holds exactly one tree becomes its group, with its name, colour and state', () => {
  const nodes = nodesFrom({ 1: null, 2: 1, 9: null });
  nodes[1].color = 'orange';
  const tabs = tabsInOrder([9, 1, 2], { ...grouped([1, 2], 5), 9: { active: true } });
  const groups = [{ id: 5, title: 'Comedy', color: 'blue', collapsed: true }];
  assert.deepEqual(plan(tabs, nodes, { groups }), [
    { type: 'adopt', groupId: 5, head: 1, foreign: true, title: 'Comedy', color: 'blue', collapsed: true },
  ]);
});

test('a tree with tabs in the user\'s own groups gets no group, unless the policy is to regroup', () => {
  // The user grouped 2 and 3 of tree 1(2 3 4) on their own.
  const nodes = nodesFrom({ 1: null, 2: 1, 3: 1, 4: 1 });
  nodes[1].color = 'orange';
  const tabs = tabsInOrder([1, 2, 3, 4], grouped([2, 3], 5));
  const groups = [{ id: 5, title: 'mine', color: 'blue', collapsed: false }];
  assert.deepEqual(plan(tabs, nodes, { groups }), []);
  const regroup = plan(tabs, nodes, { groups, policy: 'regroup' });
  assert.deepEqual(regroup.slice(0, 2), [
    { type: 'ungroup', tabIds: [2, 3] }, // out of the user's group first, where they are
    { type: 'group', groupId: null, head: 1, tabIds: [1, 2, 3, 4] },
  ]);
  // An owned group is let go of when one of the tree's tabs ends up in the user's group.
  const owned = plan(tabsInOrder([1, 2, 3, 4], { ...grouped([1, 2, 4], 7), 3: { groupId: 5 } }), nodes, {
    groups: [...groups, { id: 7, title: 'x', color: 'orange', collapsed: false }], owned: { 7: 1 },
  });
  assert.deepEqual(owned, [{ type: 'release', groupId: 7 }, { type: 'ungroup', tabIds: [1, 2, 4] }]);
});

test('after a reload, a tree takes back the group its top tab is in, as its own', () => {
  const nodes = nodesFrom({ 1: null, 2: 1, 3: 1 });
  nodes[1].color = 'orange';
  nodes[1].hadGroup = true;
  nodes[1].groupName = 'Mine';
  // The group lost tab 3 meanwhile.
  const tabs = tabsInOrder([1, 2, 3], grouped([1, 2], 8));
  const groups = [{ id: 8, title: 'Old', color: 'orange', collapsed: false }];
  assert.deepEqual(plan(tabs, nodes, { groups }), [
    { type: 'adopt', groupId: 8, head: 1, foreign: false, title: 'Old', color: 'orange', collapsed: false },
    { type: 'group', groupId: 8, head: 1, tabIds: [3] },
    { type: 'update', groupId: 8, head: 1, props: { title: 'Mine' } },
  ]);
});

test('an opted-out tree gets no group, and its owned group is let go of', () => {
  const nodes = nodesFrom({ 1: null, 2: 1 });
  nodes[1].noGroup = true;
  assert.deepEqual(plan(tabsInOrder([1, 2]), nodes), []);
  const groups = [{ id: 7, title: 'x', color: 'blue', collapsed: false }];
  assert.deepEqual(plan(tabsInOrder([1, 2], grouped([1, 2], 7)), nodes, { groups, owned: { 7: 1 } }), [
    { type: 'release', groupId: 7 },
    { type: 'ungroup', tabIds: [1, 2] },
  ]);
});

test('a collapsed tree\'s group collapses, the one that holds the active tab too, and stays collapsed', () => {
  const nodes = nodesFrom({ 1: null, 2: 1, 3: null }, [1]);
  nodes[1].color = 'orange';
  const groups = [{ id: 7, title: 't1', color: 'orange', collapsed: false }];
  const collapse = [{ type: 'update', groupId: 7, head: 1, props: { collapsed: true } }];
  const inside = tabsInOrder([1, 2, 3], { ...grouped([1, 2], 7), 1: { groupId: 7, active: true } });
  assert.deepEqual(plan(inside, nodes, { groups, owned: { 7: 1 } }), collapse);
  const outside = tabsInOrder([1, 2, 3], { ...grouped([1, 2], 7), 3: { active: true } });
  assert.deepEqual(plan(outside, nodes, { groups, owned: { 7: 1 } }), collapse);
  const shut = [{ ...groups[0], collapsed: true }];
  assert.deepEqual(plan(inside, nodes, { groups: shut, owned: { 7: 1 } }), [], 'collapsed around the active tab, it stays so');
  nodes[1].collapsed = false;
  assert.deepEqual(plan(inside, nodes, { groups: shut, owned: { 7: 1 } }), [
    { type: 'update', groupId: 7, head: 1, props: { collapsed: false } },
  ], 'expanded with its tree');
});

test('innermost: the user\'s FreshRSS groups are taken over, and the main stream stays out', () => {
  const nodes = nodesFrom(rssParents);
  nodes[79].color = 'blue';
  const tabs = tabsInOrder(rssOrder, { ...grouped([2, 21, 22, 23], 5), ...grouped([14, 41, 42, 43], 6), ...grouped([26, 61, 62], 7), 79: { active: true } });
  const groups = [
    { id: 5, title: 'Comedy', color: 'blue', collapsed: false },
    { id: 6, title: 'News Security', color: 'purple', collapsed: false },
    { id: 7, title: 'Makers IT', color: 'pink', collapsed: false },
  ];
  assert.deepEqual(plan(tabs, nodes, { groups, mode: 'innermost' }).map((op) => [op.type, op.groupId, op.head]), [
    ['adopt', 5, 2], ['adopt', 6, 14], ['adopt', 7, 26],
  ]);
  // With whole trees the main stream's tree holds tabs of the user's groups: left alone.
  assert.deepEqual(plan(tabs, nodes, { groups, mode: 'trees' }), []);
});

// ---- the user's changes in the tab strip ---------------------------------------------------

test('a tab dragged out of its group leaves its tree; its children move up into its place', () => {
  const nodes = nodesFrom({ 1: null, 2: 1, 3: 2, 4: 2, 5: 1 });
  nodes[2].heir = 'orange';
  leaveTree(nodes, 2);
  assert.deepEqual([nodes[2].parent, nodes[3].parent, nodes[4].parent, nodes[5].parent], [null, 1, 1, 1]);
  assert.equal(nodes[3].heir, 'orange');
});

test('a top tab dragged out of its group keeps its colour for later, and its subtrees carry the tree on', () => {
  const nodes = nodesFrom({ 1: null, 2: 1, 3: 2, 4: 1 });
  nodes[1].color = 'orange';
  leaveTree(nodes, 1);
  assert.equal(nodes[1].lastColor, 'orange');
  assert.equal(nodes[1].color, undefined);
  assert.deepEqual([nodes[2].parent, nodes[2].heir, nodes[4].heir], [null, 'orange', 'orange']);
});

test('a tab dragged into a group joins its tree where it lands', () => {
  // Tree 1(2(3) 4); tab 9 lands between 3 and 4, then between 2 and 3, then right after 1, then at the end.
  const parents = { 1: null, 2: 1, 3: 2, 4: 1, 9: null };
  const at = (order) => {
    const nodes = nodesFrom(parents);
    joinTree(tabsInOrder(order), nodes, 9, 1);
    return nodes[9].parent;
  };
  assert.equal(at([1, 2, 3, 9, 4]), 1, 'before 4: a sibling of 4');
  assert.equal(at([1, 2, 9, 3, 4]), 2, 'before 3: a sibling of 3, under 2');
  assert.equal(at([1, 9, 2, 3, 4]), 1, 'right after the head: a child of the head');
  assert.equal(at([9, 1, 2, 3, 4]), 1, 'before the head: its first child');
  assert.equal(at([1, 2, 3, 4, 9]), 1, 'after the last: a sibling of it');
  const deep = nodesFrom({ 1: null, 2: 1, 3: 2, 9: null });
  joinTree(tabsInOrder([1, 2, 3, 9]), deep, 9, 1);
  assert.equal(deep[9].parent, 2, 'after the last, 3: a sibling of 3');
});

test('a tree\'s top tab dragged into another group joins it alone; its children stay behind', () => {
  const nodes = nodesFrom({ 1: null, 2: 1, 5: null, 6: 5, 7: 5 });
  nodes[5].color = 'pink';
  joinTree(tabsInOrder([1, 5, 2, 6, 7]), nodes, 5, 1);
  assert.equal(nodes[5].parent, 1);
  assert.deepEqual([nodes[6].parent, nodes[7].parent], [null, null]);
  assert.equal(nodes[6].heir, 'pink');
  assert.equal(nodes[5].lastColor, 'pink');
});

// ---- after the first review ----------------------------------------------------------------

test('a group taken over from the user is never ungrouped: when its tree ends it is theirs again, as it is', () => {
  const nodes = nodesFrom({ 1: null, 2: null });
  const tabs = tabsInOrder([1, 2], grouped([1, 2], 5));
  const groups = [{ id: 5, title: 'Shopping', color: 'yellow', collapsed: false }];
  assert.deepEqual(plan(tabs, nodes, { groups, owned: { 5: 1 }, adopted: new Set([5]) }), [{ type: 'release', groupId: 5 }]);
  // ...nor when groups are off.
  const tree = nodesFrom({ 1: null, 2: 1 });
  assert.deepEqual(plan(tabs, tree, { groups, owned: { 5: 1 }, adopted: new Set([5]), mode: 'off' }), [{ type: 'release', groupId: 5 }]);
  // One the worker made is dissolved.
  assert.deepEqual(plan(tabs, tree, { groups, owned: { 5: 1 }, mode: 'off' }), [{ type: 'release', groupId: 5 }, { type: 'ungroup', tabIds: [1, 2] }]);
});

test('a group taken over from the user does not carry on with another unit: let go of, it holds that unit back', () => {
  // Innermost: the user's Comedy group (taken over) held 2(21 22 23); 21 opened 24, so 2 heads no unit now.
  const nodes = nodesFrom({ 79: null, 2: 79, 21: 2, 22: 2, 23: 2, 24: 21 });
  nodes[79].color = 'blue';
  const tabs = tabsInOrder([79, 2, 21, 24, 22, 23], { ...grouped([2, 21, 24, 22, 23], 5), 79: { active: true } });
  const groups = [{ id: 5, title: 'Comedy', color: 'blue', collapsed: false }];
  assert.deepEqual(plan(tabs, nodes, { groups, owned: { 5: 2 }, adopted: new Set([5]), mode: 'innermost' }), [
    { type: 'release', groupId: 5 },
  ]);
});

test('after a reload a tree takes back the group its top tab is in, though it holds a tab the snapshot did not know', () => {
  const nodes = nodesFrom({ 1: null, 2: 1, 3: null });
  nodes[1].color = 'orange';
  nodes[1].hadGroup = { title: 't1', color: 'orange' };
  // 3 (opened from 1 just before the reload) is in the group but top-level here.
  const tabs = tabsInOrder([1, 2, 3], grouped([1, 2, 3], 8));
  const groups = [{ id: 8, title: 't1', color: 'orange', collapsed: false }];
  assert.deepEqual(plan(tabs, nodes, { groups }), [
    { type: 'adopt', groupId: 8, head: 1, foreign: false, title: 't1', color: 'orange', collapsed: false },
    { type: 'ungroup', tabIds: [3] },
  ]);
  // Not a group of the user's that the top tab went into just before the reload (another name and colour) ...
  const into = nodesFrom({ 1: null, 2: 1, 3: null });
  into[1].hadGroup = { title: 't1', color: 'orange' };
  const theirs = plan(tabsInOrder([3, 1, 2], { 3: { groupId: 9 }, 1: { groupId: 9 } }), into, {
    groups: [{ id: 9, title: 'Reading', color: 'grey', collapsed: false }],
  });
  assert.ok(!theirs.some((op) => op.type === 'adopt'), JSON.stringify(theirs));
  // ... nor one that holds another unit's head too.
  const two = nodesFrom({ 1: null, 2: 1, 3: null, 4: 3 });
  two[1].hadGroup = true;
  const both = plan(tabsInOrder([1, 2, 3, 4], grouped([1, 2, 3, 4], 8)), two, { groups });
  assert.ok(!both.some((op) => op.type === 'adopt' && op.head === 1), JSON.stringify(both));
});

test('a group collapses only once the tabs on their way to another group, the active one say, have left it', () => {
  // 1(2) collapsed and 3(4) share group 7 (1's); 3 is no longer under 1. 4 is the active tab.
  const nodes = nodesFrom({ 1: null, 2: 1, 3: null, 4: 3 }, [1]);
  nodes[1].color = 'orange';
  nodes[3].color = 'pink';
  const tabs = tabsInOrder([1, 2, 3, 4], { ...grouped([1, 2, 3, 4], 7), 4: { groupId: 7, active: true } });
  const groups = [{ id: 7, title: 't1', color: 'orange', collapsed: false }];
  const ops = plan(tabs, nodes, { groups, owned: { 7: 1 } });
  const grouping = ops.findIndex((op) => op.type === 'group' && op.head === 3);
  const collapsing = ops.findIndex((op) => op.type === 'update' && op.groupId === 7 && op.props.collapsed);
  assert.ok(grouping >= 0 && collapsing > grouping, JSON.stringify(ops));
  // Should that pass stop before it (a step failed), the next one, once 3 and 4 have their own group, collapses 1's.
  const next = tabsInOrder([1, 2, 3, 4], { ...grouped([1, 2], 7), ...grouped([3, 4], 8), 4: { groupId: 8, active: true } });
  const both = [...groups, { id: 8, title: 't3', color: 'pink', collapsed: false }];
  assert.deepEqual(plan(next, nodes, { groups: both, owned: { 7: 1, 8: 3 } }), [
    { type: 'update', groupId: 7, head: 1, props: { collapsed: true } },
  ]);
});

test('a window\'s groups get their new look only after every tab is in its group', () => {
  // 1(2) and 3(4) share group 7 (1's); 3 is no longer under 1 and has been renamed by the user.
  const nodes = nodesFrom({ 1: null, 2: 1, 3: null, 4: 3 });
  nodes[1].color = 'orange';
  nodes[3].color = 'pink';
  nodes[1].groupName = 'One';
  const tabs = tabsInOrder([1, 2, 3, 4], grouped([1, 2, 3, 4], 7));
  const groups = [{ id: 7, title: 't1', color: 'orange', collapsed: false }];
  const ops = plan(tabs, nodes, { groups, owned: { 7: 1 } });
  const lastWrite = ops.findLastIndex((op) => op.type === 'group' || op.type === 'ungroup');
  const firstUpdate = ops.findIndex((op) => op.type === 'update');
  assert.ok(firstUpdate > lastWrite, JSON.stringify(ops));
});

test('tabs taken out of the middle of a group keep their order: the first half before it, the second after it', () => {
  // 30 and 31 (a tree now) sit in the middle of group 7, which carries on with 1's tree.
  const order = (strip) => {
    const nodes = nodesFrom({ 1: null, 2: 1, 3: 1, 30: null, 31: 30 });
    nodes[1].color = 'orange';
    nodes[30].color = 'pink';
    const tabs = tabsInOrder(strip, grouped(strip, 7));
    const ops = plan(tabs, nodes, { groups: [{ id: 7, title: 't1', color: 'orange', collapsed: false }], owned: { 7: 1 } });
    return ops.find((op) => op.type === 'ungroup').tabIds;
  };
  assert.deepEqual(order([1, 30, 31, 2, 3]), [30, 31], 'first half: the leftmost first');
  assert.deepEqual(order([1, 2, 30, 31, 3]), [31, 30], 'second half: the rightmost first');
});

test('tabs taken out of a group together keep their links: only the topmost leaves its tree', () => {
  const nodes = nodesFrom({ 1: null, 2: 1, 3: 2, 4: 2, 5: 1 });
  leaveTree(nodes, 2, new Set([2, 3]));
  assert.deepEqual([nodes[2].parent, nodes[3].parent, nodes[4].parent, nodes[5].parent], [null, 2, 1, 1]);
});

test('a group taken over from the user is ungrouped when they opt its tree out ("Ungroup in tab strip")', () => {
  const nodes = nodesFrom({ 1: null, 2: 1 });
  nodes[1].noGroup = true;
  const tabs = tabsInOrder([1, 2], grouped([1, 2], 5));
  const groups = [{ id: 5, title: 'Shopping', color: 'yellow', collapsed: false }];
  assert.deepEqual(plan(tabs, nodes, { groups, owned: { 5: 1 }, adopted: new Set([5]) }), [
    { type: 'release', groupId: 5 },
    { type: 'ungroup', tabIds: [1, 2] },
  ]);
});
