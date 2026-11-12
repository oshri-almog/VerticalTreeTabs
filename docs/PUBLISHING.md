# Publishing Vertical Tree Tabs

How to put the extension on the **Chrome Web Store** (Google) and on **Microsoft Edge Add-ons**,
with everything to upload and every text to paste. Checked against the stores' own documentation
in November 2026; the stores change their forms now and then, so follow what the dashboard asks.

## What is ready

| What | Where |
| --- | --- |
| The package to upload | `dist/VerticalTreeTabs-<version>.zip` (see [Build the package](#build-the-package)) |
| Screenshots, 1280 x 800 | [`store/screenshot-1-tree.png`](../store/screenshot-1-tree.png), [`-2-groups`](../store/screenshot-2-groups.png), [`-3-settings`](../store/screenshot-3-settings.png), [`-4-dark`](../store/screenshot-4-dark.png) |
| Small promotional tile, 440 x 280 | [`store/promo-440x280.png`](../store/promo-440x280.png) |
| Marquee / large tile, 1400 x 560 (optional) | [`store/marquee-1400x560.png`](../store/marquee-1400x560.png) |
| Store icon, 128 x 128 with 16 px of padding | [`store/icon-128.png`](../store/icon-128.png) |
| Logo, 300 x 300 (Edge) | [`store/logo-300.png`](../store/logo-300.png) |
| Privacy policy, Chrome Web Store | [`PRIVACY.md`](../PRIVACY.md): `https://github.com/oshri-almog/VerticalTreeTabs/blob/main/PRIVACY.md` |
| Privacy policy, Edge Add-ons (names Edge only, as Microsoft asks) | [`PRIVACY-EDGE.md`](../PRIVACY-EDGE.md): `https://github.com/oshri-almog/VerticalTreeTabs/blob/main/PRIVACY-EDGE.md` |
| Website and support | `https://github.com/oshri-almog/VerticalTreeTabs` and `https://github.com/oshri-almog/VerticalTreeTabs/issues` |
| The texts | [below](#texts-to-paste) |

`npm run store-images` makes the pictures again from the real panel and settings page.

## Step 1: the developer accounts (once)

Only you can do these: they need your sign-in, and Google's a payment.

### Chrome Web Store

1. **Pick the Google account** to publish with. Its email can't be changed later; Google suggests
   an account used only for publishing.
2. **Turn on 2-Step Verification** for it: without it you can't publish or update.
3. Check that your country is on the **supported countries** list on Google's
   [registration page](https://developer.chrome.com/docs/webstore/register).
4. Open the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), accept the
   developer agreement and the program policies, and pay the **one-time US$5** registration fee.
5. On the **Account** page: a **publisher name** and a **contact email** (both public on the
   listing; verify the email from the message the store sends).
6. The **trader declaration** (European Union rules), your own legal choice: someone who gives a
   free extension away as a hobby usually declares **non-trader**. A trader must show a legal name,
   an address and a phone number on the listing.

### Microsoft Edge Add-ons

Free, through Microsoft Partner Center.

1. A **personal Microsoft account** (Outlook.com, Hotmail, Live), or **Sign in with GitHub**,
   which makes one for you. Work or school accounts are not accepted.
2. Turn on **two-step verification** for it (Partner Center asks for it at sign-in).
3. Open [Partner Center for Edge](https://partner.microsoft.com/dashboard/microsoftedge/public/login).
   The registration form opens (or: Account settings → Programs → Microsoft Edge → Get started):
   - **Country/region**: where you live (it can't be changed later).
   - **Account type**: **Individual** (it can't be changed later; a business must choose Company).
   - **Publisher display name**: public, at most 50 characters.
   - **Contact info**: Microsoft may show the email publicly for support, so use one you don't mind
     showing.
   - Accept the **Microsoft Store App Developer Agreement**, then **Finish**. For an individual the
     check is short: Microsoft checks that the publisher name is free.

## Step 2: before submitting

1. The privacy policies must be public at their addresses (open them in a signed-out window), and
   say what this version does: the code, both policies, the listing texts and the dashboards'
   answers must all match.
2. [Build the package](#build-the-package), unzip it into a new folder, and load that folder
   unpacked in Chrome and in Edge to test the exact files you upload. In Edge, also check that the
   site icons show, and that **⋯ → Keyboard shortcut…** opens the shortcuts page.
3. Search both stores for the name: Edge doesn't allow a name like another extension's. (An
   unrelated Firefox add-on has the same name; none was found on the Chrome or Edge stores.)

### Build the package

The package is a ZIP of the **contents** of the `extension` folder (with `manifest.json` at the top
of the ZIP), without the source icon `icon.svg`. On Windows, in PowerShell, from the project folder:

```powershell
$v = (Get-Content extension\manifest.json -Raw | ConvertFrom-Json).version
New-Item -ItemType Directory -Force dist | Out-Null
Push-Location extension
$files = Get-ChildItem -Recurse -File | Where-Object Name -ne 'icon.svg' | ForEach-Object { (Resolve-Path -Relative $_.FullName).Substring(2).Replace('\', '/') }
tar.exe -a -c -f "..\dist\VerticalTreeTabs-$v.zip" @files
Pop-Location
```

(Not PowerShell's `Compress-Archive`: it writes `\` into the paths, which the stores' tools don't
expect.) On macOS or Linux: `cd extension && zip -r "../dist/VerticalTreeTabs-$(node -p "require('./manifest.json').version").zip" . -x icons/icon.svg`.

Every new upload needs a higher `version` in `manifest.json`.

## Step 3: submit to the Chrome Web Store

In the [Developer Dashboard](https://chrome.google.com/webstore/devconsole): **New item**, then
upload the ZIP. The store runs automatic install tests on the upload; fix and upload again if one
fails. Then fill in the tabs:

- **Store listing**
  - Title and summary come from the manifest.
  - **Description**: paste [Description for the Chrome Web Store](#description-for-the-chrome-web-store).
  - **Category**: Productivity → **Workflow & Planning** (or Make Chrome Yours → Functionality & UI).
  - **Language**: English.
  - **Store icon**: `store/icon-128.png`.
  - **Screenshots**: the four `store/screenshot-*.png`.
  - **Small promo tile**: `store/promo-440x280.png` (optional, but items without one are shown
    after those with one). **Marquee**: `store/marquee-1400x560.png` (optional).
  - **Homepage URL**: the GitHub repository. **Support URL**: its Issues page.
- **Privacy**
  - **Single purpose**: paste [Single purpose](#single-purpose).
  - **Permission justification**: one box per permission, see [Permissions](#permission-justifications).
  - **Remote code**: **No, I am not using remote code**.
  - **Data usage**: tick **Web history** only (the extension reads the addresses and titles of
    your open tabs and keeps them on the device; the store counts that even though nothing leaves
    the device). Then tick the three statements (not sold, not used for anything else, not used
    for creditworthiness).
  - **Privacy policy URL**: the **PRIVACY.md** address above (in this field, not only in the
    description).
- **Distribution**: **Public**, all regions, free.
- **Test instructions** (optional): paste [Instructions for the reviewers](#instructions-for-the-reviewers).

Then **Submit for review**. Most reviews take a few days, sometimes a few weeks (longer for new
developers and for the `tabs` permission). The listing appears once it is approved; you get an
email either way. A rejection email names the problem; fix it, raise the version, and submit again.

## Step 4: submit to Microsoft Edge Add-ons

In [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/): **Overview → Create new
extension**, drag in the ZIP, then go through the pages:

- **Availability**: **Public**, all markets.
- **Properties**: **Category** Productivity; **Website** the GitHub repository; **Support contact**
  its Issues page (so that no email of yours is shown); mature content left clear.
- **Privacy**
  - **Single purpose**: paste [Single purpose](#single-purpose), with "sidebar" for "side panel".
  - **Permission justifications**: [the same texts](#permission-justifications).
  - **Remote code**: **No**.
  - **Data usage**: the same answers as for Chrome (**Web history** only, and the statements).
  - **Privacy policy URL**: the **PRIVACY-EDGE.md** address above.
- **Store listings** (English)
  - **Description**: paste [Description for Edge Add-ons](#description-for-edge-add-ons). It must
    not name other browsers.
  - **Extension logo**: `store/logo-300.png`.
  - **Small promotional tile**: `store/promo-440x280.png`. **Large promotional tile**:
    `store/marquee-1400x560.png` (optional).
  - **Screenshots**: the four `store/screenshot-*.png`.
  - **Search terms**: [the seven below](#search-terms-edge).
  - **Save draft**.
- **Publish**: paste [Instructions for the reviewers](#instructions-for-the-reviewers) into
  **Notes for certification**, then **Publish**.

Certification takes up to seven business days. The status goes from *In review* to *In the store*;
a failed review comes with a report.

## Updates, later

Raise `version` in `manifest.json`, build a new ZIP, upload it to each store (Chrome: the item →
Package → Upload new package; Edge: the extension → Packages), change the listing or privacy
answers if something changed, and submit again: each update is reviewed like the first version.
Users keep the old version until the new one is published, then get it by themselves.

## Texts to paste

### Description for the Chrome Web Store

```text
Vertical Tree Tabs shows your tabs in the side panel as a tree: every tab you open from a link sits under the tab you opened it from, so you always see where a page came from.

Search for something and open a few results in new tabs: they appear under the search. Open links from one of those, and they appear one level deeper.

Features
• Tabs as a tree, built as you browse
• Folders: named tabs with an icon that hold the tabs you put in them (Alt+B)
• A colour for every tree, with lighter and darker shades for the trees inside it
• Tab groups in the tab strip that mirror the trees, at the level you choose: one group per tree, per innermost subtree, per page or per branch, or no groups. Your own tab groups show in the panel too, and can be left alone or regrouped.
• Collapse and expand trees; collapsing a tree collapses its tab group too
• Drag and drop a tab with everything under it (or alone, with Ctrl): rearrange, nest, or move it to another window
• Select several tabs with Ctrl+click and Shift+click, and move, group, close or reload them together
• Choose where new tabs go (New Tab pages, links, bookmarks) and what happens when a tab closes
• Find a tab in any window (Alt+G); search by words or a regular expression; keyboard control of the whole tree, and shortcuts for it from anywhere
• Light and dark themes, compact or roomy rows, text sizes, and your own colours
• Your trees come back after the browser restarts, and when you reopen a window you closed

Open the panel with the toolbar button or Alt+T. Settings: the ⋯ menu at the top of the panel.

Privacy
The extension reads the titles, addresses and icons of your open tabs, and which tab opened which, only to draw and keep the tree. It keeps them in your browser, on your device: for your open windows, and for up to ten windows you closed, so that their trees come back when you reopen them. It sends, sells and shares nothing: no account, no analytics, no ads. The only things it loads from the web are your tabs' site icons, from the addresses the pages give for them. Privacy policy: https://github.com/oshri-almog/VerticalTreeTabs/blob/main/PRIVACY.md

Open source (MIT): https://github.com/oshri-almog/VerticalTreeTabs
```

### Description for Edge Add-ons

```text
Vertical Tree Tabs shows your tabs in the sidebar as a tree: every tab you open from a link sits under the tab you opened it from, so you always see where a page came from.

Search for something and open a few results in new tabs: they appear under the search. Open links from one of those, and they appear one level deeper.

Features
• Tabs as a tree, built as you browse
• Folders: named tabs with an icon that hold the tabs you put in them (Alt+B)
• A colour for every tree, with lighter and darker shades for the trees inside it
• Tab groups in the tab strip that mirror the trees, at the level you choose: one group per tree, per innermost subtree, per page or per branch, or no groups. Your own tab groups show in the sidebar too, and can be left alone or regrouped.
• Collapse and expand trees; collapsing a tree collapses its tab group too
• Drag and drop a tab with everything under it (or alone, with Ctrl): rearrange, nest, or move it to another window
• Select several tabs with Ctrl+click and Shift+click, and move, group, close or reload them together
• Choose where new tabs go (New Tab pages, links, favorites) and what happens when a tab closes
• Find a tab in any window (Alt+G); search by words or a regular expression; keyboard control of the whole tree, and shortcuts for it from anywhere
• Light and dark themes, compact or roomy rows, text sizes, and your own colours
• Your trees come back after the browser restarts, and when you reopen a window you closed, also with Startup boost

Open the sidebar with the toolbar button or Alt+T. Settings: the ⋯ menu at the top of the sidebar.

Privacy
The extension reads the titles, addresses and icons of your open tabs, and which tab opened which, only to draw and keep the tree. It keeps them in your browser, on your device: for your open windows, and for up to ten windows you closed, so that their trees come back when you reopen them. It sends, sells and shares nothing: no account, no analytics, no ads. The only things it loads from the web are your tabs' site icons, from the addresses the pages give for them. Privacy policy: https://github.com/oshri-almog/VerticalTreeTabs/blob/main/PRIVACY-EDGE.md

Open source (MIT): https://github.com/oshri-almog/VerticalTreeTabs
```

### Single purpose

```text
Tab management: shows the tabs of the current window in the side panel as a tree, each tab under the tab it was opened from, and can mirror each tree as a tab group in the tab strip.
```

### Permission justifications

| Permission | Justification |
| --- | --- |
| `tabs` | Reads each tab's title, address and icon address to show the tabs in the panel's tree, to search them, and to name tab groups after their pages. It also matches tabs to the saved tree by address after a browser restart or when a closed window is reopened, since tabs then get new ids. No host permissions are requested. |
| `webNavigation` | webNavigation.onCreatedNavigationTarget tells which tab a link opened a new tab from, so that the new tab is placed under it in the tree (the opener id of the tabs API is no substitute: the browser also sets it for Ctrl+T). webNavigation.onCommitted's transition type tells which new tabs were opened from a bookmark, which the user can choose to place by the current tab. No page content is read. |
| `tabGroups` | Mirrors each tree as a native tab group (creates, names, colours, collapses and ungroups the groups it made) and follows the user's own changes to those groups. The settings page sets the level of grouping, or turns it off. |
| `sidePanel` | The extension's whole interface is a side panel page, opened with the toolbar button or the Alt+T shortcut. |
| `storage` | storage.session keeps the tree while the browser runs, the current tab of each window, and the addresses of the last 30 tabs closed in normal windows for half an hour (so that a reopened tab goes back under its parent). storage.local keeps the settings, the user's chosen colours and, to rebuild the tree after a restart or when a closed window is reopened, the addresses and tree of the open normal windows and of up to ten recently closed windows. Nothing is synced or sent. |
| `favicon` | Shows a tab's site icon from the browser's own icon cache when the tab has no usable icon address or its icon fails to load. |

### Instructions for the reviewers

```text
No account or sign-in is needed, and nothing opens on install. Click the extension's toolbar button (it may be inside the browser's Extensions menu) or press Alt+T to open the panel. Open any page with links and middle-click a few of them: the new tabs appear under it in the tree, and the tree becomes a tab group. Right-click a row for the menu (colour, group name, folders, close tree, move tree to a new window). Alt+B puts the current tab in a new folder, a tab showing the extension's own folder page. The settings (⋯ menu at the top of the panel → Settings…) choose how tabs are grouped, where new tabs go and how the panel looks. The extension has no content scripts and no host permissions, and sends no data.
```

### Search terms (Edge)

`vertical tabs`, `tab tree`, `tree tabs`, `tab groups`, `tab manager`, `sidebar tabs`, `tab organizer`

## What users see when they install it

"Read your browsing history" (from `tabs`; it also covers `webNavigation` and `favicon`) and "View
and manage your tab groups" (from `tabGroups`). See the README's
[Permissions](../README.md#permissions) for why it needs each.
