// Service worker: the only writer of the tab tree.
//
// Every tab gets a node { parent, collapsed } as soon as it is created. A tab's parent is
// the page it was opened from by a link (middle/ctrl-click, target=_blank, window.open, "Open
// link in new tab"), as reported by webNavigation.onCreatedNavigationTarget. Chrome's
// openerTabId is not used: Chrome also sets it to the active tab for Ctrl+T, the New Tab
// button and Alt+Enter, which must stay top-level.
//
// The nodes live in chrome.storage.session, which outlives this worker being shut down,
// and the side panel draws from there. A URL-based snapshot in chrome.storage.local
// rebuilds the tree after a browser restart gives every tab a new id; the trees of the
// windows that closed while the browser ran on are kept too, for when they come back (see
// cameBack).
//
// Every tree (a top-level tab with children) has a colour, stored on its top tab. After each
// change that can start or end a tree the colours are settled once more (see scheduleColors
// and treeColors).
//
// The trees are also kept as the browser's own tab groups, as the settings say (see groups.js and
// syncGroups), and what the user does to those groups in the tab strip comes back into the trees.

import {
  buildForest, colorOf, colorsReachOtherWindows, lastOfSubtree, nextAfterClose, placeNear, planBlockMove, rememberColor,
  removeNode, resolveDrop,
  storeColors, subtree, TREE_COLORS, treeColors,
} from './tree.js';
import {
  autoName, groupUnits, isNested, joinTree, leaveTree, oneLine, planGroups, readSettings, storeFirstLinks, storeUnitColors,
  unitColors,
} from './groups.js';
import {
  addClosedWindows, backByUrl, folderPlaceholders, goneWindows, GROUP_FIELDS, matchById, matchByUrl, matchClosedWindow,
  restoreNodes,
} from './restore.js';
import { FOLDER_PAGE, folderUrl, isNewTabPage, newFolderId, parseFolder } from './folders.js';

// The page of a folder tab (see folders.js), without its parameters.
const folderBase = chrome.runtime.getURL(FOLDER_PAGE);

const SNAPSHOT_DELAY_MS = 1000;
// How long the colour pass reads the tabs outside the task queue while they keep changing.
const STALE_COLORS_MS = 3000;
// While windows are closing the browser may be quitting, so the snapshot is left alone for
// a while: it should still hold those windows when the browser starts again.
const WINDOW_CLOSE_HOLD_MS = 5000;
// The group pass waits this long after the change that asks for it, so that a burst of changes makes one pass.
const GROUPS_DELAY_MS = 100;
// After a group pass failed (a tab closed meanwhile, or the user is dragging a tab), the next one waits this long.
const GROUPS_RETRY_MS = 500;
// The group events of a tab are the worker's own doing while its call that moves, groups or ungroups the tab is under
// way (they come before the call returns), and for a moment after it (at worker start-up they can come later); nor are
// those of a tab the browser made this recently the user's (browsers before M150 report the group of a tab made in a
// group just after making it). A tab the browser made in one of the worker's groups up to NEW_TAB_MS ago, which no link
// gave a parent and the worker did not make, joins the group's tree (see joinNewTabs).
const TOUCH_MS = 1000;
const NEW_TAB_EVENTS_MS = 500;
const NEW_TAB_MS = 5000;
// What the worker set on a group comes back as events that are its own, which are matched to it for this long (their
// tasks may wait behind others).
const ECHO_MS = 10000;
// The user's changes to which group a tab is in are taken in once tabs have stopped moving this long and no drag is going
// on: the tabs of an "Ungroup" all change at once, and a drag moves tabs, and changes their groups, as it goes.
const MOVES_SETTLE_MS = 300;
// A rename in the tab strip comes one keystroke at a time, and dragging a group's header collapses the group until
// the drop: the user's changes to a group are taken in once it has stayed as it is this long (a collapse, longer).
const GROUP_SETTLE_MS = 600;
const COLLAPSE_SETTLE_MS = 1000;
// The browser opens a collapsed group by itself when a tab of it becomes the active one or is selected, and when the
// selection moves while it holds the active tab (a tab before it closes or moves away): an expansion that comes this
// close to such a tab event in its window is the browser's, not the user's (see sawGroup).
const BROWSER_EXPAND_MS = 300;
// After the browser starts it may still be linking the groups it restored to its saved tab groups for a while, and can
// undo changes made meanwhile, or move tabs in and out of groups itself: the group pass changes nothing in the browser
// for this long (see syncGroups), and those moves are not taken for the user's.
const STARTUP_GROUPS_MS = 5000;

const nodes = {};
// Link sources reported before the new tab's onCreated was handled: tab id -> source tab id.
const sources = new Map();
// The top tab of each tree that moveToNewWindow took to a window of its own, until attached next
// sees it arrive in a window: tab id -> that window's id.
const ownWindows = new Map();
let ready = null;
let queue = Promise.resolve();

/** Run tasks one at a time, each after the tree has been loaded. */
function run(task) {
  const result = queue.then(() => (ready ??= init())).then(task);
  queue = result.catch((error) => {
    if (!quitting(error)) console.error('[tree-tabs]', error);
  });
  return result;
}

/** Whether `error` is the one the browser gives every call while it quits: nothing to report then. */
const quitting = (error) => /shutting down/i.test(error?.message ?? String(error ?? ''));

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[tree-tabs]', error));

// Load (or rebuild) the tree as soon as the browser starts or the extension is
// installed, updated or reloaded, rather than on the first tab event.
chrome.runtime.onStartup.addListener(() => {
  groupsHoldUntil = Date.now() + STARTUP_GROUPS_MS;
  run(() => {});
});
chrome.runtime.onInstalled.addListener(() => run(() => {}));
chrome.tabs.onCreated.addListener((tab) => {
  noteStrip(tab.windowId);
  born.set(tab.id, Date.now());
  if (!tab.incognito) urls.set(tab.id, tab.pendingUrl || tab.url || ''); // (an incognito tab's address is not kept)
  burstIn(tab);
  run(() => onCreated(tab));
});
chrome.windows.onCreated.addListener((win) => {
  if (!win.incognito) cameBack(win.id, Date.now());
}, { windowTypes: ['normal'] });
chrome.webNavigation.onCreatedNavigationTarget.addListener(({ tabId, sourceTabId }) =>
  run(() => openedFrom(tabId, sourceTabId)));
chrome.tabs.onRemoved.addListener((tabId, info) => {
  noteStrip(info.windowId);
  // The browser may be quitting: hold at once, before the tasks already queued run (see
  // writeTree and saveSnapshot).
  if (info.isWindowClosing) holdUntil = Date.now() + WINDOW_CLOSE_HOLD_MS;
  // As the event comes (the next tab's activation follows it): whether it was the window's active tab, and how many
  // activations the window had (see onRemoved). Its node is kept from init's reconcile, should this event wake the worker.
  const active = activeIn.has(info.windowId) ? activeIn.get(info.windowId) === tabId : null;
  closing.set(tabId, { active, activations: activationCount.get(info.windowId) ?? 0 });
  run(() => onRemoved(tabId, info));
});
chrome.tabs.onReplaced.addListener((addedId, removedId) => run(() => onReplaced(addedId, removedId)));
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  noteActive(windowId, tabId);
  // The worker's own switch (see activateIfHidden) can make the browser open the group of that tab only, and is no step
  // of the user's into a group.
  const own = ownActivation(tabId);
  noteStrip(windowId, own?.groupId);
  if (!own) activations.set(windowId, (activations.get(windowId) ?? 0) + 1);
  run(() => markRead(tabId));
  run(() => reveal(tabId));
  if (!own) run(() => wentInto(tabId));
  scheduleGroups(); // the browser opens a collapsed group when a tab of it becomes the active one (see sawGroup)
});
chrome.tabs.onHighlighted.addListener(({ windowId, tabIds }) => {
  noteStrip(windowId, tabIds?.length === 1 ? ownActivation(tabIds[0])?.groupId : undefined);
});
chrome.tabs.onDetached.addListener((tabId, { oldWindowId }) => noteStrip(oldWindowId));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  // A tab the user put into a group or took out of one (see userMoves): decided as the event arrives, not
  // once its task runs, whether it is the worker's own doing. One that is, the next group pass checks.
  if ('groupId' in change) {
    const mine = inFlight.has(tabId) || recent(touched, tabId, TOUCH_MS) || recent(born, tabId, NEW_TAB_EVENTS_MS)
      || groupsHeld(tab.windowId);
    if (!tab.pinned && !mine) noteMove(tabId);
    else scheduleGroups();
  }
  if ('title' in change && Object.values(owned).includes(tabId)) scheduleGroups(); // its group's automatic name
  if ('pinned' in change) scheduleGroups(); // pinned, a tab leaves its group; unpinned, it goes back to its tree's
  if ('pinned' in change) {
    pinChanged.set(tabId, Date.now()); // the browser moves it for that: no move of the user's (see stripMoves)
    stripMoved.delete(tabId);
  }
  if (change.pinned === false && inFlight.has(tabId)) unpinned.add(tabId); // by the worker's own grouping: see applyGroups
  if ('url' in change && !tab.incognito) urls.set(tabId, change.url);
  if ('url' in change || 'pinned' in change) scheduleSnapshot();
  if ('pinned' in change) {
    tabEvents++;
    scheduleColors(); // a pinned tab heads no tree; its children step up
  }
  // Unpinned, a tab is back in its tree: a collapsed tab there can hide it, or it can hide the active tab.
  if (change.pinned === false) run(() => revealActive(tab.windowId));
});
chrome.tabs.onMoved.addListener((tabId, { windowId }) => {
  noteStrip(windowId);
  scheduleSnapshot();
  if (moves.size) settleMoves(); // the user may be dragging still
  // A move of the user's in the tab strip (not the extension's, nor the browser's for a pin) is followed (the setting
  // stripMoves, read in the task), together with the moves that come with it (see followStripMoves).
  if (!inFlight.has(tabId) && !recent(touched, tabId, TOUCH_MS) && !recent(pinChanged, tabId, 1000)) {
    stripMoved.add(tabId);
    clearTimeout(followTimer);
    followTimer = setTimeout(() => run(() => followStripMoves()), FOLLOW_MOVE_MS);
  }
});
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, transitionType }) => {
  // The settings are read in the task, once init has loaded them: this event may be the one that woke the worker.
  if (frameId === 0 && transitionType === 'auto_bookmark') run(() => fromBookmark(tabId));
});
chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => {
  noteStrip(newWindowId);
  // A tab that changed windows left its group on the way: that says nothing about its tree (see userMoves).
  moves.delete(tabId);
  userMoved.delete(tabId);
  run(() => attached(tabId, newWindowId));
});
// When the event came, for sawGroup: its task may wait behind others.
chrome.tabGroups.onCreated.addListener((group) => {
  const at = Date.now();
  run(() => sawGroup(group, at));
});
chrome.tabGroups.onUpdated.addListener((group) => {
  const at = Date.now();
  run(() => sawGroup(group, at));
});
chrome.tabGroups.onRemoved.addListener((group) => {
  run(() => forgetGroup(group.id));
  scheduleGroups(); // owned groups that are gone are let go of
});
chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.settings) run(() => { settings = readSettings(changes.settings.newValue); scheduleGroups(0); });
});

// The extension's keyboard shortcuts (see "commands" in manifest.json), for the active tab where one was pressed.
chrome.commands.onCommand.addListener((command, tab) => {
  const events = tabEvents; // as for a request: see moveToNewWindow
  run(() => onCommand(command, tab, events));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const events = tabEvents; // tab events from now on are handled after this request (see moveToNewWindow)
  run(() => handle(message, events)).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }),
  );
  return true;
});

async function init() {
  try {
    const [{ tree, groupLooks, activeTabs, closedTabs: closedBefore }, local] = await Promise.all([
      chrome.storage.session.get(['tree', 'groupLooks', 'activeTabs', 'closedTabs']),
      chrome.storage.local.get('settings'),
    ]);
    settings = readSettings(local.settings);
    closedTabs ??= Array.isArray(closedBefore) ? closedBefore : [];
    // Which tab was the active one of each window, as the last worker saw it (the tab that closed and woke this one,
    // say: see onRemoved).
    for (const [windowId, tabId] of Object.entries(activeTabs ?? {})) {
      storedActive.set(Number(windowId), tabId);
      if (!activeIn.has(Number(windowId))) activeIn.set(Number(windowId), tabId);
    }
    let tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!urls.has(tab.id) && !tab.incognito) urls.set(tab.id, tab.url || tab.pendingUrl || '');
      if (tab.active && !activeIn.has(tab.windowId)) activeIn.set(tab.windowId, tab.id);
    }
    if (tree?.nodes) {
      Object.assign(nodes, tree.nodes);
      Object.assign(owned, tree.groups);
      for (const id of tree.adopted ?? []) adopted.add(id);
      for (const [id, look] of Object.entries(groupLooks ?? {})) looks.set(Number(id), look);
    } else {
      // A new browser session, or this extension was just installed, updated or reloaded.
      const { snapshot } = await chrome.storage.local.get('snapshot');
      if (snapshot?.windows?.length) {
        chrome.storage.session.set({ restoring: true }).catch(() => {}); // the panels say so meanwhile
        let mapping = matchById(snapshot, tabs, (url) => !!parseFolder(url, folderBase));
        if (mapping) {
          // The extension reloaded or updated (the tabs kept their ids): its folder tabs come back (see bringBackFolders).
          if (await bringBackFolders(snapshot, tabs, mapping)) tabs = await chrome.tabs.query({});
        } else {
          tabs = await settledTabs(tabs);
          mapping = matchByUrl(snapshot, windowsOf(tabs), folderStandsIn);
          await sendBackFolders(snapshot, windowsOf(tabs), mapping);
        }
        Object.assign(nodes, restoreNodes(snapshot, mapping));
        for (const id of mapping.values()) fromSnapshot.add(id); // see restoreWindow
      }
    }
    reconcile(tabs);
    storeTreeColors(tabs); // trees from before colours, or whose top tab was not restored
    // The snapshot can be older than the last expansion (the extension was reloaded, or the browser quit,
    // less than a second after it), and no activation comes for a tab that is the active one already.
    expandAboveActive(tabs);
    // Every colour is stored now, so no colour pass is left pending, and the request that woke the
    // worker need not read every window to move a tree. A change made meanwhile is handled after
    // that request, which sees its tab event (see moveToNewWindow); one that can change a colour
    // schedules a pass of its own.
    writeTree();
  } catch (error) {
    console.error('[tree-tabs] could not load the tree, starting from the open tabs', error);
    const tabs = await chrome.tabs.query({}).catch(() => []);
    reconcile(tabs);
    storeTreeColors(tabs);
    expandAboveActive(tabs);
    persist(); // this read may have failed too: the colour pass reads the tabs again
  }
  chrome.storage.session.remove('restoring').catch(() => {});
  scheduleSnapshot();
  scheduleGroups();
}

