import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksSlow, makeSearch } from '../extension/search.js';

test('a regular expression that could take very long is refused; ordinary ones are not', () => {
  for (const slow of [String.raw`(\w+\s?)+$`, '(a|aa)+', '(.*)*z', '((ab)+)+', '(x+){2,}', '(a*b*)*']) {
    assert.ok(looksSlow(slow), slow);
    const search = makeSearch(slow, true);
    assert.deepEqual([search.invalid, search.slow, search.test({ title: 'x' }, '')], [true, true, true], `${slow}: refused, every tab`);
  }
  for (const fine of [String.raw`^Ex\.\d$`, '(abc)+', '[(]+', String.raw`\(a+\)+`, '(a+)?', 'release|notes', '(github|gitlab)\\.com']) {
    assert.ok(!looksSlow(fine), fine);
  }
});
