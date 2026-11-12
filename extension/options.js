// Settings page: the settings (see SETTING_CHOICES in groups.js), kept in chrome.storage.local (`settings`; the worker
// and the panels watch them, so a change applies at once), in categories shown one at a time (the tabs on the left);
// an example tree beside the settings that move tabs around (see examples.js); the user's own colours (`colors`, see
// applyColors in sidepanel.js); the keyboard shortcuts; and the closed windows the worker keeps (`closedWindows`, see
// saveSnapshot in background.js).

import { DEFAULT_SETTINGS, readSettings } from './groups.js';
import { FOLDER_PAGE, parseFolder } from './folders.js';
import {
  afterCloseExample, closeParentExample, dropExample, groupsExample, linkExample, lookExample, placementExample,
} from './examples.js';

const form = document.getElementById('settings');
let settings = readSettings(null);

// Edge calls bookmarks favorites, and has a privacy policy of its own.
const isEdge = /\bEdg\//.test(navigator.userAgent);
if (isEdge) {
  for (const el of document.querySelectorAll('[data-edge]')) el.textContent = el.dataset.edge;
  for (const a of document.querySelectorAll('a[href$="/PRIVACY.md"]')) a.href = a.href.replace(/PRIVACY\.md$/, 'PRIVACY-EDGE.md');
}
document.getElementById('version').textContent = chrome.runtime.getManifest().version;

// ---- the categories --------------------------------------------------------------------------------

const tabs = [...document.querySelectorAll('[role="tab"]')];
// (The panels' ids are not the names in the address: a fragment that names an element scrolls to it and focuses it.)
const panelOf = (tab) => document.getElementById(`panel-${tab.dataset.panel}`);

/** Show category `name` (a panel's id; any other, the first), and keep it in the address for a reload. */
function selectCategory(name, { focus = false } = {}) {
  const chosen = tabs.find((tab) => tab.dataset.panel === name) ?? tabs[0];
  for (const tab of tabs) {
    const on = tab === chosen;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    panelOf(tab).hidden = !on;
  }
  if (focus) chosen.focus();
  else chosen.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (location.hash !== `#${chosen.dataset.panel}`) history.replaceState(null, '', `#${chosen.dataset.panel}`);
}

for (const tab of tabs) tab.addEventListener('click', () => selectCategory(tab.dataset.panel));
document.getElementById('tabs').addEventListener('keydown', (event) => {
  const at = tabs.indexOf(document.activeElement);
  if (at < 0) return;
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
  const next = step ? tabs[(at + step + tabs.length) % tabs.length]
    : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : null;
  if (!next) return;
  event.preventDefault();
  selectCategory(next.dataset.panel, { focus: true });
});
window.addEventListener('hashchange', () => selectCategory(location.hash.slice(1)));
selectCategory(location.hash.slice(1));

// ---- saving ----------------------------------------------------------------------------------------

const savedNote = document.getElementById('saved');
let savedTimer = null;
/** Say that a change was saved, for a moment. */
function saySaved() {
  savedNote.textContent = 'Saved';
  savedNote.classList.add('on');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    savedNote.classList.remove('on');
    savedNote.textContent = '';
  }, 1600);
}

// The default choice of each setting says so.
for (const [name, value] of Object.entries(DEFAULT_SETTINGS)) {
  const strong = form.querySelector(`input[name="${name}"][value="${value}"]`)?.closest('.option')?.querySelector('strong');
  if (!strong) continue;
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = 'Default';
  strong.append(badge);
}

function show(next) {
  settings = next;
  for (const [name, value] of Object.entries(settings)) {
    const input = form.querySelector(`input[name="${name}"][value="${value}"]`);
    if (input) input.checked = true;
  }
  // This page in the theme chosen, as the panel (see applyLook in sidepanel.js and look.js).
  document.documentElement.dataset.theme = settings.theme;
  showLook();
  for (const example of examples) example.draw();
}

form.addEventListener('submit', (event) => event.preventDefault());
form.addEventListener('change', async () => {
  const next = readSettings(Object.fromEntries(new FormData(form)));
  await chrome.storage.local.set({ settings: next });
  saySaved();
});

chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.settings) show(readSettings(changes.settings.newValue));
  if (changes.colors) showColors(readColors(changes.colors.newValue));
  if (changes.closedWindows) showClosed(changes.closedWindows.newValue ?? []);
});