/**
 * When the extension reloads or updates, the browser closes its folder tabs (Chrome) or shows its New Tab page in them
 * (Edge). The snapshot's come back: a closed one made anew where it was (after the nearest tab before it that is still
 * there, or else before the nearest after it), and mapped to its saved id; one showing a New Tab page sent back to its
 * page. `mapping`: saved id -> tab id (the same ids here). Returns whether it made a tab.
 */
async function bringBackFolders(snapshot, tabs, mapping) {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  let made = false;
  for (const win of snapshot.windows) {
    for (const [i, saved] of win.tabs.entries()) {
      if (!parseFolder(saved.url, folderBase)) continue;
      const current = byId.get(mapping.get(saved.id));
      if (current) {
        // (A New Tab page on its way counts: the page it is leaving may be the folder's own still.)
        if (isNewTabPage(current.pendingUrl || current.url)) await chrome.tabs.update(current.id, { url: saved.url }).catch(() => {});
        continue;
      }
      const tabOf = (entry) => byId.get(mapping.get(entry.id));
      const before = win.tabs.slice(0, i).reverse().map(tabOf).find(Boolean);
      const after = before ? null : win.tabs.slice(i + 1).map(tabOf).find(Boolean);
      const near = await chrome.tabs.get((before ?? after)?.id ?? -1).catch(() => null); // where it is now
      if (!near) continue; // its window is gone
      const index = before ? near.index + 1 : near.index;
      const tab = await chrome.tabs.create({ windowId: near.windowId, index, url: saved.url, active: false, pinned: !!saved.pinned })
        .catch(() => null);
      if (!tab) continue;
      touch([tab.id]);
      mapping.set(saved.id, tab.id);
      byId.set(tab.id, tab);
      made = true;
      // It headed a group (`hadGroup`): the browser left that group with the rest of its tabs, and a tab made at a
      // group's edge joins no group. It goes back in, as its first tab, if the tab saved right after it is in a group
      // that still looks as its group did.
      if (!saved.hadGroup) continue;
      const nextSaved = win.tabs.slice(i + 1).map(tabOf).find(Boolean);
      const next = nextSaved ? await chrome.tabs.get(nextSaved.id).catch(() => null) : null;
      if (!next || next.windowId !== tab.windowId || next.groupId == null || next.groupId === -1) continue;
      if (typeof saved.hadGroup === 'object') {
        const group = await chrome.tabGroups.get(next.groupId).catch(() => null);
        if (!group || group.title !== saved.hadGroup.title || group.color !== saved.hadGroup.color) continue;
      }
      await changing([tab.id], () => chrome.tabs.group({ groupId: next.groupId, tabIds: [tab.id] })).catch(() => {});
    }
  }
  return made;
}

/** Whether a tab showing `url` may be a saved folder (`savedUrl`) that the browser brought back as a New Tab page. */
const folderStandsIn = (savedUrl, url) => !!parseFolder(savedUrl, folderBase) && isNewTabPage(url);

/**
 * After a browser restart, or a window back (`windows`: the tabs matched, as windowsOf gives them): saved folder tabs
 * that the browser brought back as New Tab pages go back to their pages, and get their nodes (see folderPlaceholders).
 */
async function sendBackFolders(snapshot, windows, mapping) {
  const isFolder = (url) => !!parseFolder(url, folderBase);
  for (const [savedId, tabId, url] of folderPlaceholders(snapshot, windows, mapping, isFolder, isNewTabPage)) {
    mapping.set(savedId, tabId);
    await chrome.tabs.update(tabId, { url }).catch(() => {});
  }
}

/** At browser start-up tabs may still be coming back: wait until their number holds. */
async function settledTabs(tabs) {
  let stableRounds = 0;
  for (let waited = 0; stableRounds < 2 && waited < 5000; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const next = await chrome.tabs.query({});
    stableRounds = next.length === tabs.length ? stableRounds + 1 : 0;
    tabs = next;
  }
  return tabs;
}

/**
 * A window that just came may be one that was closed, coming back: from History, by Ctrl+Shift+T, or as the browser
 * reopens its last window when it kept running in the background (Edge does, with Startup boost). The browser makes
 * such a window anew, with new tabs: all at once, or the window first and its tabs once it has read its saved session
 * (into a window opened while none was left). Once their number holds (half a second, while the window has two tabs at
 * least; one tab, it is watched for 5 s), they take the tree of the closed window they are (see restoreWindow).
 * Meanwhile no snapshot is saved: it would take the new tabs for the closed window, which would then be lost (see
 * saveSnapshot).
 */
async function cameBack(windowId, since) {
  if (watching.has(windowId)) return;
  watching.add(windowId);
  try {
    let count = -1;
    let stable = 0;
    for (let waited = 250; ; waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const tabs = await chrome.tabs.query({ windowId }).catch(() => null);
      if (!tabs) return; // closed again, or the browser is quitting
      stable = tabs.length === count ? stable + 1 : 0;
      count = tabs.length;
      if (waited >= CAME_BACK_MAX_MS || (stable >= 2 && (count >= 2 || waited >= CAME_BACK_ONE_TAB_MS))) break;
    }
    if (count >= 2) await run(() => restoreWindow(windowId, since)).catch(() => {}); // run() logs it
  } finally {
    watching.delete(windowId);
    scheduleSnapshot(); // the one it held back, if any
  }
}
const watching = new Set(); // the windows cameBack watches

/**
 * A closed window can come back into a window that is open already: "Restore" in the bubble after a crash, or the
 * browser's session read slower than cameBack waits. The browser adds such tabs in one burst: two new tabs within
 * 300 ms, the first at the window's start (it had one tab), and cameBack watches that window as one that just came.
 */
const bursts = new Map(); // window id -> { n, at, first }
function burstIn(tab) {
  if (tab.incognito || watching.has(tab.windowId)) return;
  const now = Date.now();
  const burst = bursts.get(tab.windowId);
  if (burst && now - burst.at < 300) {
    burst.n++;
    burst.at = now;
    if (burst.n === 2) cameBack(tab.windowId, burst.first);
  } else if (tab.index <= 1) bursts.set(tab.windowId, { n: 1, at: now, first: now });
  else bursts.delete(tab.windowId);
  if (bursts.size > 50) for (const [id, entry] of bursts) if (now - entry.at > 1000) bursts.delete(id);
}
// How long cameBack watches a window: with one tab, its other tabs may still come; and its tabs may keep changing.
const CAME_BACK_ONE_TAB_MS = 5000;
const CAME_BACK_MAX_MS = 10000;

/**
 * The tabs of a window that came at `since` take the tree of the closed window they are, by URL (see matchClosedWindow):
 * one the snapshot still has (closed less than its hold ago, or the last window, which it keeps while the browser runs
 * on without windows), or one kept as closed (see saveSnapshot). Only tabs the browser made with the window, as it made
 * them: at the top level, with no tab under them.
 */
async function restoreWindow(windowId, since) {
  const all = await chrome.tabs.query({});
  const tabs = all.filter((tab) => tab.windowId === windowId).sort(byIndex);
  if (tabs.length < 2 || tabs[0].incognito) return;
  const parents = new Set(Object.values(nodes).map((node) => node.parent));
  // Not the tabs that init gave their nodes from the snapshot (at a restart every tab is new): they have theirs.
  const fresh = tabs.filter((tab) => (born.get(tab.id) ?? 0) >= since - 2000 && nodes[tab.id]?.parent == null
    && !parents.has(tab.id) && !fromSnapshot.has(tab.id));
  if (fresh.length < 2) return;
  const { snapshot, closedWindows = [] } = await chrome.storage.local.get(['snapshot', 'closedWindows']);
  const others = windowsOf(all.filter((tab) => tab.windowId !== windowId));
  const open = new Set(all.map((tab) => tab.windowId));
  const kept = closedWindows.filter((win) => !open.has(win.takenBy)); // not one that came back already, still open
  const candidates = [...goneWindows(snapshot?.windows, others), ...kept];
  const freshTabs = fresh.map((tab) => ({ id: tab.id, url: tab.url || tab.pendingUrl || '' }));
  const match = matchClosedWindow(candidates, freshTabs, folderStandsIn);
  if (!match) return;
  const entry = candidates[match.index];
  await sendBackFolders({ windows: [entry] }, [{ tabs: freshTabs }], match.mapping);
  const restored = restoreNodes({ windows: [entry] }, match.mapping);
  if (!Object.values(restored).some((node) => node.parent != null)) return; // no tree among the tabs that matched
  Object.assign(nodes, restored);
  // That window is back. A kept one stays kept, taken by this window, until a snapshot has this window (saveSnapshot
  // lets it go then): should the window close again before that, its tree is kept still.
  // So is a kept copy of a snapshot entry (the last window, kept while the snapshot still has it): the same saved
  // window, every tab id the same (one shared id is not enough: ids start over after a browser restart).
  const ids = new Set(entry.tabs.map((tab) => tab.id));
  const isIt = (win) => win === entry || (win.tabs.length === entry.tabs.length && win.tabs.every((tab) => ids.has(tab.id)));
  if (closedWindows.some((win) => isIt(win) && win.takenBy !== windowId)) {
    closedTaken = true;
    await chrome.storage.local.set({
      closedWindows: closedWindows.map((win) => (isIt(win) ? { ...win, takenBy: windowId } : win)),
    });
  }
  // The browser brings the window's tab groups back too, and may link them to its saved groups for a while: the trees
  // take them back (`hadGroup`) once it is done, as after a restart. Only that window's groups wait.
  windowHolds.set(windowId, Date.now() + STARTUP_GROUPS_MS);
  expandAboveActive(all);
  persist();
  scheduleSnapshot();
}

/**
 * Drop the nodes of tabs that are gone, and make tabs without a node top-level (on a first
 * install the tree starts flat: which tab opened which is not known for older tabs).
 */
function reconcile(tabs) {
  const open = new Set(tabs.map((tab) => tab.id));
  for (const key of Object.keys(nodes)) {
    if (!open.has(Number(key)) && !closing.has(Number(key))) removeNode(nodes, Number(key)); // see onRemoved
  }
  for (const tab of tabs) nodes[tab.id] ??= { parent: null, collapsed: false };
}

function onCreated(tab) {
  if (nodes[tab.id]) return; // already placed by a restore, a duplicate or "new child"
  nodes[tab.id] = { parent: null, collapsed: false };
  // Opened in the background: unread until it becomes the active tab (see markRead and the setting unread).
  // (Not one the browser brings back from its session: it comes with its page's title already.)
  const restoredTab = !!tab.title && tab.title !== (tab.pendingUrl || tab.url);
  if (!tab.active && !tab.pinned && !restoredTab && !parseFolder(tab.pendingUrl || tab.url, folderBase)) nodes[tab.id].unread = true;
  createdAs.set(tab.id, tab.pendingUrl || tab.url || '');
  if (createdAs.size > 200) createdAs.delete(createdAs.keys().next().value);
  const source = sources.get(tab.id);
  sources.delete(tab.id);
  scheduleSnapshot();
  // A new top-level tab changes no tree colour. Settling them anyway would hold up the tab's
  // placement under the page that opened it, which usually comes right after this.
  if (source != null) return openedFrom(tab.id, source);
  if (!tab.pinned) {
    const url = tab.pendingUrl || tab.url || '';
    // A New Tab page (Ctrl+T, the tab strip's +): where the setting newTabPlacement says, by the active tab, which the
    // browser gives as its opener.
    // Not one of a window that is coming back (see cameBack), nor one the browser put into a group or beside a tab
    // itself ("New tab in group", "New tab to the right"): those it opens at the strip's end only, with no opener.
    if (isNewTabPage(url) && settings.newTabPlacement !== 'browser' && !watching.has(tab.windowId) && (tab.groupId ?? -1) === -1) {
      const ref = tab.openerTabId ?? previousActiveTab(tab.windowId, tab.id);
      return placeNewTab(tab, settings.newTabPlacement, ref, { atEndOnly: tab.openerTabId == null });
    }
    // A closed tab reopened (Ctrl+Shift+T, History): back under the tab it was under.
    if (reopened(tab)) return undefined;
  }
  writeTree();
}

/** A page opened this tab by a link; its onCreated may come before or after this. */
async function openedFrom(tabId, sourceTabId) {
  if (sourceTabId == null || sourceTabId === tabId) return;
  const node = nodes[tabId];
  if (!node) {
    sources.set(tabId, sourceTabId);
    return;
  }
  node.parent = sourceTabId;
  // A tab opened from a collapsed tab would be hidden; show it instead.
  if (nodes[sourceTabId]?.collapsed) nodes[sourceTabId].collapsed = false;
  persist();
  scheduleSnapshot();
  // First or last among its page's tabs, as the setting linkPlacement says (the browser puts it right after the page,
  // or after the tabs opened from it before).
  if (settings.linkPlacement !== 'browser') await placeLink(tabId, sourceTabId);
  // Opened in the foreground, it may have been activated before its parent was known: a collapsed tab
  // above the page that opened it (or above a pinned page's place in the tree) can hide it.
  return reveal(tabId);
}

