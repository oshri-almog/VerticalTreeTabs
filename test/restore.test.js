import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addClosedWindows, goneWindows, GROUP_FIELDS, MAX_CLOSED_WINDOWS, matchById, matchByUrl, matchClosedWindow, restoreNodes,
} from '../extension/restore.js';
import { buildForest, removeNode } from '../extension/tree.js';
import { groupUnits, storeFirstLinks } from '../extension/groups.js';

const tab = (id, url, parent = null, collapsed = false) => ({ id, url, parent, collapsed });

const snapshot = {
  savedAt: 0,
  windows: [
    {
      tabs: [
        tab(11, 'https://www.google.com/search?q=trees'),
        tab(12, 'https://a.example/', 11),
        tab(13, 'https://b.example/', 11, true),
        tab(14, 'https://b.example/deeper', 13),
        tab(15, 'chrome://newtab/'),
      ],
    },
    {
      tabs: [
        tab(21, 'https://mail.example/'),
        tab(22, 'https://mail.example/message', 21),
      ],
    },
  ],
};

test('after an extension reload the tabs map back by id', () => {
  const current = snapshot.windows.flatMap((w) => w.tabs).map(({ id, url }) => ({ id, url }));
  const mapping = matchById(snapshot, current);
  assert.deepEqual([...mapping], [11, 12, 13, 14, 15, 21, 22].map((id) => [id, id]));
});

test('after a browser restart the ids do not line up', () => {
  const current = snapshot.windows.flatMap((w) => w.tabs).map(({ id, url }) => ({ id: id + 100, url }));
  assert.equal(matchById(snapshot, current), null);
  // Same ids by coincidence, but different pages: still not an id match.
  const unrelated = [11, 12, 13, 14, 15, 21, 22].map((id) => ({ id, url: `https://other.example/${id}` }));
  assert.equal(matchById(snapshot, unrelated), null);
});

test('URL matching pairs windows and tabs, tolerating missing and extra tabs', () => {
  const windows = [
    // The mail window came back first this time.
    { tabs: [{ id: 3, url: 'https://mail.example/' }, { id: 4, url: 'https://mail.example/message' }] },
    {
      tabs: [
        { id: 5, url: 'https://www.google.com/search?q=trees' },
        { id: 6, url: 'https://a.example/' },
        // b.example was not restored
        { id: 7, url: 'https://b.example/deeper' },
        { id: 8, url: 'chrome://newtab/' },
        { id: 9, url: 'https://brand-new.example/' },
      ],
    },
  ];
  const mapping = matchByUrl(snapshot, windows);
  assert.deepEqual(
    [...mapping].sort((a, b) => a[0] - b[0]),
    [[11, 5], [12, 6], [14, 7], [15, 8], [21, 3], [22, 4]],
  );
});

test('restored tabs hang under their nearest restored ancestor', () => {
  const mapping = new Map([[11, 5], [12, 6], [14, 7], [15, 8], [21, 3], [22, 4]]);
  assert.deepEqual(restoreNodes(snapshot, mapping), {
    5: { parent: null, collapsed: false },
    6: { parent: 5, collapsed: false },
    7: { parent: 5, collapsed: false }, // its parent 13 is gone, so it moves up to 11
    8: { parent: null, collapsed: false },
    3: { parent: null, collapsed: false },
    4: { parent: 3, collapsed: false },
  });
});

test('collapsed state survives a restore', () => {
  const mapping = new Map([[11, 1], [13, 2], [14, 3]]);
  const nodes = restoreNodes(snapshot, mapping);
  assert.deepEqual(nodes[2], { parent: 1, collapsed: true });
  assert.deepEqual(nodes[3], { parent: 2, collapsed: false });
});

test('duplicate URLs pair up in order', () => {
  const dup = {
    windows: [{
      tabs: [tab(1, 'chrome://newtab/'), tab(2, 'https://x.example/', 1), tab(3, 'chrome://newtab/'), tab(4, 'https://y.example/', 3)],
    }],
  };
  const windows = [{
    tabs: [
      { id: 10, url: 'chrome://newtab/' },
      { id: 11, url: 'https://x.example/' },
      { id: 12, url: 'chrome://newtab/' },
      { id: 13, url: 'https://y.example/' },
    ],
  }];
  assert.deepEqual([...matchByUrl(dup, windows)], [[1, 10], [2, 11], [3, 12], [4, 13]]);
});

