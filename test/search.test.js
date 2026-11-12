import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSpans, queryWords, switcherList, tabMatches } from '../extension/search.js';

const tab = (id, windowId, index, title, url, groupId = -1) => ({ id, windowId, index, title, url, groupId });

test('a query is its words, in any case; a tab matches when it has every one of them, in its title, address or group', () => {
  assert.deepEqual(queryWords('  Lisbon   HOTEL '), ['lisbon', 'hotel']);
  assert.deepEqual(queryWords(''), []);
  const hotel = tab(1, 1, 0, 'Hotel Avenida – Lisbon – Rooms', 'https://booking.example.com/hotel/42');
  assert.ok(tabMatches(hotel, queryWords('lisbon hotel')), 'both words, in another order');
  assert.ok(tabMatches(hotel, queryWords('booking rooms')), 'one in the address, one in the title');
  assert.ok(!tabMatches(hotel, queryWords('lisbon flight')), 'not when one word is missing');
  assert.ok(tabMatches(hotel, queryWords('')), 'no words: every tab');
  assert.ok(tabMatches(hotel, queryWords('trip lisbon'), 'Trip'), 'a word in the name of its tab group');
  assert.ok(!tabMatches(hotel, queryWords('trip')), 'not without that group');
  assert.ok(tabMatches({ title: '', pendingUrl: 'https://news.example.org/' }, queryWords('news')), 'the address it is loading');
});

test('the quick switcher lists the matches window by window, the window it was opened from first, each in strip order', () => {
  const tabs = [
    tab(11, 1, 1, 'Weather – Saturday', 'https://weather.example.com/sat'),
    tab(10, 1, 0, 'Weather – Friday', 'https://weather.example.com/fri'),
    tab(20, 2, 0, 'Inbox', 'https://mail.example.com/'),
    tab(21, 2, 1, 'Weather radar', 'https://radar.example.com/', 7),
    tab(30, 3, 0, 'Recipes', 'https://food.example.com/'),
  ];
  const list = (query, first, groupNames) => switcherList(tabs, queryWords(query), { windowOrder: [1, 2, 3], first, groupNames })
    .map(({ windowId, tabs: found }) => [windowId, found.map((t) => t.id)]);
  assert.deepEqual(list('weather', 2), [[2, [21]], [1, [10, 11]]], 'window 2 first; window 3 has no match');
  assert.deepEqual(list('', 3), [[3, [30]], [1, [10, 11]], [2, [20, 21]]], 'everything');
  assert.deepEqual(list('storm', 1, new Map([[7, 'Storm watch']])), [[2, [21]]], 'by its group\'s name');
  assert.deepEqual(list('weather', null), [[1, [10, 11]], [2, [21]]], 'no window first');
  assert.deepEqual(list('weather', 9), [[1, [10, 11]], [2, [21]]], 'a window that is gone first: the others in order');
});

test('the words of a query are marked where they are, overlapping ones as one', () => {
  assert.deepEqual(matchSpans('Hotel Avenida – Lisbon', queryWords('lisbon hotel')), [[0, 5], [16, 22]]);
  assert.deepEqual(matchSpans('aaaa', queryWords('aa')), [[0, 4]], 'each place, merged');
  assert.deepEqual(matchSpans('Avenida', queryWords('ven veni')), [[1, 5]], 'overlapping words');
  assert.deepEqual(matchSpans('Title', []), []);
});

test('the panel\'s search is its words, or a regular expression; one that is none matches every tab and marks nothing', async () => {
  const { makeSearch } = await import('../extension/search.js');
  const tab = { title: 'Release notes 1.7.2', url: 'https://example.com/changelog' };
  assert.equal(makeSearch('   '), null, 'an empty query: no search');
  const words = makeSearch('notes example');
  assert.ok(words.test(tab, ''), 'words: in the title and the address');
  assert.deepEqual(words.spans(tab.title), [[8, 13]]);
  const re = makeSearch(String.raw`\d+\.\d+\.\d+`, true);
  assert.ok(re.test(tab, ''), 'a regular expression over the title');
  assert.deepEqual(re.spans(tab.title), [[14, 19]], 'its matches marked');
  assert.ok(makeSearch('^https://example', true).test(tab, ''), 'and over the address');
  assert.ok(!makeSearch('^notes', true).test(tab, ''), 'anchored: not in the middle');
  assert.ok(makeSearch('RELEASE', true).test(tab, ''), 'case aside');
  assert.ok(makeSearch('work', true).test({ title: 'x', url: '' }, 'Work items'), 'and over the name of its group');
  const broken = makeSearch('(unclosed', true);
  assert.equal(broken.invalid, true);
  assert.ok(broken.test(tab, ''), 'not a regular expression: every tab');
  assert.deepEqual(broken.spans(tab.title), [], 'and nothing marked');
  assert.deepEqual(makeSearch('a*', true).spans('baaad'), [[1, 4]], 'empty matches are not marked');
});
