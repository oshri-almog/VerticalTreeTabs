import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOLDER_ICON, FOLDER_NAME, firstGrapheme, folderUrl, iconDataUrl, isFolderUrl, isNewTabPage, newFolderId, parseFolder,
} from '../extension/folders.js';
import { folderPlaceholders } from '../extension/restore.js';
import { autoName } from '../extension/groups.js';

const BASE = 'chrome-extension://abcdefghijklmnop/folder.html';

test('a folder is all in its URL: id, name and icon, with names of any kind, and the defaults left out', () => {
  for (const name of ['Work', 'Trip & tickets = 2', 'Ünïcödé ✈ שלום', '  spaces around  ', '100% ?#/']) {
    const url = folderUrl(BASE, { id: 'k3x9', name, icon: '🚀' });
    assert.ok(url.startsWith(`${BASE}?`), url);
    assert.deepEqual(parseFolder(url, BASE), { id: 'k3x9', name: name.trim(), icon: '🚀' }, name);
  }
  // The default name and icon are not written, and come back as the defaults.
  const plain = folderUrl(BASE, { id: 'a1', name: FOLDER_NAME, icon: FOLDER_ICON });
  assert.equal(plain, `${BASE}?id=a1`);
  assert.deepEqual(parseFolder(plain, BASE), { id: 'a1', name: FOLDER_NAME, icon: FOLDER_ICON });
  assert.deepEqual(parseFolder(folderUrl(BASE, { id: 'a1', name: '   ', icon: '' }), BASE), { id: 'a1', name: FOLDER_NAME, icon: FOLDER_ICON },
    'an empty name: the default');
  // An icon of several code points stays whole; only its first character counts.
  assert.equal(parseFolder(folderUrl(BASE, { id: 'f', icon: '🗂️' }), BASE).icon, '🗂️');
  assert.equal(parseFolder(`${BASE}?id=f&icon=${encodeURIComponent('🇮🇱🎉')}`, BASE).icon, '🇮🇱');
  assert.equal(parseFolder(`${BASE}?id=f#top`, BASE).id, 'f', 'a fragment is not part of it');
  assert.ok(isFolderUrl(BASE, BASE), 'no parameters at all: a folder of the defaults');
});

test('only the extension\'s own folder page is a folder', () => {
  for (const url of [
    'chrome-extension://abcdefghijklmnop/sidepanel.html?windowId=1',
    'chrome-extension://zzzzzzzzzzzzzzzz/folder.html?id=1', // another extension's page of that name
    `${BASE}x?id=1`,
    'https://example.com/folder.html?id=1',
    '',
    undefined,
  ]) assert.equal(parseFolder(url, BASE), null, String(url));
});

test('a new folder\'s id is ten letters or digits, different each time', () => {
  const ids = new Set(Array.from({ length: 200 }, newFolderId));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[0-9a-z]{10}$/);
});

test('the page\'s icon is an SVG of the emoji; the first character is what a person sees as one', () => {
  const url = iconDataUrl('📁');
  assert.ok(url.startsWith('data:image/svg+xml,'));
  assert.ok(decodeURIComponent(url).includes('>📁</text>'));
  assert.ok(decodeURIComponent(iconDataUrl('<&>')).includes('&#60;&#38;&#62;'), 'markup is escaped');
  assert.equal(firstGrapheme('  👍🏽 and more'), '👍🏽');
  assert.equal(firstGrapheme('👨‍👩‍👧 family'), '👨‍👩‍👧');
  assert.equal(firstGrapheme('   '), '');
});

test('a folder\'s tab group is named after the folder, whole, before its page has loaded too', () => {
  const page = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/folder.html';
  const url = folderUrl(page, { id: 'x1', name: 'Work - Q3 | plans' });
  assert.equal(autoName({ url, title: url }), 'Work - Q3 | plans', 'title not loaded yet: the URL');
  assert.equal(autoName({ url, title: 'Work - Q3 | plans' }), 'Work - Q3 | plans', 'not split at its dashes');
  assert.equal(autoName({ url: `${page}?id=x2`, title: '' }), FOLDER_NAME);
  assert.equal(autoName({ url: 'https://github.com/owner/repo', title: 'GitHub - owner/repo' }), 'owner/repo', 'other pages as before');
});

test('the New Tab pages that stand in for an extension page are told apart from other pages', () => {
  for (const url of ['chrome://newtab/', 'edge://newtab/', 'chrome://new-tab-page/', 'chrome://newtab']) assert.ok(isNewTabPage(url), url);
  for (const url of ['about:blank', 'chrome://settings/', 'https://newtab.example/', '', undefined]) assert.ok(!isNewTabPage(url), String(url));
});