// ---- the examples ------------------------------------------------------------------------------------

// For each setting with an example: the example for one of its values.
const EXAMPLE_OF = {
  groups: groupsExample,
  newTabPlacement: (value) => placementExample(value === 'browser' ? 'end' : value),
  bookmarkPlacement: (value) => placementExample(value === 'browser' ? 'end' : value),
  newTabButton: (value) => placementExample(value === 'hidden' ? 'none' : value),
  linkPlacement: linkExample,
  closeParent: closeParentExample,
  afterClose: afterCloseExample,
  dropInto: dropExample,
};

/** The rows of an example (see examples.js), as the panel draws tabs. */
function drawRows(rows) {
  const list = document.createElement('div');
  list.className = 'ex-list';
  for (const row of rows) {
    const el = document.createElement('div');
    el.className = 'ex-row';
    el.style.setProperty('--d', row.depth);
    for (const mark of ['current', 'added', 'closing', 'dragging', 'moved', 'unread']) el.classList.toggle(mark, !!row[mark]);
    if (row.group) {
      el.classList.add('in-group');
      el.style.setProperty('--g', `var(--g-${row.group})`);
    }
    const icon = document.createElement('span');
    icon.className = 'ex-icon';
    const title = document.createElement('span');
    title.className = 'ex-title';
    title.textContent = row.title;
    el.append(icon, title);
    if (row.unread) {
      const dot = document.createElement('span');
      dot.className = 'ex-dot';
      el.append(dot);
    }
    if (row.badge) {
      const badge = document.createElement('span');
      badge.className = 'ex-badge';
      badge.textContent = row.badge;
      el.append(badge);
    }
    list.append(el);
  }
  return list;
}

/** An example in `body`: its lists (with their labels), and its tab groups if it has any. */
function drawExample(body, example) {
  const parts = [];
  for (const list of example.lists) {
    if (list.label) {
      const label = document.createElement('p');
      label.className = 'ex-label';
      label.textContent = list.label;
      parts.push(label);
    }
    parts.push(drawRows(list.rows));
  }
  if (example.groups) {
    const groups = document.createElement('div');
    groups.className = 'ex-groups';
    if (!example.groups.length) {
      const none = document.createElement('span');
      none.className = 'ex-none';
      none.textContent = 'No tab groups';
      groups.append(none);
    }
    for (const group of example.groups) {
      const chip = document.createElement('span');
      chip.className = 'ex-chip';
      chip.style.setProperty('--g', `var(--g-${group.color})`);
      chip.textContent = group.tabs.length > 3 ? `${group.tabs[0]} + ${group.tabs.length - 1} tabs` : group.tabs.join(', ');
      groups.append(chip);
    }
    parts.push(groups);
  }
  body.replaceChildren(...parts);
}

// Each setting with an example shows the choice made, or the choice under the pointer or the keyboard focus.
const examples = [...document.querySelectorAll('.setting[data-example]')].map((fieldset) => {
  const name = fieldset.dataset.example;
  const figure = fieldset.querySelector('.example');
  const body = figure.querySelector('.example-body');
  let pointed = null;
  const draw = () => {
    const value = pointed ?? settings[name];
    figure.classList.toggle('previewing', pointed != null && pointed !== settings[name]);
    drawExample(body, EXAMPLE_OF[name](value));
    for (const note of figure.querySelectorAll('[data-note]')) note.hidden = note.dataset.note !== value;
  };
  for (const option of fieldset.querySelectorAll('.option')) {
    const { value } = option.querySelector('input');
    option.addEventListener('pointerenter', () => {
      pointed = value;
      draw();
    });
    option.addEventListener('pointerleave', () => {
      pointed = null;
      draw();
    });
  }
  return { draw };
});

/** The look's preview: the rows as the settings of the look have them. */
const lookPreview = document.getElementById('look-preview');
function showLook() {
  lookPreview.dataset.density = settings.density;
  lookPreview.dataset.textSize = settings.textSize;
  lookPreview.dataset.indent = settings.indent;
  lookPreview.dataset.unread = settings.unread;
  lookPreview.dataset.searchBox = settings.searchBox;
}
drawExample(lookPreview.querySelector('.example-body'), lookExample());

// ---- the user's own colours ----------------------------------------------------------------