async function onRemoved(tabId, info) {
  try {
    await closed(tabId, info, closing.get(tabId) ?? { active: null, activations: activationCount.get(info.windowId) ?? 0 });
  } finally {
    closing.delete(tabId);
  }
}

/** Tab `tabId` closed; `event`: as its event came (see the onRemoved listener). */
async function closed(tabId, { isWindowClosing, windowId }, event) {
  sources.delete(tabId);
  // Its URL, from its events, or (the worker was asleep) the snapshot.
  const closedUrl = urls.get(tabId) ?? (isWindowClosing ? null : (await chrome.storage.local.get('snapshot')).snapshot?.windows
    ?.flatMap((w) => w.tabs).find((t) => t.id === tabId)?.url);
  urls.delete(tabId);
  // The settings closeParent and afterClose ask about its window as it is now, before its node goes.
  let promote = null;
  let next = null;
  if (!isWindowClosing && nodes[tabId] && (settings.closeParent === 'promote' || settings.afterClose === 'tree')) {
    const tabs = (await chrome.tabs.query({ windowId }).catch(() => [])).filter((t) => !t.pinned).sort(byIndex);
    if (settings.closeParent === 'promote') promote = tabs.find((t) => nodes[t.id]?.parent === tabId)?.id ?? null;
    // It was the active tab: so the event said, or (the event woke the worker) the last worker had it.
    if (settings.afterClose === 'tree' && (event.active ?? storedActive.get(windowId) === tabId)) {
      const before = await orderBefore(windowId, tabId, tabs);
      // A pinned tab is in no tree: the browser's pick stands.
      if (!before.pinned) next = nextAfterClose(before.order, tabId, nodes, new Set(tabs.map((t) => t.id)));
    }
  }
  if (!isWindowClosing && nodes[tabId]) keepClosed(tabId, windowId, closedUrl);
  removeNode(nodes, tabId, promote);
  persist();
  if (isWindowClosing) holdSnapshot();
  else scheduleSnapshot();
  // The tab the tree gives, unless the user made another tab the active one since the browser's own pick.
  if (next != null && (activationCount.get(windowId) ?? 0) - event.activations <= 1) {
    // The worker's own switch (see ownActivation).
    const now = Date.now();
    ownActivations.set(next, { groupId: (await chrome.tabs.get(next).catch(() => null))?.groupId ?? -1, at: now });
    await chrome.tabs.update(next, { active: true }).catch(() => {});
  }
  // A first child that took a closed tab's place, with the others under it: the active tab shows still.
  if (promote != null) await revealActive(windowId);
}

// ---- where new tabs go, and the tabs that close (the settings) ---------------------------------

const urls = new Map(); // tab id -> its URL, as its events tell (for the tabs that close: see keepClosed)
const activeIn = new Map(); // window id -> its active tab
const previousActive = new Map(); // window id -> { tabId, at }: the tab that was the active one before, and until when
const closing = new Map(); // tab id -> { active, activations } as its onRemoved event came (see onRemoved)
const storedActive = new Map(); // window id -> its active tab, as the last worker kept it (see init)
const activationCount = new Map(); // window id -> how many times its active tab changed (see onRemoved)
const stripMoved = new Set(); // tabs the user moved in the tab strip, to follow (see followStripMoves)
let followTimer = null;
const pinChanged = new Map(); // tab id -> when it was pinned or unpinned (the browser moves it for that)
const createdAs = new Map(); // tab id -> the URL it was made with (a New Tab page that a bookmark fills is no new tab)
const bookmarkBursts = new Map(); // window id -> { at, ref, placed, activated } (see fromBookmark)
const FOLLOW_MOVE_MS = 400;
// A tab that closes is kept this long (and the last CLOSED_KEPT of them), for when it is reopened (see reopened).
const CLOSED_KEPT_MS = 30 * 60 * 1000;
const CLOSED_KEPT = 30;
let closedTabs = null; // [{ url, parent, collapsed, windowId, at }], the newest first; read from storage.session first

/** A tab that became the active one has been looked at: no longer unread. */
function markRead(tabId) {
  if (!nodes[tabId]?.unread) return;
  delete nodes[tabId].unread;
  persist();
  scheduleSnapshot();
}

/** Tab `tabId` became the active tab of window `windowId`: which was before it, and when that changed. */
function noteActive(windowId, tabId) {
  const was = activeIn.get(windowId);
  if (was === tabId) return;
  previousActive.set(windowId, { tabId: was, at: Date.now() });
  activeIn.set(windowId, tabId);
  activationCount.set(windowId, (activationCount.get(windowId) ?? 0) + 1);
  // Kept for the next worker, once this one has read what the last one kept (see init).
  run(() => chrome.storage.session.set({ activeTabs: Object.fromEntries(activeIn) }).catch(() => {}));
}


/** The tab that was the active one of window `windowId` before tab `newId` (which may be it now), or null. */
function previousActiveTab(windowId, newId) {
  const now = activeIn.get(windowId);
  return now != null && now !== newId ? now : previousActive.get(windowId)?.tabId ?? null;
}

/**
 * The window's tab ids in strip order with `closed` back where it was: the tabs open now (`tabs`, in order), it after
 * the last of them that came before it in the last snapshot; and whether it was pinned then.
 */
async function orderBefore(windowId, closed, tabs) {
  const saved = lastSaved ?? (await chrome.storage.local.get('snapshot')).snapshot?.windows ?? [];
  const win = saved.find((w) => w.tabs.some((t) => t.id === closed));
  const live = tabs.map((t) => t.id);
  if (!win) return { order: live, pinned: false };
  const at = win.tabs.findIndex((t) => t.id === closed);
  const before = win.tabs.slice(0, at).map((t) => t.id).reverse().find((id) => live.includes(id));
  const index = before == null ? 0 : live.indexOf(before) + 1;
  return { order: [...live.slice(0, index), closed, ...live.slice(index)], pinned: !!win.tabs[at].pinned };
}

/** A new tab `tab` goes where `where` says by tab `refId` (see placeNear), and is moved there. */
async function placeNewTab(tab, where, refId, { atEndOnly = false } = {}) {
  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  const ref = tabs.find((t) => t.id === refId && !t.pinned);
  const self = tabs.find((t) => t.id === tab.id);
  const atEnd = !!self && self.index === Math.max(...tabs.map((t) => t.index));
  const place = ref && self && (!atEndOnly || atEnd) ? placeNear(buildForest(tabs, nodes), ref.id, where, new Set([tab.id])) : null;
  if (!place || !nodes[tab.id]) {
    writeTree();
    return;
  }
  nodes[tab.id].parent = place.parent;
  // Under a collapsed tab it would be hidden: shown instead, as a link's tab is (see openedFrom).
  if (place.parent != null && nodes[place.parent]?.collapsed) nodes[place.parent].collapsed = false;
  persist();
  scheduleSnapshot();
  await arrange(tab.windowId, [tab.id], { after: place.after });
}

/** A tab opened from a link goes first or last among the tabs of its page (the setting linkPlacement). */
async function placeLink(tabId, sourceTabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.pinned) return;
  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  const source = tabs.find((t) => t.id === sourceTabId);
  if (!source || source.pinned) return;
  const after = settings.linkPlacement === 'first' ? sourceTabId : lastOfSubtree(buildForest(tabs, nodes), sourceTabId, new Set([tabId]));
  await arrange(tab.windowId, [tabId], { after });
}

/** A tab opened from a bookmark (a new tab only): where the setting bookmarkPlacement says, and made active if asked. */
async function fromBookmark(tabId) {
  if (settings.bookmarkPlacement === 'browser' && settings.bookmarkActive === 'no') return;
  // A new tab only: not a New Tab page that a bookmark then filled.
  if (!recent(born, tabId, 10000) || nodes[tabId]?.parent != null || isNewTabPage(createdAs.get(tabId))) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.pinned) return;
  // The tabs of one "Open all" come within moments of each other: one burst, placed by the tab that was the active one
  // as it began, each after the one made before it (tab ids grow as tabs are made), whatever order their pages load in.
  const now = Date.now();
  let burst = bookmarkBursts.get(tab.windowId);
  if (!burst || now - burst.at > 1500) {
    burst = { at: now, ref: previousActiveTab(tab.windowId, tab.id), placed: [], activated: false };
    bookmarkBursts.set(tab.windowId, burst);
  }
  burst.at = now;
  if (settings.bookmarkPlacement !== 'browser') {
    const prior = burst.placed.filter((id) => id < tabId && nodes[id]).sort((a, b) => b - a)[0];
    await placeNewTab(tab, prior != null ? 'sibling' : settings.bookmarkPlacement, prior ?? burst.ref);
    burst.placed.push(tabId);
  }
  if (settings.bookmarkActive === 'yes' && !tab.active && !burst.activated) {
    burst.activated = true;
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  }
}

/** Keep a tab that closes for a while, by its URL, for when it is reopened (see reopened). */
function keepClosed(tabId, windowId, url) {
  const node = nodes[tabId];
  if (!url || !node || isNewTabPage(url)) return;
  closedTabs = [{ url, parent: node.parent ?? null, collapsed: !!node.collapsed, windowId, at: Date.now() },
    ...(closedTabs ?? [])].slice(0, CLOSED_KEPT);
  chrome.storage.session.set({ closedTabs }).catch(() => {});
}

/**
 * A new tab that is a closed one reopened: the browser brings it back with its page's title and URL at once (a new
 * tab gets its title later). It goes back under the tab it was under, if that is still in its window, and is collapsed
 * again if it was. Returns whether it was one.
 */
function reopened(tab) {
  const url = tab.pendingUrl || tab.url;
  if (!url || !tab.title || tab.title === url || !closedTabs?.length) return false;
  const now = Date.now();
  const i = closedTabs.findIndex((entry) => entry.url === url && entry.windowId === tab.windowId && now - entry.at < CLOSED_KEPT_MS);
  if (i < 0) return false;
  const [entry] = closedTabs.splice(i, 1);
  chrome.storage.session.set({ closedTabs }).catch(() => {});
  if (entry.parent == null || !nodes[entry.parent]) return false;
  nodes[tab.id].parent = entry.parent;
  nodes[tab.id].collapsed = entry.collapsed;
  persist();
  return true;
}

/**
 * The tabs the user moved in the tab strip (the setting stripMoves 'follow'): each run of them next to each other moves
 * as one block, its links inside kept; the block's top tabs take the place of the first tab after the block that is not
 * one of their own, and their tabs left behind stay where they were (see leaveTree). Not a run dropped back where it
 * was, nor a tab group dragged by its header, nor a tab whose group changed with the move (userMoves places it).
 */
async function followStripMoves() {
  const moved = [...stripMoved];
  stripMoved.clear();
  if (settings.stripMoves !== 'follow' || !moved.length) return;
  const tabs = await chrome.tabs.query({});
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const ids = moved.filter((id) => byId.has(id) && !byId.get(id).pinned && nodes[id] && !moves.has(id) && !userMoved.has(id));
  const saved = lastSaved ?? [];
  let changed = false;
  for (const windowId of new Set(ids.map((id) => byId.get(id).windowId))) {
    const here = tabs.filter((t) => t.windowId === windowId);
    const order = here.filter((t) => !t.pinned).sort(byIndex).map((t) => t.id);
    const movedHere = new Set(ids.filter((id) => byId.get(id).windowId === windowId));
    const groupIds = new Set([...movedHere].map((id) => byId.get(id).groupId));
    if (groupIds.size === 1 && !groupIds.has(-1)) {
      const [group] = groupIds;
      if (here.filter((t) => t.groupId === group).every((t) => movedHere.has(t.id))) continue; // the group dragged whole
    }
    const runs = [];
    let current = null;
    for (const id of order) {
      if (!movedHere.has(id)) current = null;
      else if (current) current.push(id);
      else runs.push((current = [id]));
    }
    const savedOrder = saved.find((w) => w.tabs.some((t) => movedHere.has(t.id)))?.tabs.map((t) => t.id)
      .filter((id) => order.includes(id) || movedHere.has(id)) ?? null;
    for (const block of runs) {
      const inBlock = new Set(block);
      const near = (list) => {
        const first = list.indexOf(block[0]);
        const last = list.indexOf(block.at(-1));
        return [list.slice(0, first).reverse().find((id) => !inBlock.has(id)), list.slice(last + 1).find((id) => !inBlock.has(id))];
      };
      if (savedOrder?.includes(block[0])) {
        const [before, after] = near(order);
        const [savedBefore, savedAfter] = near(savedOrder);
        if (before === savedBefore && after === savedAfter) continue; // dropped back where it was
      }
      const forest = buildForest(here, nodes);
      for (const top of block.filter((id) => !inBlock.has(forest.parentOf.get(id)))) {
        const own = new Set(subtree(forest, top));
        const next = order.slice(order.indexOf(block.at(-1)) + 1).find((id) => !own.has(id));
        leaveTree(nodes, top, inBlock);
        nodes[top].parent = next != null ? buildForest(here, nodes).parentOf.get(next) ?? null : null;
        changed = true;
      }
    }
  }
  if (changed) {
    persist();
    scheduleSnapshot();
  }
}

