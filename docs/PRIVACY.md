# Tabkeeper privacy policy

_Last updated: November 12, 2026_

Tabkeeper is a browser extension that closes and groups your tabs according to rules you write. It has no
server, no account system, no analytics and no advertising. It makes no network requests and does not send
your data to the developer. Browser sync can separately store and sync your rules/settings through Google (Chrome Sync) or Mozilla (Firefox Sync),
as explained below.

## What Tabkeeper reads

- **Tab titles and URLs** of your open tabs, so it can compare them with your rules. This happens inside your
  browser.
- **Tab state**, including when a tab was first seen or last used, whether it is pinned, and whether it is
  active or playing audio, to manage countdowns and age-based closing.
- **Page content, only on sites you approve.** If you create a grouping rule that shows a status from the page
  (for example a ticket state), or turn on AWS Console grouping, your browser asks you to grant access to that site.
  Tabkeeper uses configured selectors to read text or selected form values and show them in tab group titles.
  Readers skip password and hidden inputs and form controls with credential, payment-card or one-time-code
  autocomplete hints. Other input and textarea values can still contain sensitive information; choose
  non-sensitive status fields. Test results can also show
  raw matched values and the matching element. AWS grouping reads account, role and user labels from console
  navigation and the region from the URL; it does not call AWS APIs or use AWS access keys.

## Site access boundaries

No optional site access is granted at install. Closing and basic grouping use tab titles/URLs and work without
it. Saving a status rule requests the rule's site origin; testing requests the current tab's origin, which may
differ. The grant covers pages across that site, not only the current ticket or configured selector. It persists
until revoked. Firefox host-permission patterns cover all ports on the approved host; URL rules still decide
which pages are processed. Automatic status reads then run on matching tabs, including permitted frames.

The browser's host permission grants broader page access than the reader's intended use; it does not restrict the
extension to individual status elements. Tabkeeper's readers read configured values and do not edit page content.
AWS requests `https://*.console.aws.amazon.com/*` to cover the console and its regional/account subdomains.
The optional HTTP/HTTPS patterns in the manifest allow requests for user-chosen sites; they do not grant all sites.

You can decline access or revoke it in Chrome's extension **Details → Site access** or Firefox's **Add-ons and themes → Tabkeeper → Permissions**. Page status and AWS
account grouping need their corresponding access; closing and basic grouping do not. Reload affected tabs
after revocation to remove readers already running there. Revocation does not erase existing group titles.

## What Tabkeeper stores

Tabkeeper uses your browser's extension storage and displays derived labels in tab group titles:

- **Your rules and settings** are stored in your browser's extension sync storage. These include close and
  grouping rules, their names, URL/title patterns and page selectors, AWS grouping settings, and age-based closing
  settings, including the never-close list. Rules and settings can contain internal hostnames or other sensitive
  information. When browser sync is enabled, Google stores and syncs this data through the Google account signed
  into Chrome, or Mozilla through the Mozilla account signed into Firefox. Tabkeeper's developer never receives
  this data. You control sync in your browser's sync settings. Chrome and Firefox do not sync these settings to
  each other; you can transfer them manually using settings export/import.
- **A list of the last 100 tabs Tabkeeper closed** (title, web URL, the rule that closed it, and the time), so you
  can review and reopen them. Stored HTTP/HTTPS URLs retain the origin and path, with credentials, query strings
  and fragments removed; other URL schemes are omitted. Existing history is scrubbed when the extension starts
  or history is read. Reopen opens the saved HTTP/HTTPS address, so URL query or fragment state is lost. Titles and
  URL paths can still contain sensitive information. History stays on the device and can be cleared at any time.
- **Unfinished rule forms and local preferences**, including pause state and display settings, stay on the device.
- **Temporary working state** (tabs counting down, tab group records, when a tab was first seen). This is held in
  session storage and is discarded when the browser closes. Group records can contain status and AWS account/role
  labels; those labels can also remain visible in the browser's tab group titles.

Chrome can also save and sync tab group titles when history and tabs sync is enabled for your Google account.
These titles can contain page status and AWS account, role or user labels. Manage history and tabs sync in
Chrome's sync settings. [Chrome's tab group sync documentation](https://support.google.com/chrome/answer/2391819?co=GENIE.Platform%3DDesktop&hl=en)

Titles, URLs, custom field values and rules can contain sensitive information. Avoid selectors that expose
private fields, and review exported settings before sharing them.

## What Tabkeeper shares

Tabkeeper makes no network requests or uploads to the developer or analytics services. It does not sell data.
Chrome Sync or Firefox Sync may sync rules/settings through the respective browser provider when enabled. Exporting settings creates a JSON file you
control; Tabkeeper does not upload it.

Tabkeeper does not access the browser's browsing-history database, cookie store or saved-password store. It does not
record keystrokes, take screenshots, or request camera, microphone or location access. This does not prevent a
custom selector from reading sensitive content or form values on an approved page if you configure it to do so.

## Removing your data

Removing the extension deletes its extension storage from that browser. You can also clear the close history from
the popup or settings page. Exported JSON files and existing browser tab group titles are not erased by removing
the extension; remove those separately if needed. Browser sync is managed through your Chrome/Google or Firefox/Mozilla settings.

## Contact

[Tabkeeper support](https://github.com/JamesArnett/chrome-extension-tabkeeper/issues)