test('tree colours survive a restore unchanged, shared ones too', () => {
  const colored = {
    windows: [{
      tabs: [
        { ...tab(1, 'https://a.example/'), color: 'pink' },
        tab(2, 'https://a.example/1', 1),
        { ...tab(3, 'https://b.example/'), color: 'pink' }, // more than eight trees: colours repeat
        tab(4, 'https://b.example/1', 3),
        { ...tab(5, 'https://c.example/'), lastColor: 'green' }, // a tab that headed a tree before
        { ...tab(6, 'https://d.example/'), heir: 'yellow' }, // a tab whose parent closed
        { ...tab(7, 'https://d.example/1', 6), lastColor: 'red', heir: 'yellow' }, // both
      ],
    }],
  };
  assert.deepEqual(restoreNodes(colored, new Map([[1, 11], [2, 12], [3, 13], [4, 14], [5, 15], [6, 16], [7, 17]])), {
    11: { parent: null, collapsed: false, color: 'pink' },
    12: { parent: 11, collapsed: false },
    13: { parent: null, collapsed: false, color: 'pink' },
    14: { parent: 13, collapsed: false },
    15: { parent: null, collapsed: false, lastColor: 'green' },
    16: { parent: null, collapsed: false, heir: 'yellow' },
    17: { parent: 16, collapsed: false, lastColor: 'red', heir: 'yellow' },
  });
});

test('the children of a tab that was not restored are handed the colour of its tree', () => {
  const colored = {
    windows: [{
      tabs: [
        { ...tab(1, 'https://a.example/'), color: 'cyan' },
        tab(2, 'https://a.example/1', 1),
        tab(3, 'https://a.example/1/1', 2),
        { ...tab(4, 'https://a.example/2', 1), lastColor: 'red' },
        { ...tab(5, 'https://b.example/'), color: 'pink' },
        { ...tab(6, 'https://b.example/1', 5), lastColor: 'orange' },
        tab(7, 'https://b.example/1/1', 6),
        { ...tab(8, 'https://b.example/1/2', 6), heir: 'green' },
        { ...tab(9, 'https://c.example/'), color: 'purple' },
        { ...tab(10, 'https://c.example/1', 9), color: 'yellow' }, // it headed a tree in another window
        tab(11, 'https://c.example/1/1', 10),
        { ...tab(20, 'https://d.example/'), heir: 'blue' }, // pinned, after its tree's top tab closed
        tab(21, 'https://d.example/1', 20),
      ],
    }],
  };
  // Tabs 1, 5, 6, 9, 10 and 20 did not come back.
  const mapping = new Map([[2, 12], [3, 13], [4, 14], [7, 17], [8, 18], [11, 31], [21, 41]]);
  assert.deepEqual(restoreNodes(colored, mapping), {
    12: { parent: null, collapsed: false, heir: 'cyan' },
    13: { parent: 12, collapsed: false },
    14: { parent: null, collapsed: false, lastColor: 'red', heir: 'cyan' },
    17: { parent: null, collapsed: false, heir: 'pink' }, // 6 holds no tree colour (its lastColor is its own): the one 5 headed
    18: { parent: null, collapsed: false, heir: 'green' }, // its own
    31: { parent: null, collapsed: false, heir: 'yellow' }, // the nearest
    41: { parent: null, collapsed: false, heir: 'blue' },
  });
});

test('the tab group fields come back with the tree', () => {
  const snapshot = { windows: [{ tabs: [
    { id: 1, url: 'https://a.test/1', parent: null, collapsed: false, color: 'blue', groupName: 'Mine', hadGroup: { title: 'Mine', color: 'blue' }, groupAdopted: true },
    { id: 2, url: 'https://a.test/2', parent: 1, collapsed: false, groupColor: 'pink', noGroup: true },
    { id: 3, url: 'https://a.test/3', parent: 2, collapsed: false, lastGroupColor: 'cyan' },
  ] }] };
  const nodes = restoreNodes(snapshot, new Map([[1, 11], [2, 12], [3, 13]]));
  assert.deepEqual(nodes[11], { parent: null, collapsed: false, color: 'blue', groupName: 'Mine', hadGroup: { title: 'Mine', color: 'blue' }, groupAdopted: true });
  assert.deepEqual(nodes[12], { parent: 11, collapsed: false, groupColor: 'pink', noGroup: true });
  assert.deepEqual(nodes[13], { parent: 12, collapsed: false, lastGroupColor: 'cyan' });
});

