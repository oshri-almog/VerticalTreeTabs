import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  afterCloseExample, closeParentExample, dropExample, groupsExample, linkExample, lookExample, placementExample,
} from '../extension/examples.js';

// A list as text: each row its title indented two spaces a level, marked * for the current tab, + for a new or dropped
// one, ~ for one that closes.
const text = (list) => list.rows.map((row) => `${'  '.repeat(row.depth)}${row.title}${row.current ? '*' : ''}${row.added || row.moved ? '+' : ''}${row.closing ? '~' : ''}`);

test('the tab groups example: each mode groups the tabs as groupUnits does', () => {
  const groups = (mode) => groupsExample(mode).groups.map((group) => group.tabs.join(' '));
  assert.deepEqual(groups('trees'), ['News Article Comments Reply Author Sports']);
  assert.deepEqual(groups('innermost'), ['Comments Reply']);
  assert.deepEqual(groups('pages'), ['News Sports', 'Article Author', 'Comments Reply']);
  assert.deepEqual(groups('branches'), ['News Sports', 'Article Comments Reply', 'Author']);
  assert.deepEqual(groups('off'), []);
  // The rows carry their group's colour, and each group is in one place: where groups stack, each comes right after
  // its parent's in the tab strip, whose order the panel follows.
  const pages = groupsExample('pages');
  assert.deepEqual(text(pages.lists[0]), ['News', '  Sports', '  Article', '    Author', '    Comments', '      Reply']);
  assert.deepEqual(pages.lists[0].rows.map((row) => row.group), ['blue', 'blue', 'orange', 'orange', 'pink', 'pink']);
  const branches = groupsExample('branches');
  assert.deepEqual(text(branches.lists[0]), ['News', '  Sports', '  Article', '    Comments', '      Reply', '    Author']);
  assert.deepEqual(branches.lists[0].rows.map((row) => row.group), ['blue', 'blue', 'orange', 'orange', 'orange', 'pink']);
  assert.deepEqual(text(groupsExample('trees').lists[0]), ['News', '  Article', '    Comments', '      Reply', '    Author', '  Sports']);
  assert.deepEqual(text(groupsExample('off').lists[0]), ['News', '  Article', '    Comments', '      Reply', '    Author', '  Sports']);
  assert.ok(groupsExample('off').lists[0].rows.every((row) => row.group == null));
});

test('the new tab example: where placeNear puts it by the current tab, or at the end', () => {
  const rows = (where) => text(placementExample(where).lists[0]);
  assert.deepEqual(rows('end'), ['Docs', '  Guide*', '    Section', '  FAQ', 'Mail', 'New tab+']);
  assert.deepEqual(rows('afterTree'), ['Docs', '  Guide*', '    Section', '  FAQ', 'New tab+', 'Mail']);
  assert.deepEqual(rows('sibling'), ['Docs', '  Guide*', '    Section', '  New tab+', '  FAQ', 'Mail']);
  assert.deepEqual(rows('child'), ['Docs', '  Guide*', '    Section', '    New tab+', '  FAQ', 'Mail']);
  assert.deepEqual(rows('none'), ['Docs', '  Guide*', '    Section', '  FAQ', 'Mail']);
});

test('the link example: first right under the page, last after the tabs under it', () => {
  const rows = (where) => text(linkExample(where).lists[0]);
  assert.deepEqual(rows('first'), ['Recipes*', '  Link+', '  Cake', '    Icing', '  Bread', 'Mail']);
  assert.deepEqual(rows('last'), ['Recipes*', '  Cake', '    Icing', '  Bread', '  Link+', 'Mail']);
  assert.deepEqual(rows('browser'), rows('last'));
  assert.equal(linkExample('browser').lists[0].rows.find((row) => row.added).badge, 'usually');
});

test('the closing examples: the tabs of a closed tab move up, or the first takes its place; the tree picks the next', () => {
  const up = closeParentExample('up');
  assert.deepEqual(text(up.lists[0]), ['Recipes~', '  Cake', '    Icing', '  Bread', 'Mail']);
  assert.deepEqual(text(up.lists[1]), ['Cake', '  Icing', 'Bread', 'Mail']);
  assert.deepEqual(text(closeParentExample('promote').lists[1]), ['Cake', '  Icing', '  Bread', 'Mail']);
  const tree = afterCloseExample('tree');
  assert.equal(tree.pick, 'Cake');
  assert.deepEqual(text(tree.lists[0]), ['Recipes', '  Cake', '    Icing', '  Bread*~', 'Mail']);
  assert.deepEqual(text(tree.lists[1]), ['Recipes', '  Cake*', '    Icing', 'Mail']);
  const browser = afterCloseExample('browser');
  assert.equal(browser.pick, null);
  assert.ok(browser.lists[1].rows.every((row) => !row.current));
});

test('the drop example: Pie under Recipes, last or first', () => {
  assert.deepEqual(text(dropExample('last').lists[0]), ['Recipes', '  Cake', '  Bread', 'Mail', 'Pie']);
  assert.deepEqual(text(dropExample('last').lists[1]), ['Recipes', '  Cake', '  Bread', '  Pie+', 'Mail']);
  assert.deepEqual(text(dropExample('first').lists[1]), ['Recipes', '  Pie+', '  Cake', '  Bread', 'Mail']);
});

test('the look example: a current tab and two unread ones', () => {
  const rows = lookExample().lists[0].rows;
  assert.deepEqual(text({ rows }), ['News', '  Article*', '    Comments', '  Sports', 'Mail']);
  assert.deepEqual(rows.filter((row) => row.unread).map((row) => row.title), ['Comments', 'Mail']);
});