/** A new tab placed by `where` (see placeNear) by tab `refId`, or the window's active tab; at the end with 'end'. */
async function newTabAt(windowId, where, refId = null) {
  const tabs = await chrome.tabs.query({ windowId });
  const ref = tabs.find((t) => (refId == null ? t.active : t.id === refId) && !t.pinned);
  const place = where === 'end' || !ref ? null : placeNear(buildForest(tabs, nodes), ref.id, where);
  const index = place ? tabs.find((t) => t.id === place.after).index + 1 : undefined;
  const tab = await chrome.tabs.create({ windowId, active: true, ...(index == null ? {} : { index }) });
  touch([tab.id]);
  nodes[tab.id] = { parent: place?.parent ?? null, collapsed: false };
  persist();
  scheduleSnapshot(); // its onCreated finds the node made already
  return tab.id;
}

/**
 * A tab was dragged to another window: there its tree claims its colour afresh. In the window that
 * moveToNewWindow made for its tree no other tree has it, so the tree keeps it, and so does a tree
 * elsewhere that takes its colour from that tab (see inheritedColor). Collapsed, the tab can hide the
 * active tab there (one of its tree that went there before it, say), and no activation reveals that.
 * The tree then stays expanded, as after any reveal, even if the tab itself becomes the active tab a
 * moment later, which the collapsed tree would not have hidden.
 */
async function attached(tabId, windowId) {
  if (ownWindows.get(tabId) !== windowId) rememberColor(nodes[tabId]);
  ownWindows.delete(tabId);
  persist(); // also settles the colours of the window it left
  scheduleSnapshot();
  if (nodes[tabId]?.collapsed) await revealActive(windowId);
}

function onReplaced(addedId, removedId) {
  nodes[addedId] = nodes[removedId] ?? nodes[addedId] ?? { parent: null, collapsed: false };
  delete nodes[removedId];
  for (const key in nodes) {
    if (nodes[key].parent === removedId) nodes[key].parent = addedId;
    if (nodes[key].firstLink === removedId) nodes[key].firstLink = addedId;
    const also = nodes[key].alsoLinks;
    if (also?.includes(removedId)) nodes[key].alsoLinks = also.map((link) => (link === removedId ? addedId : link));
  }
  for (const id in owned) {
    if (owned[id] === removedId) owned[id] = addedId;
  }
  persist();
  scheduleSnapshot();
}

/**
 * A tab was activated, or placed under the page that opened it: if it is the active tab, expand the
 * collapsed tabs that hide it in its window's tree, as the panel draws it (see revealActive), so that
 * the active tab is always visible. When the active top tab of a collapsed tree leaves its window
 * ("Move tree to new window", or a drop on another window's panel), the browser can make a tab of the
 * tree active there until that one follows. Once the top tab has left, nothing there hides that tab,
 * so the tree arrives collapsed all the same.
 */
async function reveal(tabId) {
  // Only a collapsed recorded ancestor can hide the tab (see buildForest): without one, nothing to ask.
  const seen = new Set();
  let collapsedAbove = false;
  for (let id = nodes[tabId]?.parent; id != null && !collapsedAbove && !seen.has(id); id = nodes[id]?.parent) {
    seen.add(id);
    collapsedAbove = !!nodes[id]?.collapsed;
  }
  const tab = collapsedAbove ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (tab?.active) await revealActive(tab.windowId);
}

/**
 * Expand the collapsed tabs above the active tab of a window in its tree: those hide it. A recorded
 * ancestor that is pinned or in another window hides nothing, and nothing hides a pinned tab (see
 * buildForest).
 */
async function revealActive(windowId) {
  if (expandAboveActive(await chrome.tabs.query({ windowId }).catch(() => []))) {
    writeTree(); // collapsing changes no tree colour
    scheduleSnapshot();
  }
}

/** What revealActive does, for every window of `tabs` (read already): true if it expanded a tab. */
function expandAboveActive(tabs) {
  let changed = false;
  for (const list of tabsByWindow(tabs)) {
    const forest = buildForest(list, nodes);
    for (let id = forest.parentOf.get(list.find((tab) => tab.active)?.id); id != null; id = forest.parentOf.get(id)) {
      if (nodes[id]?.collapsed) {
        nodes[id].collapsed = false;
        changed = true;
      }
    }
  }
  return changed;
}

// ---- requests from the side panel ------------------------------------------------------

async function handle(message, events) {
  switch (message.type) {
    case 'ping': return null;
    case 'setCollapsed': return setCollapsed(message.tabId, message.collapsed);
    case 'setAllCollapsed': return setAllCollapsed(message.windowId, message.collapsed);
    case 'move': return message.alone
      ? moveAlone(message.tabId, message.windowId, message.targetId ?? null, message.position)
      : moveTree(message.tabId, message.windowId, message.targetId ?? null, message.position);
    case 'moveTabs': return moveTabs(message.tabIds ?? [], message.windowId, message.targetId ?? null, message.position);
    case 'moveTabsToNewWindow': return moveTabsToNewWindow(message.tabIds ?? [], events);
    case 'makeTopLevel': return makeTopLevel(message.tabId);
    case 'closeTree': return closeTree(message.tabId, true);
    case 'closeChildren': return closeTree(message.tabId, false);
    case 'newChild': return newChild(message.tabId);
    case 'duplicate': return duplicate(message.tabId);
    case 'moveToNewWindow': return moveToNewWindow(message.tabId, events);
    case 'setTreeColor': return setTreeColor(message.tabId, message.color);
    case 'setGroupName': return setGroupName(message.tabId, message.name);
    case 'setGroupColor': return setGroupColor(message.tabId, message.color);
    case 'setNoGroup': return setNoGroup(message.tabId, message.noGroup);
    case 'openSwitcher': return openSwitcher(message.windowId);
    case 'closeTabs': return closeTabs(message.tabIds ?? []);
    case 'command': return onCommand(message.command, await chrome.tabs.get(message.tabId), events);
    case 'newFolder': return newFolder(message);
    case 'moveToNewFolder': return moveToNewFolder(message.tabIds ?? []);
    case 'moveToFolder': return moveToFolder(message.tabIds ?? [], message.folderId);
    case 'renameFolder': return updateFolder(message.tabId, { name: message.name });
    case 'setFolderIcon': return updateFolder(message.tabId, { icon: message.icon });
    case 'newTabIn': return newTabIn(message.tabId, !!message.first);
    case 'newTabAt': return newTabAt(message.windowId, message.where ?? 'end', message.tabId ?? null);
    case 'moveGroupToNewWindow': return moveGroupToNewWindow(message.groupId);
    default: throw new Error(`unknown message: ${message.type}`);
  }
}

// ---- keyboard shortcuts and the quick switcher -------------------------------------------

/**
 * One of the extension's keyboard shortcuts (see "commands" in manifest.json; the user sets the keys at
 * chrome://extensions/shortcuts), for `tab`, the active tab of the window where it was pressed. `events`: as for
 * moveToNewWindow.
 */
async function onCommand(command, tab, events) {
  tab ??= (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (command === 'find-tab') return openSwitcher(tab?.windowId);
  if (!tab) return;
  if (command === 'collapse-all' || command === 'expand-all') return setAllCollapsed(tab.windowId, command === 'collapse-all');
  if (tab.pinned || !nodes[tab.id]) return; // a pinned tab is in no tree
  switch (command) {
    case 'toggle-tree': {
      // The tree the tab is in, by its top tab.
      const forest = await forestOf(tab.windowId);
      let top = tab.id;
      while (forest.parentOf.get(top) != null) top = forest.parentOf.get(top);
      if (forest.children.has(top)) await setCollapsed(top, !nodes[top]?.collapsed);
      return;
    }
    case 'new-child': return newChild(tab.id);
    case 'top-level': return makeTopLevel(tab.id);
    case 'new-window': return moveToNewWindow(tab.id, events);
    case 'close-tree': return closeTree(tab.id, true);
    case 'new-sibling': return newTabAt(tab.windowId, 'sibling', tab.id);
    case 'duplicate': return duplicate(tab.id);
    case 'new-folder': {
      // The tabs selected in the tab strip, if the tab is one of them; else the tab.
      const selected = (await chrome.tabs.query({ windowId: tab.windowId, highlighted: true })).map((t) => t.id);
      return moveToNewFolder(selected.includes(tab.id) ? selected : [tab.id]);
    }
    default: return undefined;
  }
}

/**
 * The quick switcher (switcher.html), to find a tab in any window by its title, address or tab group: a small window
 * over window `windowId`, whose tabs it lists first. One at a time: asked for again, the open one comes forward.
 */
async function openSwitcher(windowId) {
  const url = chrome.runtime.getURL('switcher.html');
  const open = (await chrome.tabs.query({})).find((tab) => (tab.url || tab.pendingUrl || '').startsWith(url));
  if (open) {
    await chrome.windows.update(open.windowId, { focused: true });
    return;
  }
  const host = windowId == null ? null : await chrome.windows.get(windowId).catch(() => null);
  const width = 560;
  const height = 520;
  const place = host?.width ? {
    left: Math.round(host.left + (host.width - width) / 2),
    top: Math.round(host.top + Math.max(48, (host.height - height) / 3)),
  } : {};
  await chrome.windows.create({ url: `${url}?windowId=${host?.id ?? ''}`, type: 'popup', width, height, focused: true, ...place });
}

const byIndex = (a, b) => a.index - b.index;

function nodeOf(tabId) {
  return (nodes[tabId] ??= { parent: null, collapsed: false });
}

async function forestOf(windowId) {
  return buildForest(await chrome.tabs.query({ windowId }), nodes);
}

async function setCollapsed(tabId, collapsed) {
  supersede([tabId], 'collapsed');
  nodeOf(tabId).collapsed = !!collapsed;
  writeTree();
  scheduleSnapshot();
  if (!collapsed) return;
  const { windowId } = await chrome.tabs.get(tabId);
  // A strip expansion still settling of a group below would expand this tab again (see takeUserChanges): the newer step
  // wins. ('innermost' groups: in 'trees' a group's head is its tree's top, which supersede covers.)
  const below = new Set(subtree(await forestOf(windowId), tabId));
  for (const [id, head] of Object.entries(owned)) {
    const entry = userChanges.get(Number(id));
    if (head === tabId || !below.has(head) || entry?.values.collapsed !== false) continue;
    delete entry.values.collapsed;
    if (!Object.keys(entry.values).length) {
      clearTimeout(entry.timer);
      userChanges.delete(Number(id));
    }
  }
  await activateIfHidden(windowId, [tabId]);
}

async function setAllCollapsed(windowId, collapsed) {
  const forest = await forestOf(windowId);
  // "Expand all" expands every tab of the window, pinned ones and those without children included: their rows show no
  // sign of being collapsed (the children closed, left or were pinned meanwhile, or the tab itself was), but they would
  // hide the tabs that come under them later. A tab without a node is left alone: its onCreated, still to come, would
  // take it as placed already.
  const ids = [...(collapsed ? forest.children.keys() : [...forest.order, ...forest.pinned].filter((id) => nodes[id]))];
  supersede(ids, 'collapsed');
  for (const id of ids) nodeOf(id).collapsed = !!collapsed;
  writeTree();
  scheduleSnapshot();
  if (collapsed) await activateIfHidden(windowId, ids);
}

/**
 * If the active tab now sits inside a tree that was just collapsed (the tabs `ids`), activate the tab that hides it: the
 * active tab is always visible. A tree that hid it already is no reason to switch tabs. Nor is one whose collapse no
 * longer is `current()` (a newer step made that tab the active one): that tree shows it again instead. The switch is
 * the worker's own (see ownActivation).
 */
async function activateIfHidden(windowId, ids, current = () => true) {
  const tabs = await chrome.tabs.query({ windowId });
  const active = tabs.find((tab) => tab.active);
  if (!active || active.pinned) return;
  const forest = buildForest(tabs, nodes);
  let visible = active.id;
  let collapsedNow = false;
  for (let id = forest.parentOf.get(active.id); id != null; id = forest.parentOf.get(id)) {
    if (!nodes[id]?.collapsed) continue;
    visible = id;
    if (ids.includes(id)) collapsedNow = true;
  }
  if (!collapsedNow) return;
  if (!current()) {
    // A newer step made another tab the active one, and its reveal may have run before this collapse: shown now.
    if (expandAboveActive(tabs)) {
      writeTree();
      scheduleSnapshot();
    }
    return;
  }
  const now = Date.now();
  for (const [id, own] of ownActivations) if (now - own.at >= OWN_ACTIVATION_MS) ownActivations.delete(id);
  ownActivations.set(visible, { groupId: tabs.find((t) => t.id === visible)?.groupId ?? -1, at: now });
  await chrome.tabs.update(visible, { active: true });
}

/**
 * Move a tab together with its subtree to `position` relative to `targetId` (see
 * resolveDrop), possibly from another window. The tree changes first, then the native
 * tabs are reordered to match it.
 */
async function moveTree(tabId, windowId, targetId, position) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.pinned) return false;
  const across = tab.windowId !== windowId;
  // The browser does not move tabs between a normal and an incognito window.
  if (across && (await chrome.windows.get(windowId).catch(() => null))?.incognito !== tab.incognito) return false;
  const tabs = await chrome.tabs.query({});
  const forestIn = (id) => buildForest(tabs.filter((t) => t.windowId === id), nodes);
  const sourceForest = forestIn(tab.windowId);
  const block = subtree(sourceForest, tabId);
  const targetForest = across ? forestIn(windowId) : sourceForest;
  const drop = resolveDrop(targetForest, block, targetId, position);
  if (!drop) return false;
  drop.placement = besideUserGroups(tabs.filter((t) => t.windowId === windowId), block, drop);
  // Colours the panels draw that no pass has stored yet (the tabs kept changing): store them first,
  // so that the tree keeps the colour it is drawn in.
  storeTreeColors(tabs);

  const node = nodeOf(tabId);
  const before = across ? structuredClone(nodes) : null; // to put back should the move fail
  node.parent = drop.parent;
  // Tabs dropped into a collapsed tree are hidden in it, but the active tab of every window is always kept visible:
  // the collapsed tabs that would hide it once the tabs are in place expand, as in revealActive. That tab can be one
  // of the moved tabs, or a tab in another window whose recorded parents run through them (opened from them, there
  // or before it moved there), whose place the move changes too. A moved tab is not the active tab of a window it
  // is new to. The tab they are dropped on expands too if it is collapsed with no children: its row shows no sign
  // of being collapsed (its children closed, left or were pinned while it was).
  const after = afterMove(tabs, block, windowId, drop.placement);
  expandAboveActive(across ? after.map((t) => (block.includes(t.id) ? { ...t, active: false } : t)) : after);
  if (nodes[drop.parent]?.collapsed && !targetForest.children.has(drop.parent)) nodes[drop.parent].collapsed = false;
  // In another window the tree claims its colour afresh: it keeps it unless a tree there has
  // it (with eight trees there already, it may share one).
  if (across) rememberColor(node);
  // Settle the colours for where the tabs are going, so the panel draws them right away.
  storeTreeColors(after);
  persist();
  scheduleSnapshot(); // the drop may move no tab
  touch(block); // the browser takes them out of their group, or puts them in another, on the way
  if (across) {
    // The panel there gets the colours before the tabs, and the tabs go straight to their place:
    // until the worker has seen them arrive, it draws them as a tree that claims its colour
    // where they are (see `arriving` in sidepanel.js). The panel here leaves them out meanwhile,
    // rather than draw them as they will be over there.
    leaving = { tabs: block, windowId };
    try {
      await chrome.storage.session.set({ tree: treeValue() });
      await changing(block, () => chrome.tabs.move(block, { windowId, index: after.find((t) => t.id === tabId).index }).catch((error) => {
        // Tabs from another window cannot go into the middle of a tab group: to the end, then into place (arrange).
        if (!/group/i.test(error?.message ?? '')) throw error;
        return chrome.tabs.move(block, { windowId, index: -1 });
      }));
    } catch (error) {
      if ((await chrome.tabs.get(tabId).catch(() => null))?.windowId !== windowId) {
        // A window closed meanwhile, say: the tree stayed where it was, and so do the colours.
        for (const id of Object.keys(nodes)) delete nodes[id];
        Object.assign(nodes, before);
        persist();
        throw error;
      }
      await bringRest(block, windowId); // a tab of the tree closed on the way
    } finally {
      leaving = null;
      writeTree();
    }
  }
  await arrange(windowId, block, drop.placement);
  return true;
}

