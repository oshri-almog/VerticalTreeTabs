// A folder's page (see folders.js): its name and icon, which it keeps in its own URL, and the tabs under it in the tree,
// to switch to or close.

import { FOLDER_ICONS, FOLDER_NAME, FOLDER_PAGE, firstGrapheme, folderUrl, iconDataUrl, parseFolder } from './folders.js';
import { readSettings } from './groups.js';
import { buildForest, subtree } from './tree.js';

const base = chrome.runtime.getURL(FOLDER_PAGE);
const nameEl = document.getElementById('name');
const iconEl = document.getElementById('icon');
const iconsEl = document.getElementById('icons');
const gridEl = document.getElementById('icon-grid');
const ownIconEl = document.getElementById('own-icon');
const tabsEl = document.getElementById('tabs');
const emptyEl = document.getElementById('empty');
const newTabEl = document.getElementById('new-tab');
const faviconEl = document.getElementById('favicon');

let folder = parseFolder(location.href, base) ?? { id: '', name: FOLDER_NAME, icon: '📁' };
let me = null;
// A rename or an icon from the panel (see updateFolder in background.js): kept here, with no new history entry.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'folderChanged' || !me || message.tabId !== me.id) return false;
  keep(message.changes ?? {});
  sendResponse(true);
  return false;
});
me = await chrome.tabs.getCurrent();
const EMPTY_HINT = emptyEl.textContent;
const PINNED_HINT = 'This folder is pinned, and a pinned tab holds no tabs: unpin it to put tabs in it.';

/** The page as `folder` says: its title (the tab's), its icon (the tab's too), the field. */
function show() {
  document.title = folder.name;
  faviconEl.href = iconDataUrl(folder.icon);
  iconEl.textContent = folder.icon;
  if (document.activeElement !== nameEl) nameEl.value = folder.name;
  for (const button of gridEl.children) button.setAttribute('aria-pressed', String(button.textContent === folder.icon));
}

/** Keep a change in the page's URL (the tab's, which the browser restores and the worker saves). */
function keep(changes) {
  folder = { ...folder, ...changes };
  history.replaceState(null, '', folderUrl(base, folder));
  show();
}

// ---- name ------------------------------------------------------------------------------

nameEl.addEventListener('change', () => keep({ name: nameEl.value.trim() || FOLDER_NAME }));
nameEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) {
    keep({ name: nameEl.value.trim() || FOLDER_NAME });
    nameEl.blur();
  } else if (event.key === 'Escape') {
    nameEl.value = folder.name;
    nameEl.blur();
  }
});

// ---- icon ------------------------------------------------------------------------------

for (const icon of FOLDER_ICONS) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = icon;
  button.title = icon;
  button.addEventListener('click', () => {
    keep({ icon });
    openIcons(false);
  });
  gridEl.append(button);
}

function openIcons(open) {
  iconsEl.hidden = !open;
  iconEl.setAttribute('aria-expanded', String(open));
  if (open) gridEl.querySelector('[aria-pressed="true"]')?.focus();
}

iconEl.addEventListener('click', () => openIcons(iconsEl.hidden));
ownIconEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing) return;
  const icon = firstGrapheme(ownIconEl.value);
  if (icon) keep({ icon });
  ownIconEl.value = '';
  openIcons(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !iconsEl.hidden) {
    openIcons(false);
    iconEl.focus();
  }
});

// ---- the tabs in the folder --------------------------------------------------------------

let queued = null;
function scheduleList() {
  clearTimeout(queued);
  queued = setTimeout(renderList, 100);
}

async function renderList() {
  const self = await chrome.tabs.get(me.id).catch(() => null);
  if (!self) return;
  const [{ tree }, tabs] = await Promise.all([
    chrome.storage.session.get('tree'),
    chrome.tabs.query({ windowId: self.windowId }),
  ]);
  const nodes = tree?.nodes ?? {};
  const forest = buildForest(tabs, nodes);
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const inside = forest.parentOf.has(me.id) ? subtree(forest, me.id).slice(1) : [];
  newTabEl.disabled = !!self.pinned;
  emptyEl.textContent = self.pinned ? PINNED_HINT : EMPTY_HINT;
  const depthOf = (id) => {
    let depth = 0;
    for (let at = forest.parentOf.get(id); at != null && at !== me.id; at = forest.parentOf.get(at)) depth++;
    return depth;
  };
  tabsEl.replaceChildren(...inside.map((id) => row(byId.get(id), depthOf(id))));
  emptyEl.hidden = inside.length > 0;
}

function row(tab, depth) {
  const li = document.createElement('li');
  li.style.setProperty('--depth', depth);
  li.classList.toggle('active', !!tab.active);
  li.title = tab.url || '';
  const sub = parseFolder(tab.url || tab.pendingUrl, base);
  let icon;
  if (sub) {
    icon = document.createElement('span');
    icon.className = 'emoji';
    icon.textContent = sub.icon;
  } else {
    icon = document.createElement('img');
    icon.alt = '';
    const own = tab.favIconUrl && /^(https?|data):/.test(tab.favIconUrl) ? tab.favIconUrl : '';
    icon.src = own || cachedFavicon(tab.url || tab.pendingUrl);
    icon.addEventListener('error', () => { icon.style.visibility = 'hidden'; });
  }
  const title = document.createElement('span');
  title.className = 'title';
  title.dir = 'auto';
  title.textContent = sub ? sub.name : tab.title || tab.url || 'New Tab';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'close';
  close.textContent = '×';
  close.title = 'Close tab';
  close.setAttribute('aria-label', `Close ${title.textContent}`);
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    chrome.tabs.remove(tab.id);
  });
  li.append(icon, title, close);
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  li.addEventListener('click', () => chrome.tabs.update(tab.id, { active: true }));
  li.addEventListener('keydown', (event) => {
    if (event.target !== li) return; // the × has its own keys
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      chrome.tabs.update(tab.id, { active: true });
    } else if (event.key === 'Delete') {
      event.preventDefault();
      chrome.tabs.remove(tab.id);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      (event.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling)?.focus();
    }
  });
  return li;
}

/** The browser's own copy of a page's icon (the `favicon` permission). */
function cachedFavicon(pageUrl) {
  if (!pageUrl) return '';
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', '32');
  return url.href;
}

newTabEl.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'newTabIn', tabId: me.id, first: false }));

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.tree) scheduleList();
});
for (const event of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onMoved, chrome.tabs.onAttached,
  chrome.tabs.onDetached, chrome.tabs.onActivated]) {
  event.addListener(scheduleList);
}
chrome.tabs.onUpdated.addListener((id, change) => {
  if ('title' in change || 'favIconUrl' in change || 'url' in change || 'pinned' in change) scheduleList();
});
chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.settings) document.documentElement.dataset.theme = readSettings(changes.settings.newValue).theme;
});

// The URL may have been changed from the panel (a rename, an icon) while this page was loading: read it again then.
document.documentElement.dataset.theme = readSettings((await chrome.storage.local.get('settings')).settings).theme;
show();
renderList();
if (!new URLSearchParams(location.search).has('name')) {
  // A new folder: ready to be named.
  nameEl.focus();
  nameEl.select();
}
