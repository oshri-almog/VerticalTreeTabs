# Vertical Tree Tabs

A Chrome and Microsoft Edge extension that lists your tabs vertically in the side panel, as a
tree: every tab you open from a link sits under the tab you opened it from.

Search on Google and middle-click five results: the five tabs appear under the search tab.
Open links from one of those results and they appear under that result, one level deeper.
Each tree is also a tab group in the tab strip, in the tree's colour (see [Tab groups](#tab-groups)).

<p>
  <img src="docs/sidepanel-light.png" alt="The side panel in the light theme" width="320">
  <img src="docs/sidepanel-dark.png" alt="The side panel in the dark theme" width="320">
</p>

## Features

- **Tabs as a tree**, built as you browse: a tab opened from a link goes under the tab it came
  from ([How the tree is built](#how-the-tree-is-built)).
- **A colour for every tree**, with lighter and darker shades for the trees inside it; change it
  from the right-click menu ([Colours](#colours)).
- **Native tab groups** that mirror the trees, named after their top page, at the level you pick:
  one group per tree, per innermost subtree, per page or per branch, or none
  ([Tab groups](#tab-groups)).
- **Folders**: named tabs with an icon that hold the tabs you put in them, as a tree's top; make
  one from a tab's menu or with **Alt+B**, drop tabs into it, and open its tab to see and rename
  it ([Folders](#folders)).
- **Collapse and expand** trees; a collapsed tree shows how many tabs it hides, and collapses its
  tab group too.
- **Drag and drop** a tab with its subtree to rearrange it, nest it, or move it to another
  window; the real tabs move with it. Hold **Ctrl** as you start to drag a tab alone.
- **Select several tabs** with Ctrl+click and Shift+click (the tab strip selects them too), then
  move, close, group, pin or reload them together ([Selecting tabs](#selecting-tabs)).
- **A right-click menu** for each tab: new tabs as a child or next to it, folders, reload,
  duplicate, pin, mute, the group's name and colour, your own groups, collapse or expand, move to
  the top level, to a folder or to another window, close children, the tree or the group.
- **Where new tabs go, and what happens when tabs close**, as you choose: New Tab pages, links
  and bookmarks by the current tab; a closed tab's first child in its place; the tree picking the
  next tab; a closed tab you reopen back under its parent ([Settings](#settings)).
- **Find a tab in any window** with **Alt+G**, and **search** the panel by words or a regular
  expression, which keeps each match's parents in view; **keyboard** control of the whole tree
  ([Using the panel](#using-the-panel)).
- **Your own tab groups** show in the panel, with their colour and name, and the menu makes,
  renames, recolours, moves and closes them.
- **Pinned tabs** as icons above the tree, which you can drag to reorder; a **speaker** on tabs
  that play sound, to mute or unmute them; a dot on **unread** tabs, opened in the background and
  not looked at yet.
- **Light and dark** themes, following the browser or as you choose, with compact or roomy rows,
  three text sizes and indents, and **your own colours**.
- **Keyboard shortcuts** for the tree, from anywhere in the browser ([Keyboard shortcuts](#keyboard-shortcuts)).
- **Kept across restarts and closed windows**: the tree, its colours, collapsed trees and group
  names come back after the extension reloads, the browser restarts, or a window you closed is
  reopened ([What is kept, and where](#what-is-kept-and-where)).
- **Private**: no server, no account, no analytics; what it keeps stays in your browser
  ([Privacy](PRIVACY.md)).

## Install

The extension is not in the browser stores yet; install it from this repository. It needs
Chrome 116 or later, or Microsoft Edge (tested with Edge 156 and 157).

1. **Get the code.** On this repository's page, click **Code → Download ZIP** and unzip it, or
   clone it:

   ```bash
   git clone https://github.com/oshri-almog/VerticalTreeTabs.git
   ```

2. **Open the extensions page.**
   - Chrome: go to `chrome://extensions` and turn on **Developer mode** (top right).
   - Edge: go to `edge://extensions` and turn on **Developer mode** (in the left-hand menu).
3. Click **Load unpacked** and choose the [`extension`](extension) folder inside the unzipped
   folder (the one that holds `manifest.json`).
4. **Put it in the toolbar** (Chrome: the puzzle-piece icon → pin; Edge: the Extensions button →
   the eye icon, **Show in toolbar**), then click its icon, or press **Alt+T**, to open the panel.
   To change the shortcut, go to `chrome://extensions/shortcuts` (Edge:
   `edge://extensions/shortcuts`), or use **⋯ → Keyboard shortcuts…** in the panel (see [Keyboard shortcuts](#keyboard-shortcuts)).
5. Loading it unpacked asks for nothing; its **Details** page lists what it may do: "Read your
   browsing history" and "View and manage your tab groups". See [Permissions](#permissions) for
   why.
6. To use it in incognito (InPrivate) windows too, turn on **Allow in incognito** (Edge: **Allow
   in InPrivate**) on its Details page.

Keep the folder where it is: the browser loads the extension from it each time.

**To update**, replace the folder's contents with the new version (download it again, or
`git pull`), then press the reload button on the extension's card on the extensions page. The
tree is kept.

**To remove it**, click **Remove** on its card on the extensions page; then you can delete the
folder. The tab groups it made are the browser's own and stay: to have them ungrouped, choose
**No groups** in its Settings first.

## How the tree is built

- A tab opened **from a page** becomes a child of that page's tab: middle-click, Ctrl+click,
  a link that opens in a new tab, **Open link in new tab**, or `window.open`.
- Following a link **inside** a tab doesn't move it.
- Tabs that weren't opened from a page start at the top level: Ctrl+T, the New Tab button,
  bookmarks, Alt+Enter in the address bar. (Chrome reports the active tab as the "opener" of
  those too, so the extension listens for link-opened tabs specifically instead.) A tab the
  browser opens inside one of the trees' tab groups (its **New tab in group**, say) joins that
  tree.
- Opening a link from a collapsed tab expands it, so that the new tab shows.
- **Closing** a tab moves its children up one level, into its place. To close a whole tree,
  right-click its top tab → **Close tree**: on a tab inside a tree, **Close tree** closes that tab
  and the tabs under it, and **Close children** closes every tab under it.
- **Pinned** tabs appear as icons above the tree and are not part of it; their children
  move up one level, into the pinned tab's place, until it is unpinned.
- Tabs already open when you install the extension start flat, since the browser can't say
  which tab opened them.

## Colours

Every tree gets a colour, like a tab group: the arrow of the tab at the top becomes a
coloured chip, and a line in that colour runs down beside the tabs in the tree. A tree inside
a tree is drawn in a lighter shade of the same colour, and the tree inside that in a lighter
one still (in the light theme: darker); deeper levels go back and forth between those two
shades. A single tab (a top-level tab without children) and a pinned tab have no colour.

- A new tree takes a colour that no other tree in the window has, out of eight (the ninth, grey,
  only when you pick it). With more trees colours repeat, but a new one never takes the colour of
  the tree just above or below it.
- A tree keeps its colour while you rearrange it in its window, collapse or search, and after
  the extension reloads or the browser restarts. To change a tree's colour, right-click any
  tab in it and click a colour.
- Moved to another window, a tree keeps its colour unless a tree there already has it; then
  it takes another (with eight trees there already, it may keep its own).
- Close the tab at the top of a tree, or pin it, and its children move up into its place: the
  first subtree among them carries on in the tree's colour, and the others become trees with
  new colours. A subtree whose top tab headed a tree of its own before takes that colour back
  if it is free, and the next subtree carries on instead. With more than eight trees in the
  window, the colour goes to the first subtree that has no tree of that colour next to it, and
  the others take colours as new trees do, which can repeat those of trees further away, the
  tree's own included.
- A tab that stops heading a tree (its last child closed, it was pinned, or it was dragged
  into another tree) gets its colour back when it heads one again, unless another tree has
  taken it in the meantime.
- A colour only comes back or carries on if no other tree has it, or, in a window with more
  than eight trees, if neither tree next to it has it. So with up to eight trees, a colour you
  picked for two trees is not carried on when the top tab of one of them closes.

## Tab groups

Every tree is also a tab group in the browser's tab strip, in the tree's colour (the panel's
colours are the nine colours of tab groups). The group is named after the page at the top of the
tree, cut to its gist: "(2) Comedy · freshrss…" becomes "Comedy", "Inbox (3) - Mail" becomes
"Inbox". The name shows next to the tree's top tab in the panel.

- To rename a group, right-click any tab of its tree in the panel and type in the name field
  (Enter, or clicking away, keeps the name; Esc doesn't), or right-click the group's name in the
  tab strip. An empty name brings back the automatic one. With a group per innermost subtree, page
  or branch, a tab in a nested group offers that group's name and colour: right-click the tree's
  top tab for the tree's. A tree without a group, or in one of your own groups, has no name field.
- Colours go both ways: a colour picked in the panel colours the group, and one picked for the
  group in the tab strip colours the tree.
- Collapsing a tree in the panel collapses its group too, even the group of the tab you are on:
  if that tab is below the tree's top, you move to the top tab, which stays the active tab, hidden
  in the tab strip (with groups off too, collapsing the tree you are in moves you to its top).
  Collapsing or expanding the group in the tab strip does the same to the tree (Edge keeps you on
  your tab when you collapse its group; if it is below the top, the extension moves you to the
  top tab). The browser opens a collapsed group by itself when you switch to one of its tabs: the
  extension closes it again if the tree is still collapsed.
- Dragging a tab out of a group in the tab strip takes it out of its tree (its children move up
  into its place); dragging one into a group puts it into that group's tree, where it lands. Tabs
  taken out together stay together, out of the groups. "Ungroup" in the tab strip leaves the tree
  as it is, without a group, until you pick "Group in tab strip" in its right-click menu in the
  panel.
- A tree that ends (all but one of its tabs closed, say) loses its group, and a tree moved to
  another window gets its group there.

Settings (⋯ menu → Settings…):

- **One group per tree** (the default), **one group per innermost subtree**, **one group per
  page**, **one group per branch**, or **no groups**.
  An innermost subtree is a tab and the tabs opened from it, as long as none of those has tabs of
  its own: each gets a colour of its own, in the panel too, and its group breaks up once one of
  its tabs opens a tab. The tabs above such subtrees are in no group.
  With one group per page, a tab and the tabs opened from it share a group. When one of those
  opens a tab, it moves out of the group, to just after its end, and leads a new group with the
  tab it opened; the group it left stays. One group per branch does that for the tabs opened from
  a tree's top tab only: the new group then holds the tab, the first tab it opened and everything
  later opened inside that branch, and each further tab it opens starts a group of its own, right
  after the branch's group (the newest first). A tab you add under it yourself ("New tab as
  child", or one dropped under it in the panel) counts as one it opened: a further tab, unless it
  came first. In both, each group has a colour of its own, and the panel still shows every tab in
  its place in the tree.
- **Tab groups you made yourself**: **leave them alone** (the default), or **regroup them by
  tree**. Left alone, a tree with tabs in one of your groups gets no group, and one of your groups
  that holds exactly one tree becomes that tree's group, keeping its name and colour: the extension
  never ungroups it unless you ask (and when the tree ends, it is yours again, as it is). A tree
  dropped in the panel between two tabs of one of your groups lands just beside the group;
  dropped as a child of one of that group's tabs, it joins the group.

## Using the panel

| To | Do |
| --- | --- |
| Switch to a tab | Click it |
| Close a tab | Middle-click it, or click its × |
| Collapse or expand a tree | Click the arrow. A collapsed tree shows how many tabs it hides; collapsing the tree you are in moves you to its top tab |
| Rearrange | Drag a tab with its subtree. Drop on the top quarter of a tab to go before it, on its middle to become its last child, on its bottom quarter to go after it and the tabs under it (or, if its children are showing, to become its first child), or below the list to go to the end, at the top level. Drag to another window's panel to move it there |
| Use a tab's link elsewhere | Drag its row out of the panel, onto the bookmarks bar, say |
| Move a tab without its children | Hold Ctrl (⌘ on a Mac) as you start dragging it: the tabs under it stay where they were |
| Close a tab with the tabs under it | Ctrl+click its ×, or right-click → Close tree |
| Change a tree's colour | Right-click a tab in it and click a colour |
| Rename a tree's tab group | Right-click a tab in it and type in the name field |
| Mute or unmute a tab | Click the speaker on its row (it shows while the tab plays sound, crossed out while muted) |
| Everything else | Right-click: New tab as child or below, Reload, Duplicate, Pin, Mute, New folder, Move to new folder or to a folder, group name, tree colour, Ungroup/Group in tab strip, your own groups, Collapse/Expand tree, Move to top level, Move tree to new window or to another window, Close children, Close tree, Close group, Close tab. Items with › open a list of their own; ‹ Back returns |
| Use a pinned tab | Click its icon above the tree to switch to it, middle-click to close it, drag it onto another to reorder them; right-click for Reload, Duplicate, Unpin, Mute, Move to new window, Close tab |
| Collapse or expand all | ⋯ menu at the top |
| Go to a folder or a tab group | ⋯ menu at the top → Folders and groups… |
| Change the settings | ⋯ menu at the top → Settings… |
| Change the keyboard shortcuts | ⋯ menu at the top → Keyboard shortcuts… |
| Find a tab | Type in the search box: tabs whose title, address or group name has every word show with their parents, in collapsed trees too (pinned tabs aren't searched); a tab that only its address matched shows its address. Click **.\*** to search by a regular expression instead. ↓ moves to the results, Enter switches to the first match, Esc clears. While you search, the tabs can't be dragged. To find a tab in any window, use the button beside the search box, or Alt+G |
| Use the keyboard | ↑ ↓ move, Home and End go to the first and last tab, ← → collapse/expand or go to the parent/child, Enter or Space switches, Delete closes, the Menu key opens the right-click menu, Esc ends a selection, Ctrl+F (or /) goes to the search box. In that menu: ↑ ↓ Home End move, ← → move among the colours and icons, → opens a › list and ← goes back, Esc closes |
| Open a tab | **New tab** under the list, or double-click or middle-click the empty space: with Shift held, as the current tab's first child; with Ctrl, as its last child; with Alt, next to it |

### Selecting tabs

Ctrl+click (⌘ on a Mac) a tab to add it to the selection or take it out, and Shift+click to select
the tabs from the one you clicked last to this one, as the panel shows them. The tab strip selects
them too, and the current tab is always one of them. A plain click or Esc ends the selection.

Right-click a selected tab for the menu of the selection: reload, duplicate, pin, mute, put them
in a new tab group or one of yours, move them to a new folder, a folder or another window, close
them. Drag a selected tab to move them all, each with the tabs under it. Closing several tabs at
once (5 or more, as the settings say) asks first.

## Folders

A folder is a tab of its own, showing the extension's folder page: its name, an icon, and the
tabs under it in the tree, which you can switch to or close from there. In the panel it is a row
in bold with its icon, and the tabs you put in it sit under it, as under any tab: collapse it,
drag it, move it to another window, give its tree a colour, and its tree's tab group takes its
name.

- **Make one**: right-click a tab → **Move to new folder** puts the tab, with the tabs under it,
  in a new folder where it was; select several tabs first to put them all in it. **Alt+B** does
  the same for the current tab or the tabs selected in the tab strip. **New folder** (in a tab's
  menu, or the ⋯ menu) makes an empty one, ready to be named.
- **Put tabs in it**: drag them onto it, or right-click → **Move to folder ›**.
- **New tab in it**: the **+** on its row (with Ctrl, as its first tab), or the button on its page.
- **Name it and pick its icon**: in its right-click menu, or on its page (any emoji will do).
- **Close it**: its tabs move up a level and stay open. **Close tree** closes it with them.

The folder's name and icon are kept in its tab's address, so the browser brings it back with the
rest of your tabs; after an extension update the extension brings back any folder the browser
closed. Folders can't be made in incognito windows.

## Keyboard shortcuts

Set or change them at **chrome://extensions/shortcuts** (Edge: edge://extensions/shortcuts), or
from the panel's ⋯ menu → Keyboard shortcuts…. The settings page lists them as they are set.

| Shortcut | Does |
| --- | --- |
| Alt+T | Open the panel |
| Alt+G | Find a tab in any window |
| Alt+B | Move the current tab (or the selected tabs) into a new folder |
| Alt+A | A new tab next to the current tab, after the tabs under it |
| (not set) | New tab as child; collapse or expand the current tree; collapse all; expand all; move the current tab to the top level; move its tree to a new window; close its tree; duplicate it |

## Settings

The ⋯ menu → **Settings…** opens them in a tab, one category at a time. Each setting says what it
does, the choices that move tabs around show it on a small example tree (point at a choice to see
it there), and every change is saved at once.

- **Tab groups**: how the trees are grouped in the tab strip (see [Tab groups](#tab-groups)), and
  what happens to the groups you make yourself.
- **New tabs**: where a New Tab page and a tab opened from a bookmark go (at the top level, as the
  browser puts them, after the current tab's tree, next to the current tab, or under it); where a
  tab opened from a link goes among its page's tabs (where the browser puts it, first or last);
  whether a tab opened from a bookmark in the background becomes the current tab; and what the
  New tab button does (a tab at the end, or after the current tab's tree, or no button).
- **Closing tabs**: a closed tab's tabs move up a level, or the first of them takes its place;
  when the current tab closes, the browser picks the next tab, or the tree does (its first child,
  else the next tab at its level, else the one above it, else its parent); and from how many tabs
  closing them at once in the panel asks first (2, 5 or 10, or never). A tab you close and reopen
  (Ctrl+Shift+T, History) goes back under the tab it was under, for half an hour after it closed.
- **Mouse & dragging**: a tab dropped onto another goes under it last or first; a click on the
  current tab's row (or a double-click on any) can collapse or expand its tree; a tab you move in
  the tab strip keeps its place in the tree, or takes the place of the tab after it.
- **Appearance**: the theme (the browser's, light or dark), row height, text size, indent, how
  unread tabs show (a dot, bold, or nothing), and whether the search box shows or waits for
  Ctrl+F, with a preview of the panel.
- **Colours**: the panel's background, text, current tab (in a gradient, if you like), hover and
  accent, with a preview; save sets of them by name.
- **Keyboard**: the keyboard shortcuts as they are set (**Change the keys…** opens the browser's
  page for them), and the keys of the panel itself.
- **Closed windows**: the windows whose trees the extension keeps, to open again or forget.

**New tab as child** opens the tab as the last child and switches to it; **Duplicate** puts the
copy right after the tab and the tabs under it; **Move to top level** puts the tab and its subtree
right after its tree. A row shows a spinner while its tab loads, a dimmed title while it sleeps,
and a highlight while it is selected in the tab strip; hover it for its title and address.

Rearranging in the panel also moves the real tabs in the browser's tab strip, so both stay in
the same order. The active tab is always kept visible: switching to a tab inside a collapsed tree
expands it, and so does a drop that would put it inside one (other tabs dropped into a collapsed
tree are tucked away in it). A collapsed tree stays collapsed when you move it, to another window
too, unless it would hide the active tab there.

## What is kept, and where

- The tree survives the extension's background worker being shut down while idle.
- After the extension is reloaded or updated, the tree is restored by tab id.
- After a browser restart (with "Continue where you left off"), the tree is rebuilt from a
  snapshot. Chrome gives every restored tab a new id, so tabs are matched by URL, window by
  window; Edge keeps the ids, so they are matched by id. A tab that can't be matched starts at
  the top level, and the children of a tab the browser didn't restore move up to its parent.
- A window you close while the browser keeps running keeps its tree too, and gets it back when
  it comes back: from **History → Recently closed**, with **Ctrl+Shift+T**, or when you reopen
  the browser after closing its last window, if it kept running in the background (Edge does by
  default, with **Startup boost**). The browser brings the window back with new tabs, which are
  matched by URL. The trees of the last ten windows closed this way are kept, and the settings
  page lists them, to open again or forget. A single tab you reopen with Ctrl+Shift+T or from
  History goes back under the tab it was under, if that is still open, for half an hour after it
  closed.
- Folders are kept by their tabs' addresses, which hold their names and icons.
- Tree colours are kept with the tree, and so is which trees are collapsed.
- Group names, and the trees you took out of the groups, are kept with the tree too. After a
  reload, a restart or a window's return, the trees take their groups back.
- While the browser runs, the tree is kept in its memory (`chrome.storage.session`), with the
  current tab of each window and the addresses of the last 30 tabs you closed (for half an hour,
  to put them back under their parent if you reopen them). The snapshot, the closed windows'
  trees, your settings and your own colours are saved in your browser profile
  (`chrome.storage.local`). They hold the addresses of your tabs, never those of incognito
  windows, and nothing of them is sent anywhere. See [PRIVACY.md](PRIVACY.md).

## Permissions

| Permission | The browser's warning | Why the extension needs it |
| --- | --- | --- |
| `tabs` | Read your browsing history | To show each tab's title, icon and address in the panel, to search them, to name groups after their pages, and to find tabs again by address after a restart or when a closed window comes back |
| `webNavigation` | (part of the one above) | To learn which tab a link was opened from, which places the new tab in the tree, and which new tabs were opened from a bookmark (for where those go) |
| `favicon` | (part of the one above) | To show a site's icon from the browser's own store of them when the page's icon can't be loaded |
| `tabGroups` | View and manage your tab groups | To make each tree a tab group, and to follow the changes you make to groups |
| `sidePanel` | (none) | To show the tree in the browser's side panel |
| `storage` | (none) | To keep the tree, its colours and your settings, and the snapshot of your open tabs' addresses for after a restart |

The extension has no access to the content of the pages you visit. It sends nothing anywhere: the
only things it loads from the web are the site icons of your open tabs, from the addresses the
pages give for them, as the tab strip shows them.

## Limitations

- Extensions can't hide the browser's horizontal tab strip, so the panel sits beside it.
- Each window's panel shows that window's tabs.
- The browser doesn't move tabs between a normal and an incognito window, so a tree dropped on
  the panel of the other kind of window stays where it is.
- Tab groups can't be nested: with one group per tree, a subtree is in its tree's group; with one
  group per innermost subtree, the tabs above those subtrees are in no group; with one group per
  page or per branch, a group comes right after the group of the tab that opened its first tab, so
  the tab strip shows the tree's levels one after another. Pinned tabs are in no group.
- The browser keeps every tab group in its list of saved groups, the extension's too (Chrome
  since version 133, Edge since 140). A tree's group leaves that list when the tree ends, but the
  groups of a window you close stay in the browser's Tab groups list, as yours do: delete them
  there.

## Development

```bash
npm install
```

```bash
npm test
```

runs the unit tests for the tree logic, the tab groups, the tree colours and their contrast in
both themes, and the restore after a restart (no browser needed).

```bash
npm run test:e2e
```

loads the extension into a headless Chromium and checks it the way a person would use it:
opening links in every way, collapsing, closing, dragging, the right-click menu, tree colours,
pinning, moving trees between windows, tab groups at every level, reloading the extension and
restarting the browser (`E2E_GROUPS=off` runs it with the tab groups off; the steps about groups
turn them on). It needs Chrome for Testing or Chromium, because branded Chrome no longer loads
unpacked extensions from the command line. It finds the copies that Puppeteer or Playwright
download. To use another build, Edge included, set `CHROME_PATH` to its executable. To get one:

```bash
npx @puppeteer/browsers install chrome@stable
```

`npm run icons` renders the PNG icons from [`extension/icons/icon.svg`](extension/icons/icon.svg),
and `npm run screenshots` regenerates the pictures above.

| Path | What it is |
| --- | --- |
| [`extension/`](extension) | The extension itself, the folder you load |
| [`extension/background.js`](extension/background.js) | Service worker: records which tab opened which, carries out moves and closes, keeps the tab groups in line, saves and restores the tree |
| [`extension/tree.js`](extension/tree.js) | Tree logic shared by the worker, the panel and the tests |
| [`extension/groups.js`](extension/groups.js) | Tab groups: which tabs share one, its name, colour and state, and the changes that make the browser's groups match |
| [`extension/restore.js`](extension/restore.js) | Rebuilding the tree from the saved snapshot |
| [`extension/sidepanel.html`](extension/sidepanel.html), [`.css`](extension/sidepanel.css), [`.js`](extension/sidepanel.js) | The panel |
| [`extension/options.html`](extension/options.html), [`.css`](extension/options.css), [`.js`](extension/options.js) | The settings page |
| [`test/`](test) | Unit tests, the end-to-end test and its browser harness |
| [`scripts/`](scripts) | Icon rendering, screenshots, locating a Chromium build |
| [`docs/PUBLISHING.md`](docs/PUBLISHING.md) | How to publish the extension on the Chrome Web Store and Microsoft Edge Add-ons |

## License

[MIT](LICENSE)
