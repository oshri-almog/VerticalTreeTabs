// Folders: tabs that show the extension's own page folder.html, as a named parent for the tabs put under it. The page's
// URL holds all there is to a folder (folder.html?id=…&name=…&icon=…), so the browser's own session restore keeps it,
// and a restore by URL tells two folders apart, even of the same name (see restore.js). Shared by the worker, the panel
// and the folder page.

export const FOLDER_PAGE = 'folder.html';
export const FOLDER_NAME = 'Folder';
export const FOLDER_ICON = '📁';

/** The icons offered for a folder (any other emoji can be typed in the folder's page). */
export const FOLDER_ICONS = Object.freeze([
  '📁', '📂', '🗂️', '⭐', '❤️', '🔥', '📌', '💼', '🏠', '🛒', '✈️', '🎮', '🎵', '🎬', '📚', '📰',
  '📝', '💡', '🔧', '💻', '📈', '💰', '🍔', '☕', '🎨', '📷', '🧪', '🐞', '🚀', '🌍', '🎓', '⚽',
  '🧩', '📅', '✅', '⚠️', '🔒', '🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '⬛',
]);

/** The URL of the page of `folder` ({ id, name, icon }); `base`: chrome.runtime.getURL(FOLDER_PAGE). */
export function folderUrl(base, { id, name, icon }) {
  const params = new URLSearchParams({ id: id || newFolderId() });
  if (name?.trim() && name.trim() !== FOLDER_NAME) params.set('name', name.trim());
  if (icon && icon !== FOLDER_ICON) params.set('icon', icon);
  return `${base}?${params}`;
}

/**
 * The folder that `url` is the page of, as { id, name, icon } with the default name and icon filled in, or null for any
 * other page (one of another extension, or another page of this one).
 */
export function parseFolder(url, base) {
  if (typeof url !== 'string' || !url.startsWith(base)) return null;
  const rest = url.slice(base.length);
  if (rest && rest[0] !== '?' && rest[0] !== '#') return null; // folder.htmlx, say
  const query = rest.startsWith('?') ? rest.slice(1).split('#')[0] : '';
  const params = new URLSearchParams(query);
  return {
    id: params.get('id') ?? '',
    name: params.get('name')?.trim() || FOLDER_NAME,
    icon: firstGrapheme(params.get('icon') ?? '') || FOLDER_ICON,
  };
}

export const isFolderUrl = (url, base) => parseFolder(url, base) != null;

/** A new folder's id: ten random letters and digits. */
export function newFolderId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (byte) => '0123456789abcdefghijklmnopqrstuvwxyz'[byte % 36]).join('');
}

/** The first character as a person sees it (an emoji of several code points, a flag), or ''. */
export function firstGrapheme(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)) return segment;
  }
  return Array.from(trimmed)[0];
}

/** The longest start of `text` of at most `most` code units that cuts no character in two (an emoji stays whole). */
export function wholePrefix(text, most) {
  const value = String(text ?? '');
  if (value.length <= most) return value;
  if (typeof Intl === 'undefined' || !Intl.Segmenter) return Array.from(value.slice(0, most)).join('').replace(/[\uD800-\uDBFF]$/, '');
  let end = 0;
  for (const { index, segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
    if (index + segment.length > most) break;
    end = index + segment.length;
  }
  return value.slice(0, end);
}

/** An icon for the page: the emoji, drawn as an SVG data URL. */
export function iconDataUrl(icon) {
  const text = String(icon).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50" y="54" font-size="84" `
    + `text-anchor="middle" dominant-baseline="middle">${text}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** A New Tab page: what the browser may show in place of an extension page that it could not bring back. */
export const isNewTabPage = (url) => /^(chrome|edge):\/\/(newtab|new-tab-page)\/?$/.test(url ?? '');
