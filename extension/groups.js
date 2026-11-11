// Native tab groups for the trees: which tabs share a group, its name, colour and whether it is
// collapsed, and the changes that make the browser's groups match. Pure logic shared by the service
// worker, the side panel and the unit tests: nothing in this file touches the chrome.* APIs.
//
// A group unit is a set of tabs that should share one native tab group; its head is its top tab.
// Which tabs form one depends on the setting `groups`:
//   'trees':     every tree (a top-level tab with children): the head and all its descendants.
//   'innermost': every tab whose children have no children of their own, with those children.
//   'pages':     every tab that has children, with those of its children that have none: a tab that opens a tab
//                leaves its parent's unit and leads one of its own with the tabs it opened.
//   'branches':  every top-level tab that has children, with those of its children that have none; a child of it
//                that opens tabs leads a unit of itself and its first link's whole subtree (see firstLink), and each
//                of its other children's subtrees is a unit too: what is opened later inside a branch stays in it,
//                and so do the tabs that a tab in it opened when that tab closes (see branchKids).
//   'off':       none.
// In the modes 'pages' and 'branches' (see stacksGroups) a unit that left its parent's unit gets its group right after
// the parent's in the tab strip, while the panel draws its tabs in their places in the tree; a unit can be one tab.
// The worker records the groups it made, or took over, as `owned`: { groupId: head }. Every other
// group (the user's own, or another extension's) is foreign.
//
// Node fields used here, besides those of tree.js: `groupName` (a name the user gave the unit the
// tab heads), `groupColor` (mode 'innermost': the colour of the unit a tab heads below the top
// level), `lastGroupColor` (that colour, kept while the tab heads no such unit), `noGroup` (the user
// ungrouped the unit the tab heads: it gets no group until they ask again), `hadGroup` (from a
// snapshot: the unit had an owned group before the extension reloaded or the browser restarted),
// `firstLink` (the child that is the tab's first link, kept in every mode for 'branches': see firstLink) and
// `alsoLinks` (the other children in its branch: those that a first link that closed had opened, see branchKids).

import {
  buildForest, colorOf, displayOrder, handOnFirstLink, NEW_TREE_COLORS, rememberColor, subtree, TREE_COLORS,
} from './tree.js';

/** chrome.tabGroups.TAB_GROUP_ID_NONE: the groupId of a tab in no group. */
export const NO_GROUP = -1;

export const DEFAULT_SETTINGS = Object.freeze({ groups: 'trees', ownGroups: 'leave' });
const MODES = ['trees', 'innermost', 'pages', 'branches', 'off'];
const POLICIES = ['leave', 'regroup'];

/** The settings as stored (chrome.storage.local `settings`), with defaults for what is missing. */
export function readSettings(stored) {
  return {
    groups: MODES.includes(stored?.groups) ? stored.groups : DEFAULT_SETTINGS.groups,
    ownGroups: POLICIES.includes(stored?.ownGroups) ? stored.ownGroups : DEFAULT_SETTINGS.ownGroups,
  };
}

const isColor = (color) => TREE_COLORS.includes(color);
const byIndex = (a, b) => a.index - b.index;

/**
 * Whether the mode puts the group of a unit that left its parent's unit right after the parent's group in the tab
 * strip (see planGroups), rather than where its tabs are.
 */
export const stacksGroups = (mode) => mode === 'pages' || mode === 'branches';

/**
 * The first link of a tab with children ('branches'): the child its node records (`firstLink`, see storeFirstLinks; one
 * that closes hands the record on, see handOnFirstLink in tree.js). While that child is pinned or in another window, the
 * oldest of the tabs below it that hang in its place stands in for it, and with none it keeps its place all the same
 * (it is returned, though it is no child here): no other child takes it meanwhile, nor its group. Without a record, the
 * oldest child: the lowest tab id (the browser numbers new tabs upwards). Not the leftmost: as groups stack, the browser
 * puts a later link just after the tab that opened it, before the earlier ones. Nor, once recorded, the oldest: Edge's
 * "New tab as child" can be a New Tab page made earlier and kept ready, older than the links, and so can a tab dropped
 * under it in the panel; and Chrome numbers the tabs anew, in strip order, when it restarts.
 */