test('saved folder tabs that came back as New Tab pages take the New Tab page where they were, between their neighbours', () => {
  const isFolder = (url) => isFolderUrl(url, BASE);
  const f1 = folderUrl(BASE, { id: 'f1', name: 'One' });
  const f2 = folderUrl(BASE, { id: 'f2', name: 'Two' });
  const snapshot = { windows: [{ tabs: [
    { id: 1, url: 'https://a.test/' },
    { id: 2, url: f1 },
    { id: 3, url: 'https://b.test/' },
    { id: 4, url: f2 },
    { id: 5, url: 'https://c.test/' },
  ] }] };
  // The browser brought the window back with new ids; the folders' pages are New Tab pages now, and so is a tab of the
  // user's own at the end.
  const windows = [
    { tabs: [{ id: 90, url: 'https://x.test/' }] }, // another window
    { tabs: [
      { id: 11, url: 'https://a.test/' },
      { id: 12, url: 'chrome://newtab/' },
      { id: 13, url: 'https://b.test/' },
      { id: 14, url: 'chrome://newtab/' },
      { id: 15, url: 'https://c.test/' },
      { id: 16, url: 'chrome://newtab/' },
    ] },
  ];
  const mapping = new Map([[1, 11], [3, 13], [5, 15]]);
  assert.deepEqual(folderPlaceholders(snapshot, windows, mapping, isFolder, isNewTabPage), [[2, 12, f1], [4, 14, f2]]);
  // A folder whose place holds no New Tab page takes none; nor one that another saved tab has.
  const taken = new Map([[1, 11], [3, 13], [5, 15], [99, 12]]);
  assert.deepEqual(folderPlaceholders(snapshot, windows, taken, isFolder, isNewTabPage), [[4, 14, f2]]);
  const shifted = [windows[0], { tabs: [windows[1].tabs[0], windows[1].tabs[2], windows[1].tabs[1], windows[1].tabs[4]] }];
  assert.deepEqual(folderPlaceholders(snapshot, shifted, mapping, isFolder, isNewTabPage), [[4, 12, f2]],
    'out of its place: the first folder finds no New Tab page between a.test and b.test, the second one does');
  // Two folders side by side take the two New Tab pages in order.
  const pair = { windows: [{ tabs: [{ id: 1, url: 'https://a.test/' }, { id: 2, url: f1 }, { id: 4, url: f2 }] }] };
  const pairWindows = [{ tabs: [{ id: 11, url: 'https://a.test/' }, { id: 21, url: 'edge://newtab/' }, { id: 22, url: 'edge://newtab/' }] }];
  assert.deepEqual(folderPlaceholders(pair, pairWindows, new Map([[1, 11]]), isFolder, isNewTabPage), [[2, 21, f1], [4, 22, f2]]);
  // A window none of whose tabs came back gives nothing.
  assert.deepEqual(folderPlaceholders(snapshot, windows, new Map(), isFolder, isNewTabPage), []);
});

test('after a reload, the folder pages (closed, or showing another page) do not count for matching the tabs by id', async () => {
  const { matchById } = await import('../extension/restore.js');
  const f = (id) => ({ id, url: folderUrl(BASE, { id: `f${id}` }) });
  const snapshot = { windows: [{ tabs: [f(1), f(2), f(3), { id: 4, url: 'https://a.test/' }, { id: 5, url: 'https://b.test/' }] }] };
  const tabs = [{ id: 4, url: 'https://a.test/' }, { id: 5, url: 'https://b.test/' }]; // the folders closed with the reload
  assert.equal(matchById(snapshot, tabs), null, 'counting the folders: 2 of 5, not matched');
  const mapping = matchById(snapshot, tabs, (url) => isFolderUrl(url, BASE));
  assert.deepEqual([...mapping], [[4, 4], [5, 5]], 'without them: the two others match');
  assert.equal(matchById({ windows: [{ tabs: [f(1)] }] }, [], (url) => isFolderUrl(url, BASE)), null, 'nothing else to tell by');
});

test('a closed window of a few tabs comes back only with most of them; a New Tab page counts for one of its folders', async () => {
  const { backByUrl, matchByUrl } = await import('../extension/restore.js');
  const page = (id, name) => ({ id, url: `https://c.test/${name}` });
  const kept = [page(1, 'c'), page(2, 'c1'), page(3, 'd')];
  assert.equal(backByUrl(kept, [page(11, 'c'), page(12, 'c1')]), false, 'two of three pages: a new window, not it');
  assert.equal(backByUrl(kept, [page(11, 'c'), page(12, 'c1'), page(13, 'd')]), true, 'all three');
  const big = [1, 2, 3, 4, 5, 6].map((i) => page(i, `p${i}`));
  assert.equal(backByUrl(big, big.slice(0, 3).map((t) => ({ ...t, id: t.id + 10 }))), true, 'a bigger window: half of it');
  const own = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/folder.html';
  const withFolder = [{ id: 1, url: `${own}?id=x` }, page(2, 'a'), page(3, 'b')];
  assert.equal(backByUrl(withFolder, [{ id: 11, url: 'chrome://newtab/' }, page(12, 'a'), page(13, 'b')]), true,
    'its folder back as a New Tab page counts');
  // The by-URL alignment leaves a folder and a New Tab page in its place to each other, so a real New Tab page after it
  // pairs with the saved one.
  const saved = { windows: [{ tabs: [page(1, 'a'), { id: 2, url: `${own}?id=x` }, { id: 3, url: 'chrome://newtab/' }, page(4, 'b')] }] };
  const now = [{ tabs: [page(11, 'a'), { id: 12, url: 'chrome://newtab/' }, { id: 13, url: 'chrome://newtab/' }, page(14, 'b')] }];
  const standsIn = (savedUrl, url) => savedUrl.startsWith(own) && url === 'chrome://newtab/';
  assert.deepEqual([...matchByUrl(saved, now, standsIn)].sort((x, y) => x[0] - y[0]), [[1, 11], [3, 13], [4, 14]]);
});

test('names are cut on whole characters: an emoji is not split', async () => {
  const { wholePrefix } = await import('../extension/folders.js');
  assert.equal(wholePrefix('abc', 10), 'abc');
  assert.equal(wholePrefix('ab😀cd', 3), 'ab', 'not half of the emoji');
  assert.equal(wholePrefix('ab😀cd', 4), 'ab😀');
  assert.equal(wholePrefix('👨‍👩‍👧x', 3), '', 'a family emoji is one character');
});
