// Rebuilding the tree when the in-memory copy is gone.
//
// The worker keeps a snapshot in chrome.storage.local:
//   { savedAt, windows: [{ tabs: [{ id, url, parent, collapsed, color, lastColor, heir, ...group fields }] }] }
//   (tabs in strip order; the group fields, see GROUP_FIELDS, only where they are set)
// After an extension reload or update the tabs keep their ids, so the snapshot maps back
// by id. After a browser restart every tab gets a new id, so tabs are matched by URL.

import { colorOf, removeNode } from './tree.js';

/** The fields of a node for its tab group (see groups.js) that a snapshot keeps, where they are set. */
export const GROUP_FIELDS = [
  'groupName', 'groupColor', 'lastGroupColor', 'noGroup', 'hadGroup', 'groupAdopted', 'firstLink', 'alsoLinks',
];

/**
 * Map saved ids to current tabs when the ids survived (extension reload / update).
 * Returns null when they did not line up, as after a browser restart.
 */
export function matchById(snapshot, tabs) {
  const current = new Map(tabs.map((tab) => [tab.id, tab]));
  const saved = snapshot.windows.flatMap((w) => w.tabs);
  if (!saved.length) return null;
  const confirmed = saved.filter((s) => s.url && urlOf(current.get(s.id)) === s.url).length;
  if (confirmed * 2 < saved.length) return null;
  return new Map(saved.filter((s) => current.has(s.id)).map((s) => [s.id, s.id]));
}

/**
 * Map saved ids to current tabs by URL (browser restart). Saved windows are paired with
 * the current windows that share the most URLs, then each pair's tabs are aligned in
 * order, so duplicates such as several "New Tab" pages pair up in sequence.
 *
 * `windows` is [{ tabs: [{ id, url }] }] with each window's tabs in strip order.
 */
export function matchByUrl(snapshot, windows) {
  const candidates = [];
  snapshot.windows.forEach((saved, i) => {
    windows.forEach((current, j) => {
      const score = sharedUrlCount(saved.tabs, current.tabs);
      if (score > 0) candidates.push({ i, j, score });
    });
  });
  candidates.sort((a, b) => b.score - a.score);

  const mapping = new Map();
  const usedSaved = new Set();
  const usedCurrent = new Set();
  for (const { i, j } of candidates) {
    if (usedSaved.has(i) || usedCurrent.has(j)) continue;
    usedSaved.add(i);
    usedCurrent.add(j);
    const savedTabs = snapshot.windows[i].tabs;
    const currentTabs = windows[j].tabs;
    for (const [a, b] of alignByUrl(savedTabs, currentTabs)) {
      mapping.set(savedTabs[a].id, currentTabs[b].id);
    }
  }
  return mapping;
}

/**
 * Turn a snapshot plus a saved-id -> current-id mapping into nodes for the current tabs.
 * A tab whose saved parent was not found hangs under its nearest ancestor that was. Tree colours
 * come back as they were; a tab that held no tree colour is handed the one of the nearest
 * ancestor that was not found and has one (see colorOf), as if those tabs had been closed (see
 * removeNode). The first links (see firstLink in groups.js) and the other tabs of a branch
 * (`alsoLinks`) are the tabs they are now, as a close of the tabs that were not found would have
 * left them (see handOnFirstLink in tree.js).
 */
export function restoreNodes(snapshot, mapping) {
  const saved = new Map();
  for (const w of snapshot.windows) for (const tab of w.tabs) saved.set(tab.id, tab);

  const nodes = {};
  // The records as the saved ids have them, the tabs not found closed (removeNode hands their places on); then the tabs
  // that those are now.
  const links = {};
  for (const [id, entry] of saved) {
    links[id] = { parent: entry.parent ?? null, firstLink: entry.firstLink ?? undefined };
    if (Array.isArray(entry.alsoLinks)) links[id].alsoLinks = [...entry.alsoLinks];
  }
  for (const id of saved.keys()) if (!mapping.has(id)) removeNode(links, id);
  const linkNow = (link) => (link != null && mapping.has(link) ? mapping.get(link) : null);
  for (const [oldId, newId] of mapping) {
    const entry = saved.get(oldId);
    if (!entry) continue;
    const seen = new Set([oldId]);
    let parent = entry.parent;
    let lost = null; // the tree colour of the nearest ancestor that was not found
    while (parent != null && !mapping.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      lost ??= colorOf(saved.get(parent)) ?? null;
      parent = saved.get(parent)?.parent ?? null;
    }
    const node = {
      parent: parent != null && mapping.has(parent) ? mapping.get(parent) : null,
      collapsed: !!entry.collapsed,
    };
    // Snapshots from before tree colours have none of these fields.
    if (entry.color) {
      node.color = entry.color;
    } else {
      if (entry.lastColor) node.lastColor = entry.lastColor;
      if (entry.heir ?? lost) node.heir = entry.heir ?? lost;
    }
    // Nor do those from before tab groups.
    for (const key of GROUP_FIELDS) if (entry[key]) node[key] = entry[key];
    const link = linkNow(links[oldId].firstLink);
    if (link != null) node.firstLink = link;
    else delete node.firstLink;
    const also = [...new Set((links[oldId].alsoLinks ?? []).map(linkNow))].filter((id) => id != null && id !== node.firstLink);
    if (also.length) node.alsoLinks = also;
    else delete node.alsoLinks;
    nodes[newId] = node;
  }
  return nodes;
}

function urlOf(tab) {
  return tab ? tab.url || tab.pendingUrl || '' : '';
}

function sharedUrlCount(a, b) {
  const counts = new Map();
  for (const tab of a) if (tab.url) counts.set(tab.url, (counts.get(tab.url) ?? 0) + 1);
  let shared = 0;
  for (const tab of b) {
    const left = counts.get(tab.url);
    if (left) {
      shared++;
      counts.set(tab.url, left - 1);
    }
  }
  return shared;
}

// Longest common subsequence of the two URL lists, as index pairs. Very large windows
// fall back to pairing equal URLs first come, first served.
const MAX_TABLE = 4_000_000;

function alignByUrl(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_TABLE) return alignGreedy(a, b);

  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[i].url && a[i].url === b[j].url
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].url && a[i].url === b[j].url) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

function alignGreedy(a, b) {
  const waiting = new Map();
  b.forEach((tab, j) => {
    if (!tab.url) return;
    if (!waiting.has(tab.url)) waiting.set(tab.url, []);
    waiting.get(tab.url).push(j);
  });
  const pairs = [];
  a.forEach((tab, i) => {
    const queue = waiting.get(tab.url);
    if (queue?.length) pairs.push([i, queue.shift()]);
  });
  return pairs;
}
