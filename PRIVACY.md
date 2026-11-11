# Privacy policy

Vertical Tree Tabs, a browser extension for Chrome and Microsoft Edge.

Effective: 11 November 2026.

## In short

Vertical Tree Tabs does not collect, send, sell or share any of your data. It has no servers, no
accounts, no analytics and no ads, and it makes no network requests. Everything it keeps stays in
your browser profile, on your device.

## What it reads, and why

To show your tabs as a tree in the side panel, and to mirror the trees as tab groups, the
extension reads, while it runs:

- the titles, addresses (URLs) and site icons of your open tabs (the `tabs` and `favicon`
  permissions);
- which tab a link was opened from (the `webNavigation` permission);
- your tab groups: their names, colours and which tabs are in them (the `tabGroups` permission).

It does not read the content of the pages you visit, and has no access to them.

## What it keeps, and where

In your browser's extension storage (`chrome.storage`), on your device only:

- the tree: which tab is under which, which trees are collapsed, the trees' colours, and the names
  you gave their tab groups;
- a snapshot used to rebuild the tree after the browser restarts: the addresses of the tabs open in
  your normal windows (never those of private or incognito windows), their places in the tree, and
  the names and colours of their tab groups;
- your settings.

The snapshot is replaced as you browse. Removing the extension deletes everything it stored. None
of it is synced to other devices.

## Sharing

None. No data leaves your device, and no one else, the author included, receives any of it.

## Chrome Web Store user data policy

The use of information received from the browser's extension APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies),
including the Limited Use requirements: the data is used only to provide the extension's single
purpose, showing and organising your tabs, and is never transferred, sold, or used for any other
purpose.

## Changes

Any change to this policy will be published in this repository, with a new effective date.

## Contact

Questions: open an issue at
[github.com/oshri-almog/VerticalTreeTabs/issues](https://github.com/oshri-almog/VerticalTreeTabs/issues).
