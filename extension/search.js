// Searching tabs, for the panel's search box and the quick switcher (switcher.html). A query is words: a tab matches
// when each of them is somewhere in its title, its address or the name of its tab group, in any order and case.

/** The words of a query, lower-cased. */
export const queryWords = (query) => String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);

/** Whether `tab` (in a tab group named `groupName`, if any) has every one of `words`. */
export function tabMatches(tab, words, groupName = '') {
  if (!words.length) return true;
  const text = `${tab?.title ?? ''}\n${tab?.url || tab?.pendingUrl || ''}\n${groupName ?? ''}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/**
 * The quick switcher's list: the tabs that match `words`, window by window (the window `first` first, then the others
 * in `windowOrder`), each window's in strip order. `groupNames`: tab group id -> its name. Returns [{ windowId, tabs }],
 * without windows that have no match.
 */
export function switcherList(tabs, words, { windowOrder = [], first = null, groupNames = new Map() } = {}) {
  const byWindow = new Map();
  for (const tab of tabs) {
    if (!tabMatches(tab, words, groupNames.get(tab.groupId))) continue;
    if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
    byWindow.get(tab.windowId).push(tab);
  }
  const order = [first, ...windowOrder, ...byWindow.keys()].filter((id, i, all) => byWindow.has(id) && all.indexOf(id) === i);
  return order.map((windowId) => ({ windowId, tabs: byWindow.get(windowId).sort((a, b) => a.index - b.index) }));
}

/**
 * The panel's search for `query`: { test(tab, groupName), spans(text) }, by its words, or with `regex` as a regular
 * expression (case aside). null for an empty query; with `invalid` set for one that is no regular expression (it then
 * matches every tab and marks nothing).
 */
export function makeSearch(query, regex = false) {
  const source = String(query ?? '').trim();
  if (!source) return null;
  if (!regex) {
    const words = queryWords(source);
    return { test: (tab, groupName) => tabMatches(tab, words, groupName), spans: (text) => matchSpans(text, words) };
  }
  // A pattern that could take very long on a title (a repeated group that repeats or branches inside, as (a+)+ or
  // (a|aa)*) would stop the panel: it is refused, as one that is no regular expression is.
  if (looksSlow(source)) return { invalid: true, slow: true, test: () => true, spans: () => [] };
  let one;
  let every;
  try {
    one = new RegExp(source, 'i');
    every = new RegExp(source, 'gi');
  } catch {
    return { invalid: true, test: () => true, spans: () => [] };
  }
  return {
    test: (tab, groupName) => one.test(tab?.title ?? '') || one.test(tab?.url || tab?.pendingUrl || '') || (!!groupName && one.test(groupName)),
    spans: (text) => {
      const spans = [];
      for (const match of String(text ?? '').matchAll(every)) {
        if (match[0]) spans.push([match.index, match.index + match[0].length]);
        if (spans.length >= 100) break;
      }
      return spans;
    },
  };
}

/** Whether a regular expression has a group that repeats and itself repeats or branches inside (see makeSearch). */
export function looksSlow(source) {
  const groups = []; // for each open group: whether it repeats or branches inside
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      i++; // an escaped character is a plain one
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '(') groups.push(false);
    else if (c === ')') {
      const inner = groups.pop();
      const next = source[i + 1];
      if (inner && (next === '+' || next === '*' || next === '{')) return true;
      if (inner && groups.length) groups[groups.length - 1] = true;
    } else if ((c === '+' || c === '*' || c === '{' || c === '|') && groups.length) groups[groups.length - 1] = true;
  }
  return false;
}

/** The parts of `text` that the words of a query show, for highlighting: [[start, end]], sorted and merged. */
export function matchSpans(text, words) {
  const lower = String(text ?? '').toLowerCase();
  const spans = [];
  for (const word of words) {
    for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length)) spans.push([at, at + word.length]);
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}