/**
 * With groups on and the user's own groups left alone: a drop that would put the tabs between two tabs of a group of the
 * user's (the browser would add them to it) puts them just before or after that group instead, whichever is nearer,
 * unless they go under a tab of that group (then they join it, as tabs opened from it would). `tabs`: the target
 * window's tabs. Returns the placement to use (see resolveDrop).
 */
function besideUserGroups(tabs, block, drop) {
  const { placement } = drop;
  if (settings.groups === 'off' || settings.ownGroups !== 'leave' || placement.end) return placement;
  const order = tabs.filter((t) => !t.pinned && !block.includes(t.id)).sort(byIndex);
  const at = placement.before != null
    ? order.findIndex((t) => t.id === placement.before)
    : order.findIndex((t) => t.id === placement.after) + 1;
  if (at <= 0 || at >= order.length) return placement;
  const group = order[at].groupId;
  if (group === -1 || order[at - 1].groupId !== group || owned[group] != null) return placement;
  if (tabs.find((t) => t.id === drop.parent)?.groupId === group) return placement;
  const first = order.findIndex((t) => t.groupId === group);
  const last = order.findLastIndex((t) => t.groupId === group);
  return at - first <= last + 1 - at ? { before: order[first].id } : { after: order[last].id };
}

/** A tab of `block` closed while the tabs were moving to `windowId`: the tabs after it follow the others. */
async function bringRest(block, windowId) {
  if (!(await chrome.windows.get(windowId).catch(() => null))) return; // that window closed too
  const behind = (await chrome.tabs.query({})).filter((t) => block.includes(t.id) && t.windowId !== windowId);
  const ids = behind.map((t) => t.id);
  if (ids.length) await changing(ids, () => chrome.tabs.move(ids, { windowId, index: -1 })).catch(() => {});
}

/** All the tabs as they will be once moveTree has moved `block` to `placement` in `windowId`. */
function afterMove(tabs, block, windowId, placement) {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const order = tabs.filter((tab) => tab.windowId === windowId).sort(byIndex).map((tab) => tab.id);
  if (byId.get(block[0]).windowId !== windowId) order.push(...block); // from another window: as if added at the end
  for (const { tabId, index } of planBlockMove(order, block, placement)) {
    order.splice(order.indexOf(tabId), 1);
    order.splice(index, 0, tabId);
  }
  const placed = new Set(order);
  const others = tabs.filter((tab) => !placed.has(tab.id));
  return [...others, ...order.map((id, index) => ({ ...byId.get(id), windowId, index }))];
}

async function arrange(windowId, block, placement) {
  const order = (await chrome.tabs.query({ windowId })).sort(byIndex).map((tab) => tab.id);
  for (const { tabId, index } of planBlockMove(order, block, placement)) {
    await changing([tabId], () => chrome.tabs.move(tabId, { index }));
  }
}

async function makeTopLevel(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const forest = await forestOf(tab.windowId);
  let root = tabId;
  while (forest.parentOf.get(root) != null) root = forest.parentOf.get(root);
  if (root === tabId) return false;
  return moveTree(tabId, tab.windowId, root, 'afterTree');
}

async function closeTree(tabId, includeSelf) {
  const tab = await chrome.tabs.get(tabId);
  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  const ids = subtree(buildForest(tabs, nodes), tabId);
  if (!includeSelf) ids.shift();
  return closeTabs(ids, tabs);
}

/**
 * Close the tabs `ids`, of one window (those that are still there); `tabs`: that window's tabs, if read already. (The
 * panel's "Close group" too: the tabs of the group of a unit.)
 */
async function closeTabs(ids, tabs = null) {
  if (!tabs) {
    const open = (await chrome.tabs.query({})).filter((t) => ids.includes(t.id));
    const first = ids.map((id) => open.find((t) => t.id === id)).find(Boolean);
    if (!first) return;
    tabs = await chrome.tabs.query({ windowId: first.windowId });
  }
  const here = new Set(tabs.map((t) => t.id));
  ids = ids.filter((id) => here.has(id));
  if (!ids.length) return;
  // Closing every tab of a window closes it, and the browser keeps the tab groups of a closing window in its list of
  // saved groups. Ungrouped first, a group the worker made goes with its tabs, as when a tree ends in a window that
  // stays open. (The user's own groups are theirs to keep.)
  if (tabs.every((t) => ids.includes(t.id))) {
    const mine = tabs.filter((t) => owned[t.groupId] != null && !adopted.has(t.groupId)).map((t) => t.id);
    if (mine.length) await changing(mine, () => chrome.tabs.ungroup(mine)).catch(() => {});
  }
  await chrome.tabs.remove(ids);
}

async function newChild(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  const last = lastOfSubtree(buildForest(tabs, nodes), tabId);
  const index = tabs.find((t) => t.id === last).index + 1;
  const child = await chrome.tabs.create({ windowId: tab.windowId, openerTabId: tabId, index, active: true });
  touch([child.id]);
  nodes[child.id] = { parent: tabId, collapsed: false };
  persist();
  scheduleSnapshot(); // its onCreated finds the node made already
}

/** Duplicates become siblings, placed after the original's subtree. */
async function duplicate(tabId) {
  const copy = await chrome.tabs.duplicate(tabId);
  if (!copy) return;
  touch([copy.id]);
  nodes[copy.id] = { parent: nodes[tabId]?.parent ?? null, collapsed: false };
  persist();
  scheduleSnapshot(); // as in newChild
  const tab = await chrome.tabs.get(tabId);
  if (tab.pinned) return;
  const forest = await forestOf(tab.windowId);
  await arrange(tab.windowId, [copy.id], { after: lastOfSubtree(forest, tabId, new Set([copy.id])) });
}

// ---- folders (see folders.js) ------------------------------------------------------------

/**
 * A folder tab at `index` of window `windowId`, under `parent`, not the active tab unless `active`. `heir`: the colour
 * its tree is to keep (that of a tree it takes the place of).
 */
async function createFolder(windowId, index, parent, { active = false, heir = null } = {}) {
  // An extension's page cannot show in an incognito window ("spanning" mode): the browser would put it in a normal one.
  if ((await chrome.windows.get(windowId).catch(() => null))?.incognito !== false) return null;
  const url = folderUrl(folderBase, { id: newFolderId() });
  const tab = await chrome.tabs.create({ windowId, url, active, ...(index == null ? {} : { index }) });
  touch([tab.id]);
  nodes[tab.id] = { parent, collapsed: false, ...(heir ? { heir } : {}) };
  persist();
  scheduleSnapshot(); // its onCreated finds the node made already
  return tab;
}

/**
 * "New folder": after the tree of tab `tabId` (`inside`: as its first child), or with no tab, at the end of window
 * `windowId`. It becomes the active tab, its page ready for a name.
 */
async function newFolder({ tabId = null, windowId = null, inside = false }) {
  const tab = tabId == null ? null : await chrome.tabs.get(tabId);
  if (!tab || tab.pinned) {
    const target = tab?.windowId ?? windowId;
    return (await createFolder(target, null, null, { active: true }))?.id ?? null;
  }
  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  if (inside) return (await createFolder(tab.windowId, tab.index + 1, tab.id, { active: true }))?.id ?? null;
  const last = lastOfSubtree(buildForest(tabs, nodes), tab.id);
  const index = tabs.find((t) => t.id === last).index + 1;
  return (await createFolder(tab.windowId, index, nodes[tab.id]?.parent ?? null, { active: true }))?.id ?? null;
}

/** Of `tabIds` (one window's), the unpinned ones whose subtrees hold the others, in strip order, with that window's tabs. */
async function topsOf(tabIds) {
  const found = (await Promise.all(tabIds.map((id) => chrome.tabs.get(id).catch(() => null)))).filter((t) => t && !t.pinned);
  if (!found.length) return null;
  const { windowId } = found[0];
  const tabs = await chrome.tabs.query({ windowId });
  const forest = buildForest(tabs, nodes);
  const chosen = new Set(found.filter((t) => t.windowId === windowId).map((t) => t.id));
  const tops = tabs.filter((t) => chosen.has(t.id)).sort(byIndex).filter((t) => {
    for (let at = forest.parentOf.get(t.id); at != null; at = forest.parentOf.get(at)) if (chosen.has(at)) return false;
    return true;
  });
  return { windowId, tabs, forest, tops };
}

/**
 * "Move to new folder": a folder where the first of the tabs `tabIds` is (under its parent), and the tabs in it with
 * their subtrees, in their order. A tree it takes the place of keeps its colour. Returns the folder's tab id.
 */
async function moveToNewFolder(tabIds) {
  const found = await topsOf(tabIds);
  if (!found?.tops.length) return null;
  const { windowId, tops } = found;
  const [first] = tops;
  const parent = nodes[first.id]?.parent ?? null;
  const heir = found.forest.parentOf.get(first.id) == null ? colorOf(nodes[first.id]) : null;
  const folder = await createFolder(windowId, first.index, parent, { heir });
  if (!folder) return null; // an incognito window
  for (const tab of tops) await moveTree(tab.id, windowId, folder.id, 'lastChild');
  return folder.id;
}

/**
 * A drag of a tab alone (Ctrl held as it started): its children stay, moving up into its place (see leaveTree), and the
 * tab goes to the drop's place, as moveTree takes a tree there.
 */
async function moveAlone(tabId, windowId, targetId, position) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.pinned || !nodes[tabId]) return false;
  leaveTree(nodes, tabId);
  persist();
  return moveTree(tabId, windowId, targetId, position);
}

/**
 * Several tabs (the ones selected in the panel) with their subtrees, in their order, to the drop's place (as moveTree):
 * the first where the drop says, each next one after the one before it, or as the drop says when that keeps them in
 * order (before a tab, a last child, the end).
 */
async function moveTabs(tabIds, windowId, targetId, position) {
  const found = await topsOf(tabIds);
  if (!found) return false;
  let moved = false;
  let previous = null;
  for (const tab of found.tops) {
    const after = previous != null && position !== 'end';
    if (await moveTree(tab.id, windowId, after ? previous : targetId, after ? 'afterTree' : position)) {
      moved = true;
      previous = tab.id;
    }
  }
  return moved;
}

/**
 * A tab group of the user's own, whole, to a new window (its menu in the panel): the browser moves the group there, and
 * the new window's own New Tab page goes.
 */
async function moveGroupToNewWindow(groupId) {
  const group = await chrome.tabGroups.get(groupId);
  const source = await chrome.windows.get(group.windowId);
  const win = await chrome.windows.create({ focused: true, incognito: source.incognito });
  const blank = (await chrome.tabs.query({ windowId: win.id })).map((t) => t.id);
  try {
    await chrome.tabGroups.move(groupId, { windowId: win.id, index: -1 });
  } catch (error) {
    await chrome.windows.remove(win.id).catch(() => {});
    throw error;
  }
  if (blank.length) await chrome.tabs.remove(blank).catch(() => {});
}

/** "Move to new window" for several tabs: the first's tree makes the window (see moveToNewWindow), the others follow. */
async function moveTabsToNewWindow(tabIds, events) {
  const found = await topsOf(tabIds);
  if (!found?.tops.length) return;
  const [first, ...rest] = found.tops;
  await moveToNewWindow(first.id, events);
  const { windowId } = await chrome.tabs.get(first.id);
  if (windowId === found.windowId) return; // no window was made
  for (const tab of rest) await moveTree(tab.id, windowId, null, 'end');
}

