# Privacy policy (Microsoft Edge)

Vertical Tree Tabs, an extension for Microsoft Edge.

Effective: 12 November 2026 (version 0.2.0).

## In short

Vertical Tree Tabs reads the titles and addresses of your open tabs, and keeps them on your
device, only to show your tabs as a tree in the Microsoft Edge sidebar and to keep that tree. It
sends, sells and shares none of it: it has no servers, no accounts, no analytics and no ads. The
only things it loads from the web are the site icons of your open tabs, from the addresses the
pages give for them, as the tab strip shows them.

## What it reads, and why

To show your tabs as a tree in the sidebar, and to mirror the trees as tab groups, the extension
reads, while it runs:

- the titles, addresses (URLs) and site icons of your open tabs;
- which tab a link was opened from, and whether a new tab was opened from a favorite;
- your tab groups: their names, colours, whether they are collapsed, and which tabs are in them.

It does not read the content of the pages you visit, and has no access to them.

## What it keeps, and where

In Microsoft Edge's extension storage, in memory while Edge runs (gone when Edge closes or the
extension is reloaded or updated):

- the tree: which tab is under which, which trees are collapsed, the trees' colours, the names
  you gave their tab groups, and which tabs are unread (opened in the background, not looked at
  yet);
- the name, colour and collapsed state of each tab group;
- the current tab of each window;
- the addresses of the last 30 tabs you closed in normal windows, each for half an hour, so that
  one you reopen goes back under the tab it was under.

In Microsoft Edge's extension storage in your browser profile, on your device:

- a snapshot, to rebuild the tree after Edge restarts or the extension is reloaded: the addresses
  of the tabs open in your normal windows (never those of InPrivate windows), their places in the
  tree, and the names and colours of their tab groups (names that are mostly taken from the pages'
  titles). It is replaced as you browse; the last one stays until the next one replaces it;
- the same for up to ten windows you closed while Edge kept running (with Startup boost, for
  example), so that one you reopen gets its tree back; the oldest is dropped as others close, and
  one is dropped once it is back;
- your settings, and the colours you chose for the sidebar.

A folder you make is a tab of its own, showing the extension's folder page; its name and icon are
in that tab's address, which Edge keeps with your other tabs.

None of it is synced to your other devices.

## Your controls

What it keeps is what its sidebar shows you: your tabs, their places in the tree, the trees'
colours and their groups' names. Its settings choose how tabs are grouped, or turn the groups off.
Closing tabs and windows lets their part of the tree go (a closed window's tree is kept for when
you reopen it, until ten other windows have closed since).

## Removing the extension

Removing the extension deletes everything it stored. The tab groups it made are Edge's own: they
stay, and Edge keeps them (and, with sync on, may sync them) like any group. To have them
ungrouped, choose **No groups** in the extension's settings before removing it.

## Sharing

None. Nothing about you leaves your device through the extension, and no one, the author
included, receives any of it.

## Changes

Any change to this policy will be published in the extension's repository, with a new effective
date.

## Contact

Questions: open an issue at
[github.com/oshri-almog/VerticalTreeTabs/issues](https://github.com/oshri-almog/VerticalTreeTabs/issues).