export const firstLink = (forest, id, nodes = {}) => {
  const kids = forest.children.get(id);
  if (!kids?.length) return null;
  const link = nodes[id]?.firstLink;
  if (link == null) return Math.min(...kids);
  if (kids.includes(link)) return link;
  const left = kids.filter((kid) => hangsFrom(nodes, kid, link, id));
  if (left.length) return Math.min(...left);
  if (nodes[link]?.parent === id) return link; // pinned or in another window, with nothing in its place
  return Math.min(...kids);
};

/**
 * Record the first link of every tab with children in one window (see firstLink) on its node, as `firstLink`, so that no
 * child that comes later takes its place. A record stays while it names a child of the tab, here or pinned or in another
 * window, or a tab whose children hang in its place; else it is made anew: the first of its `alsoLinks`, if it has any
 * (see branchKids), which stay on the same terms, on every tab of the window, with children here or not. Returns whether
 * a node changed.
 */
export function storeFirstLinks(forest, nodes) {
  let changed = false;
  // Every tab of the window: one with no children here (its first link pinned, say) can still have alsoLinks that left.
  for (const id of forest.order) {
    const node = nodes[id];
    if (!node) continue;
    const kids = forest.children.get(id) ?? [];
    const valid = (link) => kids.includes(link) || nodes[link]?.parent === id || kids.some((kid) => hangsFrom(nodes, kid, link, id));
    if (node.alsoLinks) {
      const also = node.alsoLinks.filter(valid);
      if (also.length !== node.alsoLinks.length) {
        if (also.length) node.alsoLinks = also;
        else delete node.alsoLinks;
        changed = true;
      }
    }
    if (!kids.length) continue;
    const link = node.firstLink;
    if (link != null && valid(link)) continue;
    if (node.alsoLinks?.length) {
      const [next, ...rest] = node.alsoLinks;
      node.firstLink = next;
      if (rest.length) node.alsoLinks = rest;
      else delete node.alsoLinks;
    } else node.firstLink = firstLink(forest, id, nodes);
    changed = true;
  }
  return changed;
}

/**
 * The children of `id` in its branch ('branches'): its first link as recorded and its `alsoLinks` (the other tabs that a
 * first link that closed or left its tree had opened: see handOnFirstLink in tree.js), and the tabs that hang in the
 * place of one of them that is pinned or in another window.
 */
function branchKids(forest, id, nodes) {
  const kids = forest.children.get(id) ?? [];
  const recorded = [nodes[id]?.firstLink, ...(nodes[id]?.alsoLinks ?? [])].filter((link) => link != null);
  return kids.filter((kid) => recorded.includes(kid) || recorded.some((link) => !kids.includes(link) && hangsFrom(nodes, kid, link, id)));
}

/** Whether the recorded parents of tab `id` reach `ancestor` before `stop`. */
function hangsFrom(nodes, id, ancestor, stop) {
  const seen = new Set([id]);
  for (let parent = nodes[id]?.parent; parent != null && parent !== stop && !seen.has(parent); parent = nodes[parent]?.parent) {
    if (parent === ancestor) return true;
    seen.add(parent);
  }
  return false;
}

/** Whether `id` has children, none of which has children of its own. */
function isInnermost(forest, id) {
  const kids = forest.children.get(id);
  return !!kids?.length && kids.every((kid) => !forest.children.has(kid));
}

/**
 * The group units of one window (see buildForest) in display order: { head, tabs, optedOut }, with
 * `tabs` the head first and then the rest of the unit in display order. A unit whose head opted out
 * (`noGroup`) is listed too, with `optedOut`: it gets no group, but keeps its colour, and the panel
 * offers to group it again.
 */