/** "Move to folder": the tabs `tabIds`, with their subtrees, at the end of folder `folderId` (in any window). */
async function moveToFolder(tabIds, folderId) {
  const folder = await chrome.tabs.get(folderId);
  if (!parseFolder(folder.url || folder.pendingUrl, folderBase)) return false;
  const found = await topsOf(tabIds);
  if (!found) return false;
  let moved = false;
  for (const tab of found.tops) {
    if (tab.id !== folderId && await moveTree(tab.id, folder.windowId, folderId, 'lastChild')) moved = true;
  }
  return moved;
}

/** A folder's new name or icon (`changes`): its page shows it, from its URL. */
async function updateFolder(tabId, changes) {
  const tab = await chrome.tabs.get(tabId);
  // From the newest of its folder URLs: one it is going to (a rename sent a moment ago) comes first.
  const now = [tab.pendingUrl, tab.url].find((url) => parseFolder(url, folderBase));
  const folder = parseFolder(now, folderBase);
  if (!folder) return;
  const url = folderUrl(folderBase, { ...folder, ...changes });
  if (url === now) return;
  // A loaded page keeps the change in its own history entry (replaceState), as its own field does: a rename is no step
  // for Back. Only a tab with no page to answer (discarded, still loading) is sent to the new URL.
  const kept = await chrome.runtime.sendMessage({ type: 'folderChanged', tabId, changes }).catch(() => false);
  if (kept !== true) await chrome.tabs.update(tabId, { url });
}

/** A new tab in tab `tabId` (a folder's "+"): its last child, or with `first` its first. */
async function newTabIn(tabId, first) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.pinned) return; // a pinned tab heads no tree (see buildForest)
  if (!first) return newChild(tabId);
  const child = await chrome.tabs.create({ windowId: tab.windowId, openerTabId: tabId, index: tab.index + 1, active: true });
  touch([child.id]);
  nodes[child.id] = { parent: tabId, collapsed: false };
  persist();
  scheduleSnapshot(); // as in newChild
}

/** `events`: the tab events counted when the request came in. */
async function moveToNewWindow(tabId, events) {
  const tab = await chrome.tabs.get(tabId);
  let tabs = await chrome.tabs.query({ windowId: tab.windowId }); // this window only: quicker with many tabs
  // Trees of other windows can take their colours from tabs here: should storing this window's
  // alone, or the move, change one, store every window's, each decided from the same nodes (see
  // storeColors). For the move (the top tab lets go of its parent) that matters only while a colour
  // may not be stored yet: while a colour pass is pending (see scheduleColors and init), or after a
  // tab event that came in since the request, whose handler runs after this one.
  const unsettled = colorsQueued || tabEvents !== events;
  if (colorsReachOtherWindows(tabs, nodes, unsettled ? tabId : null)) tabs = await chrome.tabs.query({});
  storeTreeColors(tabs); // as in moveTree
  const block = subtree(buildForest(tabs.filter((t) => t.windowId === tab.windowId), nodes), tabId);
  const [first, ...rest] = block;
  // As in moveTree, the panels leave the tabs out until they are there (the new window has no
  // panel yet). Should the window not be made, the tree stays as it was.
  leaving = { tabs: block, windowId: null };
  touch(block);
  try {
    await chrome.storage.session.set({ tree: treeValue() });
    const created = await changing([first], () => chrome.windows.create({ tabId: first, focused: true }));
    ownWindows.set(first, created.id);
    leaving = { tabs: block, windowId: created.id };
    nodeOf(first).parent = null;
    persist();
    if (rest.length) await changing(rest, () => chrome.tabs.move(rest, { windowId: created.id, index: -1 })).catch(() => bringRest(rest, created.id));
  } finally {
    leaving = null;
    writeTree();
  }
}

/** The colour picked in the panel's menu for the tree that `tabId` heads. */
function setTreeColor(tabId, color) {
  if (!TREE_COLORS.includes(color)) throw new Error(`unknown colour: ${color}`);
  const node = nodes[tabId];
  if (!node) return; // the tab was closed while the menu was open
  supersede([tabId], 'color');
  node.color = color;
  delete node.lastColor;
  delete node.heir;
  persist();
  scheduleSnapshot();
}

/** The name the user gave the group of the unit that `tabId` heads; an empty one brings back the automatic name. */
function setGroupName(tabId, name) {
  const node = nodes[tabId];
  if (!node) return;
  supersede([tabId], 'title');
  const text = oneLine(name).slice(0, 200);
  if (text) node.groupName = text;
  else delete node.groupName;
  persist();
  scheduleSnapshot();
}

/** The colour picked for the unit below the top level that `tabId` heads (not in mode 'trees'). */
function setGroupColor(tabId, color) {
  if (!TREE_COLORS.includes(color)) throw new Error(`unknown colour: ${color}`);
  const node = nodes[tabId];
  if (!node) return;
  supersede([tabId], 'color');
  node.groupColor = color;
  delete node.lastGroupColor;
  persist();
  scheduleSnapshot();
}

/** Whether the unit that `tabId` heads stays out of the tab groups (the user ungrouped it). */
function setNoGroup(tabId, noGroup) {
  const node = nodes[tabId];
  if (!node) return;
  if (noGroup) node.noGroup = true;
  else delete node.noGroup;
  persist();
  scheduleSnapshot();
}

// ---- tree colours ----------------------------------------------------------------------

let colorsQueued = false;
let colorRetries = 0;
let staleSince = null; // when the tabs a colour pass read first turned out to be out of date
// Tab events so far, the pinned changes among onUpdated's included: tabs read before the last
// one may be out of date.
let tabEvents = 0;
for (const event of [
  chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onReplaced,
  chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onDetached,
]) {
  event.addListener(() => { tabEvents++; });
}

/**
 * Settle the tree colours of every window (see storeColors) after the current task, once the
 * tabs have their final places. The tabs are read outside the queue, so that the tasks behind
 * this one (placing a tab opened by a link, say) need not wait for that. If a tab event came in
 * meanwhile, they are read again a little later; only when tabs have kept changing for a few
 * seconds are they read in the queue. The panel draws a new tree in its colour before this
 * stores it.
 */
function scheduleColors(delay = 0) {
  if (colorsQueued) return;
  colorsQueued = true;
  setTimeout(async () => {
    const seen = tabEvents;
    let tabs = await chrome.tabs.query({}).catch(() => null); // the browser may be quitting
    run(async () => {
      colorsQueued = false;
      if (tabEvents !== seen) {
        staleSince ??= Date.now();
        if (Date.now() - staleSince < STALE_COLORS_MS) return scheduleColors(Math.min(200, 50 * 2 ** colorRetries++));
        // Tabs keep changing: read them here, where only the browser can change them meanwhile.
        tabs = await chrome.tabs.query({}).catch(() => null);
      }
      staleSince = null;
      colorRetries = 0;
      if (tabs && storeTreeColors(tabs)) {
        writeTree();
        scheduleSnapshot();
      }
    });
  }, delay);
}

/** Store the tree colours (see storeColors) and the first links (see storeFirstLinks) of every window. Whether a node changed. */
function storeTreeColors(tabs) {
  const forests = tabsByWindow(tabs).map((list) => buildForest(list, nodes));
  // The first links in every mode: with groups off, no group pass records them (see firstLink in groups.js).
  const linked = forests.map((forest) => storeFirstLinks(forest, nodes)).some(Boolean);
  return storeColors(forests, nodes) || linked;
}

function tabsByWindow(tabs) {
  const byWindow = new Map();
  for (const tab of tabs) {
    if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
    byWindow.get(tab.windowId).push(tab);
  }
  return [...byWindow.values()];
}

// ---- tab groups ------------------------------------------------------------------------

let settings = readSettings(null);
// The groups the worker made, or took over, and the unit each is for: { groupId: head }. Kept with the nodes. A group
// is owned until it is gone: one being dissolved stays owned while its tabs are ungrouped, should that fail.
const owned = {};
// The owned groups that the worker took over from the user (see planGroups): never ungrouped by the worker, and let
// go of as they are, the user's again. Kept with the nodes.
const adopted = new Set();
let groupsHoldUntil = 0; // see STARTUP_GROUPS_MS
const windowHolds = new Map(); // window id -> until when the group pass leaves its groups alone (see restoreWindow)
/** Whether the group pass leaves the groups of window `windowId` alone for now (see STARTUP_GROUPS_MS). */
const groupsHeld = (windowId, now = Date.now()) => now < groupsHoldUntil || now < (windowHolds.get(windowId) ?? 0);
// The tabs that init gave their nodes from the snapshot (see restoreWindow).
const fromSnapshot = new Set();
let groupsQueued = false;
let syncing = false; // a group pass is running: a change meanwhile asks for another (groupsAgain)
let groupsAgain = false;
let ownWrite = false; // the group pass is storing what it did, which asks for no other
// Tab id -> when the worker last moved, grouped, ungrouped or made the tab; when the browser made it.
const touched = new Map();
const born = new Map();
// Group id -> what the worker set on it: [{ key, value, at }], the oldest first (see echoes).
const sent = new Map();
// Group id -> its look ({ title, color, collapsed }) as its last event, or the group pass, saw it: an event carries
// the whole look, and what it changes is told from what it repeats by this. Kept in session storage too, so that a
// change the user makes while the worker sleeps is one when its event wakes the worker.
const looks = new Map();
const LOOK = ['title', 'color', 'collapsed'];
const lookOf = (group) => ({ title: group.title, color: group.color, collapsed: group.collapsed });
let looksQueued = false;
// Group id -> the user's changes to the group that wait to settle: { values: { key: value }, timer }, and, for an
// expansion, { windowId, expandedAt } (see noteStrip). The group pass leaves the group's look alone meanwhile, so as not
// to undo what the user is doing.
const userChanges = new Map();
// The tab events of the last few seconds that move the selection (see noteStrip): [window id, when it came, scope].
const stripEvents = [];
// Tab id -> { groupId, at }: the worker made it the active tab (see activateIfHidden); its events within
// OWN_ACTIVATION_MS are that switch's.
const ownActivations = new Map();
const OWN_ACTIVATION_MS = 1000;
// Window id -> how many times a tab was made the active one there, but by the worker (see takeUserChanges).
const activations = new Map();

/** The worker's own recent switch to tab `tabId` (see activateIfHidden), or null. */
function ownActivation(tabId) {
  const own = ownActivations.get(tabId);
  return own && Date.now() - own.at < OWN_ACTIVATION_MS ? own : null;
}
// Tabs the user put into a group or took out of one: waiting for the rest of the same change (moves), and until
// userMoves has handled them (userMoved: tab id -> when noted), the while the group pass leaves the groups alone.
let moves = new Set();
let movesTimer = null;
const userMoved = new Map();
// A move noted this long ago no longer holds the group pass, whatever became of it.
const MOVES_STALE_MS = 10000;
// Tab id -> how many of the worker's calls that move, group or ungroup it are under way (see changing).
const inFlight = new Map();
// Tabs that the worker's grouping unpinned (the user pinned them after the pass read the tabs): pinned again.
const unpinned = new Set();
// Group id -> its window, as the worker last saw it (see userMoves).
const groupWindow = new Map();

const recent = (times, id, ms) => Date.now() - (times.get(id) ?? -Infinity) < ms;

/** Run `call`, which moves, groups or ungroups the tabs `ids`: their group events meanwhile are the worker's own. */
async function changing(ids, call) {
  touch(ids);
  for (const id of ids) inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
  try {
    return await call();
  } finally {
    for (const id of ids) {
      const left = (inFlight.get(id) ?? 1) - 1;
      if (left > 0) inFlight.set(id, left);
      else inFlight.delete(id);
    }
    touch(ids);
  }
}

/**
 * A change made in the panel (to the trees with `heads`) is newer than a change of the same kind (`key`: title, color,
 * collapsed) that the user made to their groups in the tab strip and that waits to settle (see sawGroup): it wins.
 */
function supersede(heads, key) {
  for (const [id, head] of Object.entries(owned)) {
    if (heads.includes(head)) delete userChanges.get(Number(id))?.values[key];
  }
}

function touch(ids) {
  const now = Date.now();
  for (const id of ids) touched.set(id, now);
  if (touched.size > 500) for (const [id, at] of touched) if (now - at > TOUCH_MS) touched.delete(id);
  if (born.size > 500) for (const [id, at] of born) if (now - at > NEW_TAB_MS) born.delete(id);
}

/** Which of a group's title, colour and collapsed state, as an event reports them, the worker set itself. */
function echoes(group) {
  const now = Date.now();
  const list = (sent.get(group.id) ?? []).filter((entry) => now - entry.at < ECHO_MS);
  const own = new Set();
  for (const key of ['title', 'color', 'collapsed']) {
    const i = list.findIndex((entry) => entry.key === key && entry.value === group[key]);
    if (i < 0) continue;
    own.add(key);
    list.splice(i, 1);
  }
  if (list.length) sent.set(group.id, list);
  else sent.delete(group.id);
  return own;
}

/**
 * A tab event in window `windowId` that can make the browser open a collapsed group (see BROWSER_EXPAND_MS): a tab made,
 * closed, moved, attached, detached, activated or selected. Noted as it comes, before its task runs. An expansion seen
 * just before it (when a tab of a collapsed group becomes the active one, the group's event comes first) was the
 * browser's. `scope`: for the worker's own switch, the group of the tab it activated, the only group the browser can
 * open for it (its views open only the groups of selected tabs).
 */
function noteStrip(windowId, scope) {
  const now = Date.now();
  stripEvents.push([windowId, now, scope]);
  while (stripEvents.length && (now - stripEvents[0][1] > 5000 || stripEvents.length > 500)) stripEvents.shift();
  for (const [id, entry] of userChanges) {
    if (scope !== undefined && id !== scope) continue;
    if (entry.windowId === windowId && entry.values.collapsed === false && now - entry.expandedAt <= BROWSER_EXPAND_MS) {
      browserExpanded(id, entry);
    }
  }
}

