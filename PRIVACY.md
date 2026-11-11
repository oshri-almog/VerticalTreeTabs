# Privacy policy

Vertical Tree Tabs, a browser extension for Chrome and Microsoft Edge.

Effective: 11 November 2026.

## In short

Vertical Tree Tabs reads the titles and addresses of your open tabs, and keeps them on your
device, only to show your tabs as a tree and to keep that tree. It sends, sells and shares none of
it: it has no servers, no accounts, no analytics and no ads. The only things it loads from the web
are the site icons of your open tabs, from the addresses the pages give for them, as the browser's
tab strip shows them.

## What it reads, and why

To show your tabs as a tree in the side panel, and to mirror the trees as tab groups, the
extension reads, while it runs:

- the titles, addresses (URLs) and site icons of your open tabs (the `tabs` and `favicon`
  permissions);
- which tab a link was opened from (the `webNavigation` permission);
- your tab groups: their names, colours, whether they are collapsed, and which tabs are in them
  (the `tabGroups` permission).

It does not read the content of the pages you visit, and has no access to them.

## What it keeps, and where

In the browser's memory while it runs (`chrome.storage.session`), gone when the browser closes or
the extension is reloaded or updated:

- the tree: which tab is under which, which trees are collapsed, the trees' colours, and the names
  you gave their tab groups;
- the name, colour and collapsed state of each tab group.

In your browser profile, on your device (`chrome.storage.local`):

- a snapshot, to rebuild the tree after the browser restarts or the extension is reloaded: the
  addresses of the tabs open in your normal windows (never those of private or incognito
  windows), their places in the tree, and the names and colours of their tab groups (names that
  are mostly taken from the pages' titles). It is replaced as you browse; the last one stays until
  the next one replaces it;
- the same for up to ten windows you closed while the browser kept running, so that one you
  reopen gets its tree back; the oldest is dropped as others close, and one is dropped once it is
  back;
- your settings.

None of it is synced to your other devices.

## Your controls

What it keeps is what its panel shows you: your tabs, their places in the tree, the trees' colours
and their groups' names. Its settings choose how tabs are grouped, or turn the groups off. Closing
tabs and windows lets their part of the tree go (a closed window's tree is kept for when you reopen
it, until ten other windows have closed since).

## Removing the extension

Removing the extension deletes everything it stored. The tab groups it made are the browser's
own: they stay, and the browser keeps them (and, with sync on, may sync them) like any group. To
have them ungrouped, choose **No groups** in the extension's settings before removing it.

## Sharing

None. Nothing about you leaves your device through the extension, and no one, the author
included, receives any of it.

## Chrome Web Store user data policy

The use of information received from the browser's extension APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies),
including the [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
requirements: the data is used only for the extension's single purpose, showing and organising
your tabs, and is never transferred, sold, or used for any other purpose.

## Changes

Any change to this policy will be published in this repository, with a new effective date.

## Contact

Questions: open an issue at
[github.com/oshri-almog/VerticalTreeTabs/issues](https://github.com/oshri-almog/VerticalTreeTabs/issues).