export function groupUnits(forest, nodes, mode) {
  const kids = (id) => forest.children.get(id) ?? [];
  const leaves = (id) => kids(id).filter((kid) => !forest.children.has(kid));
  let units = [];
  if (mode === 'trees') {
    units = forest.roots.filter((id) => forest.children.has(id)).map((head) => ({ head, tabs: subtree(forest, head) }));
  } else if (mode === 'innermost') {
    units = displayOrder(forest).filter((id) => isInnermost(forest, id)).map((head) => ({ head, tabs: [head, ...kids(head)] }));
  } else if (mode === 'pages') {
    units = displayOrder(forest).filter((id) => forest.children.has(id)).map((head) => ({ head, tabs: [head, ...leaves(head)] }));
  } else if (mode === 'branches') {
    for (const top of forest.roots) {
      if (!forest.children.has(top)) continue;
      units.push({ head: top, tabs: [top, ...leaves(top)] });
      for (const kid of kids(top)) {
        const first = firstLink(forest, kid, nodes);
        if (first == null) continue;
        const branch = new Set([first, ...branchKids(forest, kid, nodes)]);
        units.push({ head: kid, tabs: [kid, ...kids(kid).filter((k) => branch.has(k)).flatMap((k) => subtree(forest, k))] });
        for (const other of kids(kid)) if (!branch.has(other)) units.push({ head: other, tabs: subtree(forest, other) });
      }
    }
  }
  return units.map((unit) => ({ ...unit, optedOut: !!nodes[unit.head]?.noGroup }));
}

/** Whether a unit's head is a tab below the top level (not in mode 'trees'). */
export const isNested = (forest, unit) => forest.parentOf.get(unit.head) != null;

/**
 * Whether a unit's group should be collapsed: its tabs are hidden in the panel (its head is
 * collapsed, or one of the head's ancestors is). The group that holds the window's active tab too
 * (its head, which the panel shows): the browser leaves that tab active, hidden in the strip, as
 * Edge does when the user collapses such a group from its header.
 */
export function unitCollapsed(forest, nodes, unit) {
  for (let id = unit.head; id != null; id = forest.parentOf.get(id)) {
    if (nodes[id]?.collapsed) return true;
  }
  return false;
}

/** The name of a unit's group: the one the user gave it, or else one from its head's page. */
export const unitTitle = (nodes, head, headTab) => nodes[head]?.groupName || autoName(headTab);

/** Text as one line, as a group's name is shown: control characters as spaces, runs of spaces as one, trimmed. */
export const oneLine = (text) => String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

// "(79) " or "(99+) ": the unread count that mail and feed pages put before their title.
const LEADING_COUNT = /^\(\d+\+?\)\s*/;
const TRAILING_COUNT = /\s*\(\d+\+?\)$/;
// Between the parts of a title: " - ", " – ", " — " (spaces needed, not to split "Wi-Fi"), and
// "|", "·", "•", "»" with or without spaces.
const SEPARATOR = /\s*[|｜·•»]\s*|\s+[-–—]\s+/;
export const MAX_NAME = 60;

/**
 * The name a group gets from its head tab: the first part of the page's title, without unread
 * counts, or the next part when the first is the site's own name ("GitHub - owner/repo"). Without a
 * title, the site. "(2) Comedy · freshrss.example" -> "Comedy", "Inbox (3) - Mail" -> "Inbox".
 */