/** Whether a tab event of noteStrip's that can explain group `groupId`'s opening came in its window near `at`. */
const nearStrip = (windowId, at, groupId) => stripEvents.some(([w, t, scope]) => w === windowId
  && (scope === undefined || scope === groupId) && Math.abs(t - at) <= BROWSER_EXPAND_MS);

/**
 * The browser opened group `id`, not the user (see BROWSER_EXPAND_MS): the tree stays as it is, and the group follows
 * it again. That also drops a collapse that waits to settle: a header drag's (dragging a group's header collapses it
 * until the drop), and, rarely, the user's own (the browser opened the group around the active tab within the second:
 * a tab before it closed, say), when group and tree stay open, alike.
 */
function browserExpanded(id, entry) {
  delete entry.values.collapsed;
  if (!Object.keys(entry.values).length) {
    clearTimeout(entry.timer);
    userChanges.delete(id);
  }
  scheduleGroups();
}

function writeLooks() {
  if (looksQueued) return;
  looksQueued = true;
  setTimeout(() => {
    looksQueued = false;
    chrome.storage.session.set({ groupLooks: Object.fromEntries(looks) }).catch(() => {}); // the browser may be quitting
  }, 0);
}

/**
 * An event of a group (made or changed), which came at `at`. What it changes, and the worker did not set (see echoes),
 * is the user's doing (or another extension's), but for the browser's opening a collapsed group (see BROWSER_EXPAND_MS).
 * The user's changes to one of the worker's groups go into the tree once the group has stayed as it is a moment: a
 * rename in the tab strip comes a keystroke at a time, and dragging a group's header collapses it until the drop.
 */
function sawGroup(group, at = Date.now()) {
  const own = echoes(group);
  const before = looks.get(group.id);
  const now = lookOf(group);
  looks.set(group.id, now);
  writeLooks();
  // The snapshot keeps the name and colour of the worker's groups (hadGroup), which a reload checks a group by (see
  // bringBackFolders and planGroups): a change to them is saved, though no tree changed with it.
  if (owned[group.id] != null && (before?.title !== now.title || before?.color !== now.color)) scheduleSnapshot();
  if (!before || owned[group.id] == null) return;
  const theirs = LOOK.filter((key) => before[key] !== now[key] && !own.has(key));
  const opened = theirs.includes('collapsed') && !now.collapsed;
  if (opened && nearStrip(group.windowId, at, group.id)) {
    theirs.splice(theirs.indexOf('collapsed'), 1);
    if (userChanges.has(group.id)) browserExpanded(group.id, userChanges.get(group.id));
    else scheduleGroups();
  }
  if (!theirs.length) return;
  const entry = userChanges.get(group.id) ?? { values: {} };
  for (const key of theirs) entry.values[key] = now[key];
  if (theirs.includes('collapsed') && opened) Object.assign(entry, { windowId: group.windowId, expandedAt: at });
  if (theirs.includes('collapsed') && now.collapsed) entry.activations = activations.get(group.windowId) ?? 0;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => run(() => takeUserChanges(group.id, entry)),
    entry.values.collapsed ? COLLAPSE_SETTLE_MS : GROUP_SETTLE_MS);
  userChanges.set(group.id, entry);
}

/**
 * A tab became the active one: a collapse that the user made in the tab strip to its group, still settling, would hide
 * it (a tab below the top of the group's tree). The newer step wins: that collapse is dropped.
 */
async function wentInto(tabId) {
  if (![...userChanges.values()].some((entry) => entry.values.collapsed === true)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const entry = tab && userChanges.get(tab.groupId);
  if (!entry || entry.values.collapsed !== true || owned[tab.groupId] === tabId) return;
  delete entry.values.collapsed;
  if (!Object.keys(entry.values).length) {
    clearTimeout(entry.timer);
    userChanges.delete(tab.groupId);
  }
  scheduleGroups(); // the group as its tree has it
}

function forgetGroup(id) {
  looks.delete(id);
  writeLooks();
  clearTimeout(userChanges.get(id)?.timer);
  userChanges.delete(id);
}

/** Settle the tab groups (see syncGroups) a moment after the current task. */
function scheduleGroups(delay = GROUPS_DELAY_MS) {
  if (ownWrite) return;
  if (syncing) {
    groupsAgain = true; // the pass may have read the tabs before this change
    return;
  }
  if (groupsQueued) return;
  groupsQueued = true;
  setTimeout(() => run(syncGroups), delay);
}

/**
 * Make the browser's tab groups match the trees, window by window, as the settings say (see groups.js):
 * each unit's tabs in its group, named, coloured and collapsed as it should be. A tab the browser made in
 * one of the worker's groups, which no link gave a parent (the group's "New tab in group", say), joins the
 * group's tree where it is. Should a step fail (a tab closed meanwhile, or the user is dragging a tab), the
 * rest waits for the next pass.
 */
async function syncGroups() {
  groupsQueued = false;
  if (settings.groups === 'off' && !Object.keys(owned).length) return;
  // The user is moving tabs into or out of groups: that goes into the tree first (userMoves then asks for a pass).
  for (const [id, at] of userMoved) if (Date.now() - at > MOVES_STALE_MS) userMoved.delete(id);
  if (userMoved.size) return;
  // Just after a fresh start the pass keeps its books (which groups are the worker's) but changes nothing in the
  // browser, which may still be linking its restored groups to its saved ones (see STARTUP_GROUPS_MS); nor in a window
  // that came back (see restoreWindow).
  const now = Date.now();
  for (const [id, until] of windowHolds) if (now >= until) windowHolds.delete(id);
  const holding = now < groupsHoldUntil;
  const holdsUntil = Math.max(groupsHoldUntil, ...windowHolds.values());
  syncing = true;
  try {
    // Normal windows' tabs only: those are the ones with groups (and a read of every window's is the colour pass's).
    let tabs;
    let groups;
    let windows;
    try {
      [tabs, groups, windows] = await Promise.all([
        chrome.tabs.query({ windowType: 'normal' }),
        chrome.tabGroups.query({}),
        chrome.windows.getAll({ windowTypes: ['normal'] }),
      ]);
    } catch (error) {
      // The browser may be quitting, or have no window left (it keeps running in the background).
      if (Date.now() < holdUntil || /current window/i.test(error?.message ?? '')) return;
      throw error;
    }
    const live = new Set(groups.map((group) => group.id));
    let changed = false;
    let failed = false;
    for (const id of Object.keys(owned)) {
      if (live.has(Number(id))) continue;
      delete owned[id]; // closed, or all its tabs left
      adopted.delete(Number(id));
      changed = true;
    }
    // Groups whose events the worker has not seen (taken over, or from before it started): as they are now.
    for (const group of groups) {
      if (!looks.has(group.id)) looks.set(group.id, lookOf(group));
      groupWindow.set(group.id, group.windowId);
    }
    for (const id of looks.keys()) if (!live.has(id)) looks.delete(id);
    writeLooks();
    for (const win of windows) {
      const list = tabs.filter((tab) => tab.windowId === win.id);
      const held = holding || windowHolds.has(win.id);
      if (!held && joinNewTabs(list)) {
        expandAboveActive(list); // a tab that joined a collapsed tree can be the active one
        changed = true;
      }
      const forest = buildForest(list, nodes);
      if (storeFirstLinks(forest, nodes)) changed = true; // see firstLink in groups.js
      const units = groupUnits(forest, nodes, settings.groups);
      const colors = unitColors(forest, nodes, units, treeColors(forest, nodes));
      if (storeUnitColors(forest, nodes, units, colors)) changed = true;
      const ops = planGroups({
        tabs: list, groups: groups.filter((group) => group.windowId === win.id), forest, units, colors, nodes, owned,
        adopted, policy: settings.ownGroups, mode: settings.groups,
      });
      const done = await applyGroups(ops, win.id, list, held);
      if (done.changed) changed = true;
      if (done.failed) failed = true;
    }
    for (const node of failed || holding || windowHolds.size ? [] : Object.values(nodes)) {
      if (!node.hadGroup && !node.groupAdopted) continue;
      delete node.hadGroup; // every window has had its chance to take back its groups
      delete node.groupAdopted;
      changed = true;
    }
    if (holdsUntil > Date.now()) setTimeout(() => scheduleGroups(0), holdsUntil - Date.now());
    if (changed) {
      ownWrite = true;
      persist();
      ownWrite = false;
      scheduleSnapshot();
    }
  } finally {
    syncing = false;
    if (groupsAgain) {
      groupsAgain = false;
      scheduleGroups();
    }
  }
}

/**
 * Carry out what planGroups decided for one window; while `holding`, only what the worker keeps in its books. Returns
 * whether a node or `owned` changed, and whether it failed.
 */
async function applyGroups(ops, windowId, tabs, holding) {
  let changed = false;
  let failed = false;
  const created = new Map(); // head -> the group just made for it
  for (const op of ops) {
    if (holding && ['ungroup', 'group', 'update'].includes(op.type)) continue;
    try {
      if (op.type === 'own') {
        owned[op.groupId] = op.head;
      } else if (op.type === 'adopt') {
        owned[op.groupId] = op.head;
        if (op.foreign) {
          adopted.add(op.groupId);
          takeOver(op, tabs);
        } else if (nodes[op.head]?.groupAdopted) {
          adopted.add(op.groupId); // the user's, taken over before the reload or restart
        }
      } else if (op.type === 'release') {
        // Owned until it is gone (its tabs are ungrouped next), but a group taken over from the user is theirs again
        // (unless the user asked for it to be ungrouped: see planGroups).
        if (adopted.has(op.groupId) && !nodes[owned[op.groupId]]?.noGroup) {
          delete owned[op.groupId];
          adopted.delete(op.groupId);
        }
      } else if (op.type === 'ungroup') {
        await changing(op.tabIds, () => chrome.tabs.ungroup(op.tabIds));
      } else if (op.type === 'group') {
        // Grouping unpins a pinned tab and brings over a tab from another window: leave out any tab that the user
        // pinned or moved away since the tabs were read.
        const here = new Set((await chrome.tabs.query({ windowId, pinned: false })).map((tab) => tab.id));
        const tabIds = op.tabIds.filter((id) => here.has(id));
        // (A new group of one tab only for a unit of one: see groupUnits.)
        if (tabIds.length < (op.groupId == null ? Math.min(2, op.tabIds.length) : 1)) {
          setTimeout(() => scheduleGroups(), GROUPS_RETRY_MS);
          continue;
        }
        const id = await changing(tabIds, () => chrome.tabs.group(op.groupId == null
          ? { tabIds, createProperties: { windowId } }
          : { groupId: op.groupId, tabIds }));
        groupWindow.set(id, windowId);
        const repin = tabIds.filter((tab) => unpinned.delete(tab));
        if (repin.length) {
          for (const tab of repin) await changing([tab], () => chrome.tabs.update(tab, { pinned: true })).catch(() => {});
          setTimeout(() => scheduleGroups(), GROUPS_RETRY_MS); // the group, without them
        }
        if (op.groupId == null) {
          created.set(op.head, id);
          owned[id] = op.head;
        }
      } else if (op.type === 'update') {
        const id = op.groupId ?? created.get(op.head);
        if (id == null) continue;
        if (userChanges.has(id)) {
          setTimeout(() => scheduleGroups(), GROUPS_RETRY_MS); // once the user's change is in the tree
          continue;
        }
        const now = Date.now();
        const mine = Object.entries(op.props).map(([key, value]) => ({ key, value, at: now }));
        if (!sent.has(id)) sent.set(id, []);
        sent.get(id).push(...mine);
        try {
          await chrome.tabGroups.update(id, op.props);
        } catch (error) {
          sent.set(id, (sent.get(id) ?? []).filter((entry) => !mine.includes(entry))); // no event will come for it
          throw error;
        }
      }
      if (['own', 'adopt', 'release', 'group'].includes(op.type)) changed = true;
    } catch (error) {
      // A tab or group went away meanwhile, or the user is dragging a tab: the next pass sees how things are then.
      console.warn('[tree-tabs] tab groups:', error?.message ?? error);
      failed = true;
      setTimeout(() => scheduleGroups(0), GROUPS_RETRY_MS);
      break;
    }
  }
  return { changed, failed };
}

/** A foreign group became the group of the unit that `op.head` heads: its name, colour and state go into the tree. */
function takeOver(op, tabs) {
  const node = nodes[op.head];
  if (!node) return;
  const tab = tabs.find((t) => t.id === op.head);
  if (op.title && op.title !== autoName(tab)) node.groupName = op.title;
  if (TREE_COLORS.includes(op.color)) {
    const forest = buildForest(tabs, nodes);
    if (forest.parentOf.get(op.head) != null) {
      node.groupColor = op.color;
      delete node.lastGroupColor;
    } else {
      node.color = op.color; // as if picked in the panel
      delete node.lastColor;
      delete node.heir;
    }
  }
  // Collapsed or open: the tree too, but not collapsed if that would hide the active tab below its top (the group of a
  // user's that holds the active tab can be collapsed in Edge, and another extension's in any browser).
  const active = tabs.find((t) => t.active)?.id;
  node.collapsed = !!op.collapsed && (active === op.head || !subtree(buildForest(tabs, nodes), op.head).includes(active));
}

/**
 * Tabs the browser made in one of the worker's groups, recently, that no link gave a parent and the worker did not
 * make: they join the group's tree where they are (see joinTree). Returns whether one did.
 */
function joinNewTabs(tabs) {
  let joined = false;
  for (const tab of tabs) {
    const head = owned[tab.groupId];
    if (head == null || tab.id === head || tab.pinned || !recent(born, tab.id, NEW_TAB_MS) || recent(touched, tab.id, NEW_TAB_MS)) continue;
    if (!nodes[tab.id] || nodes[tab.id].parent != null || !nodes[head]) continue;
    const forest = buildForest(tabs, nodes);
    const unit = groupUnits(forest, nodes, settings.groups).find((u) => u.head === head);
    if (!unit || unit.tabs.includes(tab.id)) continue;
    joinTree(tabs, nodes, tab.id, head, settings.groups);
    joined = true;
  }
  return joined;
}

/**
 * The user's changes to one of the worker's groups (see sawGroup), settled: into the tree, with the values the user
 * set (the group pass may have set others since). A name: the group's name (an empty one, or the automatic one: the
 * automatic name again); a colour: the tree's colour as if picked in the panel, or that of a unit below the top level;
 * collapsed: the tree too, whatever the active tab (Chrome's header click switches to a tab outside the group first;
 * Edge's leaves the active tab in the group, hidden in the strip: if the tree hides it now, the tree's top becomes the
 * active tab, as when the tree is collapsed in the panel); expanded: the tree shows, its head included.
 */
async function takeUserChanges(id, entry) {
  if (userChanges.get(id) !== entry) return; // a later change has its own timer
  // Dragging a group's header collapses the group until the drop: a collapse waits for the drag to end.
  if (entry.values.collapsed === true && await dragging()) {
    if (userChanges.get(id) === entry) {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => run(() => takeUserChanges(id, entry)), COLLAPSE_SETTLE_MS);
    }
    return;
  }
  if (userChanges.get(id) !== entry) return; // the browser's after all (see noteStrip), or a tab went into it (wentInto)
  userChanges.delete(id);
  const head = owned[id];
  const group = head != null && nodes[head] ? await chrome.tabGroups.get(id).catch(() => null) : null;
  if (!group) return;
  const tabs = await chrome.tabs.query({ windowId: group.windowId }).catch(() => []);
  const forest = buildForest(tabs, nodes);
  const unit = groupUnits(forest, nodes, settings.groups).find((u) => u.head === head);
  if (!unit) return;
  const node = nodes[head];
  const { title, color, collapsed } = entry.values;
  if (title !== undefined) {
    const name = oneLine(title);
    if (name && name !== autoName(tabs.find((t) => t.id === head))) node.groupName = name;
    else delete node.groupName;
  }
  if (TREE_COLORS.includes(color)) {
    if (isNested(forest, unit)) {
      node.groupColor = color;
      delete node.lastGroupColor;
    } else {
      node.color = color;
      delete node.lastColor;
      delete node.heir;
    }
  }
  // A collapse whose group is open again is a header drag's that ended (the drop's expansion, still to be handled, is
  // told apart in sawGroup): not taken in.
  const collapsing = collapsed === true && group.collapsed;
  if (collapsing) node.collapsed = true;
  if (collapsed === false) {
    for (let at = head; at != null; at = forest.parentOf.get(at)) if (nodes[at]?.collapsed) nodes[at].collapsed = false;
  }
  persist();
  scheduleSnapshot();
  // A tab made the active one since the collapse came is the user's step (its wentInto may be queued behind this): no
  // switch then, and the tree shows that tab (see activateIfHidden).
  if (collapsing) await activateIfHidden(group.windowId, [head], () => (activations.get(group.windowId) ?? 0) === entry.activations);
}