const LIGHT_COLORS = Object.freeze({
  bg: '#ffffff', fg: '#1f1f1f', active: '#d3e3fd', activeFg: '#041e49', hover: '#eeeeee', accent: '#0b57d0',
});
const DARK_COLORS = Object.freeze({
  bg: '#1f1f1f', fg: '#e3e3e3', active: '#004a77', activeFg: '#e8f2ff', hover: '#2e2e2e', accent: '#a8c7fa',
});
/** The colours to start from: the theme's that the panel shows now (the settings' theme, or the browser's). */
function themeColors() {
  const theme = document.documentElement.dataset.theme;
  const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  return dark ? DARK_COLORS : LIGHT_COLORS;
}
const MOST_SAVED = 20;
const isColor = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const colorInputs = [...document.querySelectorAll('.color-grid input[type="color"]')];
const colorsOn = document.getElementById('colors-on');
const gradientOn = document.getElementById('gradient');
const gradientTo = document.getElementById('gradient-to');
const preview = document.getElementById('preview');
const themeName = document.getElementById('theme-name');
const savedList = document.getElementById('saved-themes');

/** The stored colours, each checked: what is not a colour is the default. */
function readColors(stored) {
  const start = themeColors();
  const values = Object.fromEntries(Object.entries(start).map(([key, value]) => [key, isColor(stored?.values?.[key]) ? stored.values[key] : value]));
  const saved = Array.isArray(stored?.saved) ? stored.saved.filter((theme) => typeof theme?.name === 'string' && theme.values) : [];
  return {
    on: !!stored?.on,
    values,
    gradient: !!stored?.gradient,
    gradientTo: isColor(stored?.gradientTo) ? stored.gradientTo : '#c2e7ff',
    saved: saved.slice(0, MOST_SAVED),
  };
}

let colors = readColors(null);

function showColors(next) {
  colors = next;
  colorsOn.checked = colors.on;
  for (const input of colorInputs) input.value = colors.values[input.dataset.key];
  gradientOn.checked = colors.gradient;
  gradientTo.value = colors.gradientTo;
  showPreview();
  document.getElementById('no-themes').hidden = colors.saved.length > 0;
  savedList.replaceChildren(...colors.saved.map((theme, i) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = theme.name;
    const swatches = document.createElement('span');
    swatches.className = 'mini';
    for (const key of ['bg', 'active', 'accent']) {
      const dot = document.createElement('span');
      dot.style.background = isColor(theme.values[key]) ? theme.values[key] : themeColors()[key];
      swatches.append(dot);
    }
    const use = button('Use', () => saveColors({ ...readColors({ ...theme, saved: colors.saved }), on: true }));
    const remove = button('Delete', () => saveColors({ ...colors, saved: colors.saved.filter((_, j) => j !== i) }));
    li.append(swatches, name, use, remove);
    return li;
  }));
}

/** The preview: the colours as the inputs have them now, as the panel would draw them. */
function showPreview() {
  const values = Object.fromEntries(colorInputs.map((input) => [input.dataset.key, input.value]));
  preview.style.setProperty('--p-bg', values.bg);
  preview.style.setProperty('--p-fg', values.fg);
  preview.style.setProperty('--p-active', gradientOn.checked ? `linear-gradient(90deg, ${values.active}, ${gradientTo.value})` : values.active);
  preview.style.setProperty('--p-active-fg', values.activeFg);
  preview.style.setProperty('--p-hover', values.hover);
  preview.style.setProperty('--p-accent', values.accent);
}

function current() {
  return {
    ...colors,
    on: colorsOn.checked,
    values: Object.fromEntries(colorInputs.map((input) => [input.dataset.key, input.value])),
    gradient: gradientOn.checked,
    gradientTo: gradientTo.value,
  };
}

async function saveColors(next) {
  await chrome.storage.local.set({ colors: readColors(next) });
  saySaved();
}

