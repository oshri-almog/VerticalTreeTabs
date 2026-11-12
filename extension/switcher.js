// Quick switcher (opened by openSwitcher in background.js, in a small window of its own): every tab of every window,
// found by its title, address or tab group (see search.js), the window it was opened from first. Enter, or a click,
// switches to the chosen tab in its window; Esc, or going to another window, closes it.

import { readSettings } from './groups.js';
import { matchSpans, queryWords, switcherList } from './search.js';
import { FOLDER_PAGE, parseFolder } from './folders.js';

const folderBase = chrome.runtime.getURL(FOLDER_PAGE);

// At most this many rows are drawn at once: more is narrowed by typing.
const MOST_ROWS = 400;

const opener = Number(new URLSearchParams(location.search).get('windowId')) || null;
const input = document.getElementById('query');
const list = document.getElementById('results');
const none = document.getElementById('none');

let tabs = [];
let windows = [];
let groups = new Map(); // tab group id -> { title, color }
let shown = []; // the tabs drawn, in order
let selected = 0;

async function load() {
  const [allTabs, allWindows, allGroups, stored] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getAll({ windowTypes: ['normal'] }),
    chrome.tabGroups.query({}),
    chrome.storage.local.get('settings'),
  ]);
  document.documentElement.dataset.theme = readSettings(stored.settings).theme;
  windows = allWindows;
  const normal = new Set(allWindows.map((win) => win.id));
  // A folder is found by its name, not by its page's address (see folders.js).
  tabs = allTabs.filter((tab) => normal.has(tab.windowId)).map((tab) => {
    const folder = parseFolder(tab.url || tab.pendingUrl, folderBase);
    return folder ? { ...tab, title: folder.name, url: '', pendingUrl: '' } : tab;
  });
  groups = new Map(allGroups.map((group) => [group.id, { title: group.title || '', color: group.color }]));
  render();
}

function render() {
  const words = queryWords(input.value);
  const groupNames = new Map([...groups].map(([id, group]) => [id, group.title]));
  const found = switcherList(tabs, words, { windowOrder: windows.map((win) => win.id), first: opener, groupNames });
  const total = found.reduce((sum, win) => sum + win.tabs.length, 0);
  list.replaceChildren();
  shown = [];
  for (const { windowId, tabs: inWindow } of found) {
    if (shown.length >= MOST_ROWS) break;
    const header = document.createElement('div');
    header.className = 'window';
    header.setAttribute('role', 'presentation');
    header.textContent = windowLabel(windowId);
    list.append(header);
    for (const tab of inWindow) {
      if (shown.length >= MOST_ROWS) break;
      list.append(row(tab, words, shown.length));
      shown.push(tab);
    }
  }
  if (total > shown.length) {
    const more = document.createElement('div');
    more.className = 'more';
    more.textContent = `${total - shown.length} more: type more to narrow them down`;
    list.append(more);
  }
  none.hidden = shown.length > 0;
  select(Math.min(selected, shown.length - 1));
}

/** "This window" for the one it was opened from; another by its active tab and its number of tabs. */
function windowLabel(windowId) {
  const inWindow = tabs.filter((tab) => tab.windowId === windowId);
  if (windowId === opener) return 'This window';
  const active = inWindow.find((tab) => tab.active);
  return `Window of “${active?.title || 'New Tab'}” · ${inWindow.length} ${inWindow.length === 1 ? 'tab' : 'tabs'}`;
}

function row(tab, words, index) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.id = `result-${index}`;
  el.setAttribute('role', 'option');
  el.classList.toggle('current', !!tab.active && tab.windowId === opener);
  const icon = document.createElement('img');
  icon.className = 'favicon';
  icon.alt = '';
  const own = tab.favIconUrl && /^(https?|data):/.test(tab.favIconUrl) ? tab.favIconUrl : '';
  const cached = cachedFavicon(tab.url || tab.pendingUrl);
  icon.src = own || cached;
  icon.addEventListener('error', () => {
    if (cached && icon.src !== cached) icon.src = cached;
    else icon.style.visibility = 'hidden';
  });
  const title = document.createElement('span');
  title.className = 'title';
  mark(title, tab.title || tab.url || 'New Tab', words);
  el.append(icon, title);
  const group = groups.get(tab.groupId);
  if (group) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.dataset.color = group.color;
    mark(chip, group.title || 'Group', words);
    el.append(chip);
  }
  const where = document.createElement('span');
  where.className = 'where';
  mark(where, hostOf(tab.url || tab.pendingUrl), words);
  el.append(where);
  el.title = tab.url ? `${tab.title || ''}\n${tab.url}` : tab.title || '';
  el.addEventListener('mousemove', () => {
    if (selected !== index) select(index);
  });
  el.addEventListener('click', () => switchTo(tab));
  return el;
}

/** `text` in `el`, with the words of the search marked in it. */
function mark(el, text, words) {
  let from = 0;
  for (const [start, end] of matchSpans(text, words)) {
    const m = document.createElement('mark');
    m.textContent = text.slice(start, end);
    el.append(text.slice(from, start), m);
    from = end;
  }
  el.append(text.slice(from));
}

function hostOf(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return /^https?:$/.test(protocol) ? hostname.replace(/^www\./, '') : protocol.replace(/:$/, '');
  } catch {
    return '';
  }
}

/** The browser's own copy of a page's icon (the `favicon` permission). */
function cachedFavicon(pageUrl) {
  if (!pageUrl) return '';
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', '32');
  return url.href;
}

function select(index) {
  list.querySelector('.tab.selected')?.classList.remove('selected');
  selected = Math.max(0, index);
  const el = document.getElementById(`result-${selected}`);
  if (!el) {
    input.removeAttribute('aria-activedescendant');
    return;
  }
  el.classList.add('selected');
  el.scrollIntoView({ block: 'nearest' });
  input.setAttribute('aria-activedescendant', el.id);
}

async function switchTo(tab) {
  if (!tab) return;
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  window.close();
}

input.addEventListener('input', () => {
  selected = 0;
  render();
});

input.addEventListener('keydown', (event) => {
  const page = Math.max(1, Math.floor(list.clientHeight / 34) - 1);
  switch (event.key) {
    case 'ArrowDown': select((selected + 1) % Math.max(1, shown.length)); break;
    case 'ArrowUp': select((selected - 1 + shown.length) % Math.max(1, shown.length)); break;
    case 'PageDown': select(Math.min(shown.length - 1, selected + page)); break;
    case 'PageUp': select(Math.max(0, selected - page)); break;
    case 'Enter': switchTo(shown[selected]); break;
    case 'Escape': window.close(); break;
    default: return;
  }
  event.preventDefault();
});

// Gone to another window (or switched): done.
let hadFocus = document.hasFocus();
window.addEventListener('focus', () => {
  hadFocus = true;
});
window.addEventListener('blur', () => {
  if (hadFocus) window.close();
});

input.focus();
await load();