/** A tab changed its group, not by the worker's doing: see userMoves, once tabs have stopped moving. */
function noteMove(tabId) {
  stripMoved.delete(tabId); // its group change places it (see userMoves), not a strip move
  moves.add(tabId);
  userMoved.set(tabId, Date.now());
  settleMoves();
}

function settleMoves() {
  clearTimeout(movesTimer);
  movesTimer = setTimeout(() => {
    movesTimer = null;
    const batch = moves;
    moves = new Set();
    run(async () => {
      try {
        if (await dragging()) {
          for (const id of batch) moves.add(id);
          settleMoves();
          return;
        }
        await userMoves(batch);
      } finally {
        for (const id of batch) if (!moves.has(id)) userMoved.delete(id);
        scheduleGroups(); // the pass waited for these (see syncGroups)
      }
    });
  }, MOVES_SETTLE_MS);
}

/**
 * Whether the user is dragging a tab or a group's header, in any window: then every change to the tab strip fails.
 * tabs.update without a tab id checks that first, then makes the current window's active tab, as the browser finds it
 * at that moment, the active tab: it is already, so nothing changes, no event comes, and no tab is touched.
 */
async function dragging() {
  try {
    await chrome.tabs.update({ active: true });
    return false;
  } catch (error) {
    return /cannot be edited/i.test(error?.message ?? '');
  }
}

/**
 * Tabs the user put into one of the worker's groups, or took out of one, in the tab strip (or another extension
 * did). One taken out leaves its tree (see leaveTree); one put in joins the group's tree where it now is (see
 * joinTree). Every tab of a group taken out at once ("Ungroup"): its unit keeps its tree and stays out of the
 * groups until the user asks for one again (see setNoGroup).
 */
async function userMoves(batch) {
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const groupOfHead = new Map(Object.entries(owned).map(([id, head]) => [head, Number(id)]));
  const leaving = new Map(); // owned group -> its unit's tabs that left it
  const joining = [];
  for (const id of batch) {
    const tab = byId.get(id);
    if (!tab || tab.pinned || !nodes[id]) continue;
    const forest = buildForest(tabs.filter((t) => t.windowId === tab.windowId), nodes);
    const unit = groupUnits(forest, nodes, settings.groups).find((u) => u.tabs.includes(id));
    const from = unit ? groupOfHead.get(unit.head) : undefined;
    // (A tab that went to another window left its group on the way: not a change to its tree.)
    if (from != null && tab.groupId !== from && groupWindow.get(from) === tab.windowId) {
      if (!leaving.has(from)) leaving.set(from, { unit, ids: [] });
      leaving.get(from).ids.push(id);
    }
    const to = owned[tab.groupId];
    if (to != null && to !== unit?.head && to !== id) joining.push({ id, head: to, windowId: tab.windowId });
  }
  let changed = false;
  for (const [group, { unit, ids }] of leaving) {
    if (!unit.tabs.some((id) => byId.get(id)?.groupId === group) && !ids.some((id) => joining.some((join) => join.id === id))) {
      // "Ungroup": no tab of the unit is in its group any more. The tree stays as it is, without a group.
      nodes[unit.head].noGroup = true;
      delete owned[group];
      adopted.delete(group);
    } else {
      // Tabs taken out together keep their links to each other: only the topmost of them leave the tree. A subtree
      // taken out so stays out of the groups, as the user wanted it (and a group of theirs that holds it, theirs).
      const out = new Set(ids.filter((id) => !joining.some((join) => join.id === id)));
      const forest = buildForest(tabs.filter((t) => t.windowId === byId.get(unit.head)?.windowId), nodes);
      for (const id of out) {
        if (out.has(forest.parentOf.get(id))) continue;
        leaveTree(nodes, id, out);
        if (forest.children.get(id)?.some((kid) => out.has(kid))) nodes[id].noGroup = true;
      }
    }
    changed = true;
  }
  for (const { id, head, windowId } of joining) {
    if (!nodes[head]) continue;
    joinTree(tabs.filter((t) => t.windowId === windowId), nodes, id, head, settings.groups);
    changed = true;
  }
  if (joining.length) expandAboveActive(tabs); // a tab that joined a collapsed tree can be the active one
  if (changed) {
    persist();
    scheduleSnapshot();
  }
}

// ---- persistence -----------------------------------------------------------------------

let persistQueued = false;
// While moveTree or moveToNewWindow takes a tree to another window: its tabs, and that window (null
// until the new window is made). Until they are there, every write of the tree says so, and the
// panels of the other windows (of every window while it is null) leave those tabs out, rather than
// draw them as they will be over there (moveTree writes those nodes first) or falling apart once
// the top tab has gone (moveToNewWindow moves it first; its first such write still has the nodes
// of where the tabs were).
let leaving = null;
const treeValue = () => ({ nodes, groups: owned, adopted: [...adopted], ...(leaving ? { leaving } : {}) });

/** Store a change to the tree: write it, and settle the tree colours after it. */
function persist() {
  scheduleColors(); // the change may start or end a tree
  writeTree();
}

/**
 * Write the tree to session storage once the current burst of changes is over. Called on its
 * own for changes that cannot change a tree colour (see persist).
 */
function writeTree() {
  scheduleGroups(); // the groups follow every change to the tree, collapsing and colours included
  if (persistQueued) return;
  persistQueued = true;
  setTimeout(() => {
    persistQueued = false;
    chrome.storage.session.set({ tree: treeValue() }).catch((error) => {
      // While windows are closing the browser may be quitting, and then writes fail.
      if (Date.now() >= holdUntil && !quitting(error)) console.error('[tree-tabs]', error);
    });
  }, 0);
}

let snapshotTimer = null;
let holdUntil = 0;
let lastSaved = null; // the windows of the last snapshot saved, to tell which of them closed (see saveSnapshot)
let closedTaken = false; // a window came back from a kept closed window since the last snapshot (see restoreWindow)
// While changes keep coming (a page that changes its URL every moment, say), the snapshot waits for them to stop, but no
// longer than this after the first of them.
const SNAPSHOT_MAX_WAIT_MS = 5000;
let snapshotDue = null;

/**
 * Save the snapshot a second after the last change to the tree, or to the tabs' URLs, pins or order,
 * and at most SNAPSHOT_MAX_WAIT_MS after the first of them: each calls this, or the tab event it causes
 * does. An extension reload or a browser restart rebuilds the tree from the snapshot (see init).
 */
function scheduleSnapshot() {
  clearTimeout(snapshotTimer);
  const now = Date.now();
  snapshotDue ??= now + SNAPSHOT_MAX_WAIT_MS;
  const delay = Math.max(Math.min(SNAPSHOT_DELAY_MS, snapshotDue - now), holdUntil - now, 0);
  snapshotTimer = setTimeout(() => {
    snapshotDue = null;
    run(saveSnapshot);
  }, delay);
}

function holdSnapshot() {
  holdUntil = Date.now() + WINDOW_CLOSE_HOLD_MS;
  scheduleSnapshot(); // only runs if the browser is still up by then
}

async function saveSnapshot() {
  // While windows are closing, keep the snapshot that still has them: holdSnapshot saves the
  // next one, if the browser is still up by then. Nor while a window that came may be one coming back: cameBack saves
  // the next one, once its tabs have their tree (or none).
  const held = () => Date.now() < holdUntil || watching.size > 0;
  if (held()) return;
  try {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    if (held()) return;
    // The owned groups' heads, with each group's name and colour: after a reload or restart a head takes back the group
    // it is in when that still holds just its tabs, or still has that name and colour (see planGroups).
    const heads = new Map(Object.entries(owned).map(([id, head]) => [head, looks.get(Number(id))]));
    const adoptedHeads = new Set([...adopted].map((id) => owned[id]).filter((head) => head != null));
    const saved = windows
      .filter((win) => !win.incognito && win.tabs?.length)
      .map((win) => ({
        tabs: win.tabs.sort(byIndex).map((tab) => {
          const node = nodes[tab.id];
          const entry = {
            id: tab.id,
            url: tab.url || tab.pendingUrl || '',
            parent: node?.parent ?? null,
            collapsed: !!node?.collapsed,
            color: node?.color ?? null,
            lastColor: node?.lastColor ?? null,
            heir: node?.heir ?? null,
          };
          for (const key of GROUP_FIELDS) if (node?.[key] != null) entry[key] = node[key];
          if (tab.pinned) entry.pinned = true; // for a folder made anew after a reload (see bringBackFolders)
          if (heads.has(tab.id)) { // to take its group back after a reload or restart
            const look = heads.get(tab.id);
            entry.hadGroup = look ? { title: look.title, color: look.color } : true;
          }
          if (adoptedHeads.has(tab.id)) entry.groupAdopted = true; // ...as the user's, taken over
          return entry;
        }),
      }));
    // The windows that closed while the browser ran on are kept apart, for when they come back (see cameBack); those
    // that are back already go from there.
    const previous = lastSaved ?? (await chrome.storage.local.get('snapshot')).snapshot?.windows ?? [];
    const gone = goneWindows(previous, saved);
    if (gone.length || !lastSaved || closedTaken) {
      closedTaken = false;
      const { closedWindows = [] } = await chrome.storage.local.get('closedWindows');
      // A window back from one of them that closed again before a snapshot had it leaves it kept, free to take again.
      const open = new Set(windows.map((win) => win.id));
      const left = closedWindows.filter((win) => goneWindows([win], saved, backByUrl).length)
        .map(({ takenBy, ...win }) => (takenBy != null && open.has(takenBy) ? { ...win, takenBy } : win));
      // Not twice: the last window, kept while the snapshot still has it, is gone again from a later one.
      const keptIds = new Set(left.flatMap((win) => win.tabs.map((tab) => tab.id)));
      const kept = addClosedWindows(left, gone.filter((win) => !win.tabs.some((tab) => keptIds.has(tab.id))), Date.now());
      if (JSON.stringify(kept) !== JSON.stringify(closedWindows)) {
        // Should this fail (the storage is full, say), the snapshot is saved all the same.
        await chrome.storage.local.set({ closedWindows: kept })
          .catch((error) => console.warn('[tree-tabs] could not keep the closed windows', error));
      }
    }
    lastSaved = saved;
    // With no window left (the browser keeps running in the background) keep the last one.
    if (saved.length) await chrome.storage.local.set({ snapshot: { savedAt: Date.now(), windows: saved } });
  } catch (error) {
    if (!held()) throw error; // the browser is quitting
  }
}

function windowsOf(tabs) {
  return tabsByWindow(tabs.filter((tab) => !tab.incognito)).map((list) => ({
    tabs: list.sort(byIndex).map((tab) => ({ id: tab.id, url: tab.url || tab.pendingUrl || '' })),
  }));
}