test('a first link (see firstLink in groups.js) comes back as the tab it is now', () => {
  const snapshot = { windows: [{ tabs: [
    { id: 1, url: 'https://a.test/1', parent: null, firstLink: 2 }, { id: 2, url: 'https://a.test/2', parent: 1 },
    { id: 4, url: 'https://a.test/4', parent: 1, firstLink: 7 }, { id: 8, url: 'https://a.test/8', parent: 4 },
    { id: 7, url: 'https://a.test/7', parent: 4, firstLink: 9 }, { id: 9, url: 'https://a.test/9', parent: 7 },
  ] }] };
  // Chrome numbers the tabs anew in strip order: 8, before 7 there, has the lower id now.
  const nodes = restoreNodes(snapshot, new Map([[1, 101], [2, 102], [8, 103], [4, 104], [7, 105], [9, 106]]));
  assert.deepEqual([nodes[101].firstLink, nodes[104].firstLink, nodes[105].firstLink], [102, 105, 106]);
  // One that did not come back hands it on to its own first link, as a closed tab does; with none, there is none.
  const lost = restoreNodes(snapshot, new Map([[1, 101], [2, 102], [8, 103], [4, 104], [9, 106]]));
  assert.deepEqual([lost[104].firstLink, lost[106].parent], [106, 104]);
  const none = restoreNodes(snapshot, new Map([[1, 101], [8, 103], [4, 104]]));
  assert.deepEqual([none[101].firstLink, none[104].firstLink], [undefined, undefined]);
  // So do the other tabs of a branch (`alsoLinks`, see handOnFirstLink in tree.js).
  const branch = { windows: [{ tabs: [
    { id: 1, url: 'https://b.test/1', parent: null }, { id: 3, url: 'https://b.test/3', parent: 1, firstLink: 6, alsoLinks: [7] },
    { id: 6, url: 'https://b.test/6', parent: 3 }, { id: 7, url: 'https://b.test/7', parent: 3, firstLink: 8 },
    { id: 8, url: 'https://b.test/8', parent: 7 },
  ] }] };
  const back = restoreNodes(branch, new Map([[1, 101], [3, 102], [6, 103], [7, 104], [8, 105]]));
  assert.deepEqual([back[102].firstLink, back[102].alsoLinks], [103, [104]]);
  const without = restoreNodes(branch, new Map([[1, 101], [3, 102], [6, 103], [8, 105]]));
  assert.deepEqual([without[102].alsoLinks, without[105].parent], [[105], 102]);
  const gone = restoreNodes(branch, new Map([[1, 101], [3, 102], [6, 103]]));
  assert.equal(gone[102].alsoLinks, undefined);
});

// 'branches' after a restart: the first links and alsoLinks of the tabs that came back, compared with a close of the
// missing ones in the session (a tab closed just before the browser quit is still in the snapshot).
const linkTabs = (order) => order.map((id, index) => ({ id, index, windowId: 1, groupId: -1, pinned: false }));
const linkNodes = (parents) => Object.fromEntries(Object.entries(parents).map(([id, parent]) => [id, { parent, collapsed: false }]));
const linkPass = (order, nodes) => storeFirstLinks(buildForest(linkTabs(order), nodes), nodes);
const branchUnits = (order, nodes) => groupUnits(buildForest(linkTabs(order), nodes), nodes, 'branches').map((u) => [u.head, u.tabs]);
const linkRecords = (nodes) => Object.fromEntries(Object.entries(nodes).filter(([, n]) => n.firstLink != null || n.alsoLinks)
  .map(([id, n]) => [Number(id), [n.firstLink ?? null, n.alsoLinks ?? []]]));
const snapshotOf = (nodes, order) => ({ windows: [{ tabs: order.map((id) => {
  const entry = { id, url: `https://x.test/${id}`, parent: nodes[id].parent ?? null, collapsed: false };
  for (const key of GROUP_FIELDS) if (nodes[id][key] != null) entry[key] = structuredClone(nodes[id][key]);
  return entry;
}) }] });

/** The records and units after `gone` close in the session, and after a restart without them: [session, restart]. */
function closeOrRestart(nodes, order, gone, renumber) {
  const snap = snapshotOf(nodes, order);
  const closed = structuredClone(nodes);
  for (const id of gone) removeNode(closed, id);
  const left = order.filter((id) => !gone.includes(id));
  linkPass(left, closed);
  // Chrome numbers the tabs anew, in strip order from 1: new ids that overlap the saved ones.
  const now = new Map(left.map((id, i) => [id, renumber ? i + 1 : id]));
  const was = new Map([...now].map(([old, id]) => [id, old]));
  const mapping = renumber
    ? matchByUrl(snap, [{ tabs: left.map((id) => ({ id: now.get(id), url: `https://x.test/${id}` })) }])
    : matchById(snap, left.map((id) => ({ id, url: `https://x.test/${id}` })));
  const restored = restoreNodes(snap, mapping);
  linkPass(left.map((id) => now.get(id)), restored);
  const records = Object.fromEntries(Object.entries(linkRecords(restored))
    .map(([id, [link, also]]) => [was.get(Number(id)), [link == null ? null : was.get(link), also.map((x) => was.get(x))]]));
  const units = branchUnits(left.map((id) => now.get(id)), restored).map(([head, tabs]) => [was.get(head), tabs.map((x) => was.get(x))]);
  return [[linkRecords(closed), branchUnits(left, closed)], [records, units]];
}