for (const input of [...colorInputs, gradientTo]) {
  input.addEventListener('input', showPreview);
  input.addEventListener('change', () => saveColors({ ...current(), on: true }));
}
colorsOn.addEventListener('change', () => saveColors(current()));
gradientOn.addEventListener('change', () => {
  showPreview();
  saveColors(current());
});
document.getElementById('save-theme').addEventListener('click', () => {
  // A name of its own: an unnamed set does not take the place of one saved before.
  let name = themeName.value.trim();
  for (let n = colors.saved.length + 1; !name || (!themeName.value.trim() && colors.saved.some((t) => t.name === name)); n++) name = `Colours ${n}`;
  if (!colors.saved.some((t) => t.name === name) && colors.saved.length >= MOST_SAVED) {
    themeName.setCustomValidity(`At most ${MOST_SAVED} are kept: delete one first`);
    themeName.reportValidity();
    return;
  }
  themeName.setCustomValidity('');
  const now = current();
  const theme = { name, values: now.values, gradient: now.gradient, gradientTo: now.gradientTo };
  saveColors({ ...now, saved: [theme, ...colors.saved.filter((t) => t.name !== name)] });
  themeName.value = '';
});
themeName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) document.getElementById('save-theme').click();
});
document.getElementById('reset-colors').addEventListener('click', () => saveColors({ ...readColors({ saved: colors.saved }), on: false }));

function button(label, action) {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  el.addEventListener('click', action);
  return el;
}

// ---- keyboard shortcuts --------------------------------------------------------------------

const COMMAND_ORDER = [
  '_execute_action', 'find-tab', 'new-folder', 'new-sibling', 'new-child', 'duplicate', 'toggle-tree', 'collapse-all',
  'expand-all', 'top-level', 'new-window', 'close-tree',
];

async function showShortcuts() {
  // Those with keys first, each part in this order (the browser lists them by name, and so does getManifest).
  const rank = (name) => (COMMAND_ORDER.includes(name) ? COMMAND_ORDER.indexOf(name) : COMMAND_ORDER.length);
  const commands = (await chrome.commands.getAll()).sort((a, b) => !a.shortcut - !b.shortcut || rank(a.name) - rank(b.name));
  document.getElementById('shortcuts').replaceChildren(...commands.map((command) => {
    const li = document.createElement('li');
    const what = document.createElement('span');
    what.className = 'name';
    what.textContent = command.description || 'Open the tree tabs side panel';
    const keys = document.createElement('kbd');
    keys.textContent = command.shortcut || 'not set';
    keys.classList.toggle('unset', !command.shortcut);
    li.append(what, keys);
    return li;
  }));
}
document.getElementById('change-keys').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
// Back from changing the keys (in another tab): the list as they are now.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') showShortcuts();
});
window.addEventListener('focus', showShortcuts);

// ---- closed windows -------------------------------------------------------------------------

const folderBase = chrome.runtime.getURL(FOLDER_PAGE);

/** A window can open again with its web pages and its folders (not the browser's own pages). */
const reopenable = (url) => /^https?:/i.test(url ?? '') || !!parseFolder(url, folderBase);

function showClosed(closed) {
  document.getElementById('no-closed').hidden = closed.length > 0;
  document.getElementById('closed-list').replaceChildren(...closed.map((win) => {
    const li = document.createElement('li');
    const what = document.createElement('span');
    what.className = 'name';
    const hosts = [...new Set(win.tabs.map((tab) => parseFolder(tab.url, folderBase)?.name ?? hostOf(tab.url)).filter(Boolean))];
    what.textContent = `${win.tabs.length} tabs: ${hosts.slice(0, 4).join(', ')}${hosts.length > 4 ? '…' : ''}`;
    what.title = win.tabs.map((tab) => tab.url).join('\n');
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = win.closedAt ? new Date(win.closedAt).toLocaleString() : '';
    const urls = win.tabs.map((tab) => tab.url).filter(reopenable);
    const open = button('Open again', () => chrome.windows.create({ url: urls, focused: true }));
    open.disabled = !urls.length;
    const forget = button('Forget', async () => {
      // That window, as the list is now (the worker may have changed it meanwhile).
      const key = (w) => `${w.closedAt}:${w.tabs?.[0]?.id}`;
      const { closedWindows = [] } = await chrome.storage.local.get('closedWindows');
      await chrome.storage.local.set({ closedWindows: closedWindows.filter((w) => key(w) !== key(win)) });
    });
    li.append(what, when, open, forget);
    return li;
  }));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const stored = await chrome.storage.local.get(['settings', 'colors', 'closedWindows']);
show(readSettings(stored.settings));
showColors(readColors(stored.colors));
showClosed(stored.closedWindows ?? []);
showShortcuts();