export function autoName(tab) {
  const url = tab?.url || tab?.pendingUrl || '';
  const host = hostOf(url);
  const title = oneLine(tab?.title);
  if (!title || title === url || /^[a-z][\w+.-]*:\/\//i.test(title)) return clip(host);
  const parts = title.replace(LEADING_COUNT, '').split(SEPARATOR)
    .map((part) => part.replace(TRAILING_COUNT, '').trim())
    .filter(Boolean);
  if (!parts.length) return clip(host);
  const site = new Set(host.split('.').slice(0, -1));
  const own = parts.length > 1 && site.has(squash(parts[0]));
  return clip(own ? parts[1] : parts[0]);
}

const squash = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function clip(text) {
  if (text.length <= MAX_NAME) return text;
  const cut = text.slice(0, MAX_NAME - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_NAME / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The colour of every unit of one window, as a Map from its head, in display order: a top-level
 * head's unit has its tree's colour (`treeColors`, see tree.js); a nested one (mode 'innermost') its
 * own. A nested head that has a `groupColor` keeps it. Every other asks for the one it had when it
 * last headed a nested unit (`lastGroupColor`), and gets it if no tree or unit of the window has it.
 * The rest take the least used of NEW_TREE_COLORS that is neither their tree's colour nor that of the
 * unit just above or below them.
 */
export function unitColors(forest, nodes, units, treeColors) {
  const colors = new Map();
  const uses = new Map(TREE_COLORS.map((color) => [color, 0]));
  const take = (head, color) => {
    colors.set(head, color);
    uses.set(color, uses.get(color) + 1);
  };
  for (const color of treeColors.values()) uses.set(color, uses.get(color) + 1);
  const waiting = [];
  for (const unit of units) {
    if (!isNested(forest, unit)) colors.set(unit.head, treeColors.get(unit.head) ?? null);
    else if (isColor(nodes[unit.head]?.groupColor)) take(unit.head, nodes[unit.head].groupColor);
    else waiting.push(unit);
  }
  const rest = [];
  for (const unit of waiting) {
    const last = nodes[unit.head]?.lastGroupColor;
    if (isColor(last) && uses.get(last) === 0) take(unit.head, last);
    else rest.push(unit);
  }
  for (const unit of rest) {
    const i = units.indexOf(unit);
    const avoid = [treeColors.get(rootOf(forest, unit.head)), colors.get(units[i - 1]?.head), colors.get(units[i + 1]?.head)];
    let best = null;
    for (const color of NEW_TREE_COLORS) {
      if (!avoid.includes(color) && (best == null || uses.get(color) < uses.get(best))) best = color;
    }
    take(unit.head, best);
  }
  return new Map(units.map((unit) => [unit.head, colors.get(unit.head)]));
}

function rootOf(forest, id) {
  while (forest.parentOf.get(id) != null) id = forest.parentOf.get(id);
  return id;
}

/**
 * Store what unitColors decides for the nested units of one window: their heads get `groupColor`,
 * and any other tab that has one keeps it as `lastGroupColor`. Returns whether a node changed.
 */
export function storeUnitColors(forest, nodes, units, colors) {
  const nested = new Set(units.filter((unit) => isNested(forest, unit)).map((unit) => unit.head));
  let changed = false;
  for (const id of [...forest.order, ...forest.pinned]) {
    const node = nodes[id];
    if (!node) continue;
    if (nested.has(id)) {
      const color = colors.get(id);
      if (node.groupColor !== color || 'lastGroupColor' in node) {
        node.groupColor = color;
        delete node.lastGroupColor;
        changed = true;
      }
    } else if (node.groupColor != null) {
      node.lastGroupColor = node.groupColor;
      delete node.groupColor;
      changed = true;
    }
  }
  return changed;
}

/**
 * Plan the changes that make one window's native groups match its units. Arguments:
 *   tabs     the window's tabs: { id, index, groupId, active, pinned, title, url, pendingUrl }
 *   groups   the window's groups: { id, title, color, collapsed }
 *   forest   buildForest(tabs, nodes)
 *   units    groupUnits(forest, nodes, mode)
 *   colors   unitColors(...)
 *   owned    { groupId: head } for every window
 *   adopted  a Set of the owned groups the worker took over from the user
 *   policy   'leave' or 'regroup' (the setting `ownGroups`)
 *
 * Each unit keeps the group it owns. A group whose head heads no unit any more (it closed, or left
 * the tree) carries on with the unit that holds most of its tabs, so that the subtree that carries on
 * a closed tree's colour carries on its group too. A unit without a group takes over a foreign group
 * that holds exactly its tabs, and keeps that group's name and colour; after a reload or a restart
 * (`hadGroup`) also the group its head is in, unless another unit's head is in it too. With the
 * policy 'leave', a unit with a tab in a foreign group gets no group (and lets go of the one it had);
 * with 'regroup' its tabs leave those groups. Owned groups that no unit takes are dissolved, except
 * those taken over from the user: they are let go of as they are, the user's again.
 *
 * In the modes that stack groups (see stacksGroups), a tab that belongs in another of the worker's groups is not taken
 * out of its group first: grouped from there, a new group goes right after the rest of that group (see the 'group'
 * operation), which is where a unit that left its parent's unit belongs. And a group whose head heads no unit any more
 * carries on with the first unit whose head is in it, if there is one, so that the units below make theirs after it;
 * never with a head that lies before it with only tabs of its own subtree between, some not of its unit, which it would
 * jump over to join it: that one makes a new group where it is.
 *
 * Returns the operations, in order:
 *   { type: 'own', groupId, head }                     the group carries on with this head
 *   { type: 'adopt', groupId, head, foreign, title, color, collapsed }
 *                                                      a group becomes the head's: a foreign one (its
 *                                                      name, colour and collapsed state go into the
 *                                                      tree), or its own from before (`hadGroup`)
 *   { type: 'release', groupId }                       no unit keeps the group: dissolved by the
 *                                                      'ungroup' that follows, or, if taken over
 *                                                      from the user, theirs again as it is
 *   { type: 'ungroup', tabIds }
 *   { type: 'group', groupId, head, tabIds }           groupId null: a new group for the head
 *   { type: 'update', groupId, head, props }           groupId null: the group made just before
 */
export function planGroups({ tabs, groups, forest, units, colors, nodes, owned, adopted = new Set(), policy, mode = 'trees' }) {
  const ops = [];
  const stack = stacksGroups(mode);
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const members = new Map(); // group id -> its tab ids, in strip order
  for (const tab of [...tabs].sort(byIndex)) {
    if (!groupById.has(tab.groupId)) continue;
    if (!members.has(tab.groupId)) members.set(tab.groupId, []);
    members.get(tab.groupId).push(tab.id);
  }
  const ownedHere = new Map(); // owned groups of this window: id -> head
  for (const [id, head] of Object.entries(owned)) {
    if (groupById.has(Number(id))) ownedHere.set(Number(id), head);
  }
  const live = units.filter((unit) => !unit.optedOut);
  const groupOf = new Map(); // head -> group id
  const claimed = new Set();
  const takenOver = new Map(); // head -> the foreign group it takes over in this pass
  const claim = (head, id) => {
    groupOf.set(head, id);
    claimed.add(id);
  };

  for (const unit of live) {
    for (const [id, head] of ownedHere) {
      if (head === unit.head && !claimed.has(id)) {
        claim(unit.head, id);
        break;
      }
    }
  }
  const strip = [...tabs].sort(byIndex).map((tab) => tab.id);
  for (const [id] of ownedHere) {
    if (claimed.has(id) || adopted.has(id)) continue; // the user's group goes back to them instead
    const inGroup = new Set(members.get(id));
    let best = null;
    let most = 0;
    // When the mode stacks groups, the first unit whose head is in the group takes it, if there is one: were a unit below
    // it to take the group, the one above would make its new group out of that group, and so after it.
    const topmost = stack ? live.find((unit) => !groupOf.has(unit.head) && inGroup.has(unit.head)) : null;
    for (const unit of topmost ? [topmost] : live) {
      if (groupOf.has(unit.head)) continue;
      const count = unit.tabs.filter((tab) => inGroup.has(tab)).length;
      if (count > most) {
        best = unit;
        most = count;
      }
    }
    // Nor does a head that lies before the group with only tabs of its own subtree between, some of them not of its
    // unit: it would jump over those to join the group, which would leave them before its group. It gets a new group
    // where it is. (Tabs of its unit join the group with it.)
    if (best && stack && !inGroup.has(best.head)) {
      const between = strip.slice(strip.indexOf(best.head) + 1, strip.indexOf(members.get(id)[0]));
      const own = new Set(subtree(forest, best.head));
      if (between.some((tab) => !best.tabs.includes(tab)) && between.every((tab) => own.has(tab))) best = null;
    }
    if (best) {
      claim(best.head, id);
      ops.push({ type: 'own', groupId: id, head: best.head });
    }
  }
  const heads = new Set(live.map((unit) => unit.head));
  for (const unit of live) {
    if (groupOf.has(unit.head)) continue;
    const id = tabById.get(unit.head)?.groupId;
    if (!groupById.has(id) || claimed.has(id) || ownedHere.has(id)) continue;
    const inGroup = members.get(id);
    const within = inGroup.every((tab) => unit.tabs.includes(tab));
    // A group it had before a reload or restart is its own again, as it is (what the nodes say wins), unless another
    // unit's head is in it: tabs that are not the unit's leave it below. A foreign one brings its name, colour and
    // collapsed state into the tree.
    // (With tabs not of the unit in it, only if it still has the name and colour it had: not a group of the user's that
    // the head went into just before the reload.)
    const had = nodes[unit.head]?.hadGroup;
    const { title: was, color: wasColor } = typeof had === 'object' ? had : {};
    const same = had === true || (groupById.get(id).title === was && groupById.get(id).color === wasColor);
    const before = !!had && (within || same) && !inGroup.some((tab) => tab !== unit.head && heads.has(tab));
    if (before || (within && inGroup.length === unit.tabs.length)) {
      claim(unit.head, id);
      const { title, color, collapsed } = groupById.get(id);
      if (!before) takenOver.set(unit.head, groupById.get(id));
      ops.push({ type: 'adopt', groupId: id, head: unit.head, foreign: !before, title, color, collapsed });
    }
  }

  // Which group each tab should be in: tab id -> group id, or null for a group still to be made. The worker's
  // groups are those it owns, but one it took over from the user and no unit keeps is the user's again (unless its
  // unit's head opted out: the user asked for it to be ungrouped).
  const optedOut = new Set(units.filter((unit) => unit.optedOut).map((unit) => unit.head));
  const handBack = (id) => adopted.has(id) && !claimed.has(id) && !optedOut.has(ownedHere.get(id));
  const ours = new Set([...ownedHere.keys(), ...claimed].filter((id) => !handBack(id)));
  const foreign = (id) => groupById.has(id) && !ours.has(id);
  const wanted = new Map();
  const grouped = [];
  for (const unit of live) {
    if (policy === 'leave' && unit.tabs.some((tab) => foreign(tabById.get(tab)?.groupId))) {
      groupOf.delete(unit.head); // its group, if it had one, is dissolved below
      continue;
    }
    grouped.push(unit);
    for (const tab of unit.tabs) wanted.set(tab, groupOf.get(unit.head) ?? null);
  }
  const kept = new Set(grouped.map((unit) => groupOf.get(unit.head)).filter((id) => id != null));
  for (const id of new Set([...ownedHere.keys(), ...claimed])) {
    if (!kept.has(id)) ops.push({ type: 'release', groupId: id });
  }
  const ungroupable = (id) => ours.has(id); // never a group handed back to the user
  // Tabs that are in a group they do not belong in leave it first: those of the worker's groups that belong in no
  // group or in another, and (policy 'regroup') those of the user's groups that belong in one of the worker's.
  // Grouping them straight away would put a new group after the rest of the group they are in, away from where they
  // are. The browser takes tabs out one at a time; a tab at an end of the group stays where it is, and one in the middle
  // goes just before the group if it is in its first half, or else just after it. So: ends first (from the ends
  // inwards), then, in the first half, the leftmost (each lands after the ones before it), and in the second half the
  // rightmost (each lands before the ones after it): all of them keep their order.
  // (Not when the mode stacks groups: there only those that belong in no group of the worker's leave theirs first.)
  for (const [id, list] of members) {
    const rest = [...list];
    const away = (tab) => (stack ? !wanted.has(tab) : wanted.get(tab) !== id);
    const loose = new Set(rest.filter((tab) => (ours.has(id) ? away(tab) : !stack && wanted.has(tab))));
    if (ours.has(id) && !ungroupable(id)) continue;
    const order = [];
    while (loose.size) {
      const half = Math.floor(rest.length / 2);
      const tab = [rest[0], rest.at(-1)].find((t) => loose.has(t))
        ?? rest.find((t, i) => i < half && loose.has(t))
        ?? rest.findLast((t, i) => i >= half && loose.has(t));
      order.push(tab);
      loose.delete(tab);
      rest.splice(rest.indexOf(tab), 1);
    }
    if (order.length) ops.push({ type: 'ungroup', tabIds: order });
  }

  // The new look of each group goes last, once every tab is in its group: so that no group collapses while it still
  // holds a tab, the active one say, that is on its way to another group (if a step fails, the rest waits). When the
  // mode stacks groups, the units go in reverse: a new group lands just after the rest of the group its leftmost tab is
  // in, before any made from that group earlier in the pass, so the last made comes first.
  const updates = [];
  for (const unit of stack ? [...grouped].reverse() : grouped) {
    const id = groupOf.get(unit.head) ?? null;
    const missing = unit.tabs.filter((tab) => id == null || tabById.get(tab)?.groupId !== id);
    if (missing.length) ops.push({ type: 'group', groupId: id, head: unit.head, tabIds: id == null ? unit.tabs : missing });
    const taken = takenOver.get(unit.head);
    const want = taken ? { title: taken.title || autoName(tabById.get(unit.head)), color: taken.color, collapsed: taken.collapsed } : {
      title: unitTitle(nodes, unit.head, tabById.get(unit.head)),
      color: colors.get(unit.head),
      collapsed: unitCollapsed(forest, nodes, unit),
    };
    const have = id == null ? null : groupById.get(id);
    const props = {};
    for (const key of ['title', 'color', 'collapsed']) {
      if (want[key] != null && have?.[key] !== want[key]) props[key] = want[key];
    }
    if (Object.keys(props).length) updates.push({ type: 'update', groupId: id, head: unit.head, props });
  }
  return [...ops, ...updates];
}

/**
 * A tab leaves its tree, as when it closes (see removeNode in tree.js): its children move up into
 * its place and are handed its tree colour, and its place as its parent's first link (see
 * handOnFirstLink); it becomes a top-level tab and keeps its own tree colour, if it had one, as
 * `lastColor`. (Dragged out of its group in the tab strip.) Its children in `withIt` (tabs that left
 * together with it) stay its children.
 */
export function leaveTree(nodes, id, withIt = null) {
  const node = nodes[id];
  if (!node) return;
  const color = colorOf(node);
  const kids = [];
  for (const key in nodes) {
    const child = nodes[key];
    if (child.parent !== id || withIt?.has(Number(key))) continue;
    child.parent = node.parent;
    if (color && child.heir == null) child.heir = color;
    kids.push(Number(key));
  }
  handOnFirstLink(nodes, node.parent, id, kids);
  node.parent = null;
  rememberColor(node);
}

/**
 * A tab joins the tree of a unit whose group the user put it in, where it now is in the tab strip
 * (`tabs`: the window's tabs, with their current indexes): as the sibling just before the next tab of
 * the unit, or, after the last one, as the sibling just after it, or, next to the head, as the head's
 * first child. It leaves its own tree first (see leaveTree): only that tab moved in the tab strip. In mode
 * 'branches' it does not become a further link of a branch's head (a unit of its own): it goes under the
 * head's first link instead.
 */
export function joinTree(tabs, nodes, id, head, mode = 'trees') {
  leaveTree(nodes, id);
  const forest = buildForest(tabs, nodes);
  if (!forest.parentOf.has(head) || !forest.parentOf.has(id)) return;
  const unit = new Set(subtree(forest, head));
  const index = new Map(tabs.map((tab) => [tab.id, tab.index]));
  const strip = [...unit, id].filter((tab, i, all) => all.indexOf(tab) === i).sort((a, b) => index.get(a) - index.get(b));
  const at = strip.indexOf(id);
  const next = strip[at + 1];
  const prev = strip[at - 1];
  let parent = head;
  if (next != null && next !== head) parent = forest.parentOf.get(next) ?? head;
  else if (prev != null && prev !== head) parent = forest.parentOf.get(prev) ?? head;
  if (parent === id) parent = head;
  const up = forest.parentOf.get(head);
  if (mode === 'branches' && parent === head && up != null && forest.parentOf.get(up) == null) {
    parent = firstLink(forest, head, nodes) ?? head;
  }
  nodes[id].parent = parent;
}