test('a window that closed while the browser ran on is kept, and a window that comes back with its pages takes its tree', () => {
  const tab = (id, page, parent = null) => ({ id, url: `https://c.test/${page}`, parent });
  const one = { tabs: [tab(1, 'a'), tab(2, 'a1', 1), tab(3, 'b')] }; // a tree: 2 under 1
  const flat = { tabs: [tab(4, 'x'), tab(5, 'y')] }; // no tree: nothing to keep
  const two = { tabs: [tab(6, 'p'), tab(7, 'p1', 6), tab(8, 'p2', 6), tab(9, 'q')] };
  // Open: 6, so `two` is; `one` closed; `flat` closed, but it has no tree.
  assert.deepEqual(goneWindows([one, flat, two], [{ tabs: [{ id: 6, url: 'https://c.test/p' }] }]), [one]);
  // After a restart that numbered the tabs anew, a window back under new ids is not gone: most of its pages are open.
  assert.deepEqual(goneWindows([one], [{ tabs: [{ id: 51, url: 'https://c.test/a' }, { id: 52, url: 'https://c.test/a1' }] }]), []);
  // Kept the newest first, MAX_CLOSED_WINDOWS at most.
  let closed = [];
  for (let i = 0; i < 12; i++) closed = addClosedWindows(closed, [{ tabs: [tab(100 + i, `w${i}`), tab(200 + i, `v${i}`, 100 + i)] }], i);
  assert.deepEqual([closed.length, closed[0].closedAt, closed.at(-1).closedAt], [MAX_CLOSED_WINDOWS, 11, 2]);
  // A window that comes back (new tabs, the same pages) takes the tree of the closed window that is most like it...
  const back = [31, 32, 33, 34].map((id, i) => ({ id, url: two.tabs[i].url }));
  const match = matchClosedWindow([one, two], back);
  assert.deepEqual([match.index, [...match.mapping]], [1, [[6, 31], [7, 32], [8, 33], [9, 34]]]);
  const nodes = restoreNodes({ windows: [two] }, match.mapping);
  assert.deepEqual([nodes[31].parent, nodes[32].parent, nodes[33].parent, nodes[34].parent], [null, 31, 31, null]);
  // ... but not one tab, nor a window that shares less than half its pages, or half of the closed window's.
  assert.equal(matchClosedWindow([two], back.slice(0, 1)), null);
  const others = [40, 41, 42, 43].map((id) => ({ id, url: `https://c.test/n${id}` }));
  assert.equal(matchClosedWindow([two], [...back.slice(0, 2), ...others]), null);
  const big = { tabs: [...two.tabs, ...[60, 61, 62, 63, 64].map((id) => tab(id, `m${id}`))] };
  assert.equal(matchClosedWindow([big], back.slice(0, 2)), null);
});

test('branches: the tabs closed just before a restart hand their places on as a close does, all of them', () => {
  // 1 opened 2; 2 opened 3 (its first link), which opened 4 and 6; 2 opened 5 in between.
  const parents = { 1: null, 2: 1, 3: 2, 4: 3, 5: 2, 6: 3 };
  const order = [1, 2, 3, 4, 6, 5];
  const fresh = () => {
    const nodes = linkNodes(parents);
    linkPass(order, nodes);
    return nodes;
  };
  for (const renumber of [false, true]) {
    for (const gone of [[], [3], [3, 4], [6], [3, 6]]) {
      const [session, restart] = closeOrRestart(fresh(), order, gone, renumber);
      assert.deepEqual(restart, session, `${gone.join(' and ') || 'none'} missing${renumber ? ', ids anew' : ''}`);
    }
  }
  const [, [records, units]] = closeOrRestart(fresh(), order, [3], false);
  assert.deepEqual([records[2], units], [[4, [6]], [[1, [1]], [2, [2, 4, 6]], [5, [5]]]], '3 missing: 4 and 6 stay in 2\'s branch');
  // One of the alsoLinks, with tabs of its own (6 opened 7 and 8; 3 closed earlier), and the first link that opened none.
  const also = linkNodes({ ...parents, 7: 6, 8: 6 });
  linkPass([1, 2, 3, 4, 6, 7, 8, 5], also);
  removeNode(also, 3);
  const left = [1, 2, 4, 6, 7, 8, 5];
  linkPass(left, also);
  for (const renumber of [false, true]) {
    for (const gone of [[6], [4], [4, 6]]) {
      const [session, restart] = closeOrRestart(structuredClone(also), left, gone, renumber);
      assert.deepEqual(restart, session, `${gone.join(' and ')} missing${renumber ? ', ids anew' : ''}`);
    }
  }
});
