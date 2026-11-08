# Firefox support and releases

Tabkeeper uses one repository and shared JavaScript, HTML and CSS for Chrome and desktop Firefox. The repository
name and existing Chrome support/privacy URLs stay unchanged. The Firefox port is prepared as version **1.1.0**;
it does not replace or resubmit Chrome 1.0.0, which was submitted separately.

## Targets

| Target | Minimum | Background | Package |
| --- | --- | --- | --- |
| Chrome | 121 | Manifest V3 service worker | `dist/tabkeeper-<version>.zip` |
| Firefox desktop | 140 | Manifest V3 module event page | `dist/tabkeeper-firefox-<version>.zip` |

The root `manifest.json` remains the Chrome development manifest. `scripts/browser-targets.mjs` generates the
Firefox manifest without modifying that source. It supplies the stable add-on ID `tabkeeper@jamesarnett`, a
desktop minimum version, and Mozilla's data-consent declaration. Do not change the ID after the first AMO upload.
There is no runtime polyfill, bundler or third-party runtime dependency. `web-ext` is a pinned development tool;
the package lock and npm override keep its dependency tree reproducible. `deepmerge` is pinned to 4.1.2 because
the linter's 4.3.1 dependency is in the range affected by GHSA-gcqx-w48m-w2h4. Recheck and remove the override
when Mozilla's toolchain adopts a safe compatible release.

Firefox for Android is not supported: native tab-group APIs needed here are unavailable there. The manifest
deliberately omits `gecko_android`, so AMO defaults to desktop-only availability. Keep Linux, macOS and Windows
selected at submission and do not enable Android. `web-ext` currently emits one Android minimum-version warning
about the consent key inherited from desktop Firefox 140; this does not represent a desktop compatibility error.
Do not add an Android compatibility declaration merely to hide that warning.

## Local development and checks

```sh
npm ci
npm test
npm run package
npm run package:firefox
npm run lint:firefox
FIREFOX="/path/to/firefox" GECKODRIVER="/path/to/geckodriver" npm run e2e:firefox
CHROME="/path/to/Chrome for Testing" npm run e2e
```

Use Firefox 140 or newer. To load the Firefox ZIP temporarily, unzip it outside this source folder, visit
`about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select its generated manifest.
Repackage/reload after edits. Temporary installs are for development; normal Firefox installs require Mozilla signing.

The Firefox integration test launches a disposable profile using standard geckodriver add-on installation.
A test-only module runs in the temporary extension's settings page and reports to a loopback HTTP fixture.
It tests closing, Keep, pinned protection, group/status updates, trusted-message boundaries, AWS label parsing,
UI storage, concurrent history writes, a long grouping alarm, age closing and denied host access. It uses no
system-access flag and does not alter the installed browser or a user profile. The test module, fixture access
grant and control server are never shipped. Native permission prompts remain manual QA because headless tests
pre-grant the loopback fixture permission in the disposable copy.

## Browser differences

- `src/browser-api.js` prefers Firefox's Promise-based `browser` API and falls back to Chrome's API. The same
  scheduler/grouper/storage modules remain dependency-injected and shared.
- Firefox does not expose Chrome's tab-replacement event, so that optional listener is guarded. Chrome retains
  its replacement handling.
- Firefox host patterns cannot include port numbers. A Firefox grant covers all ports on a host; URL rules still
  decide which pages match. Save/Test disclosures show the actual requested pattern. Chrome keeps its origin pattern.
- Extension-page identity uses the browser-provided sender ID and complete extension URL prefix, not assumptions
  about `chrome-extension://`. Web-page readers cannot invoke settings-only messages.
- Collapsing a Firefox group containing the active tab leaves that tab active/visible. Chrome may move focus
  outside the group. Keep, countdown timing and pinned protection retain the same intended behavior.
- Help, sync wording and extension-settings controls adapt to the browser. Firefox blocks extensions opening
  `about:addons` through `tabs.create`, so its button shows access instructions; Chrome opens its settings page. Chrome Sync and Firefox Sync are separate;
  transfer settings between browsers with JSON export/import. This extension does not provide its own sync server.

Mozilla's consent manifest defines data collection/transmission in terms of processing outside the extension
or local browser. The Firefox target declares `required: ["none"]`: Tabkeeper has no developer/server transmission,
analytics or custom sync. Browser-managed Firefox Sync and local handling of tab/page/account data are still
disclosed in the shared privacy policy and guide. This differs from Chrome's store disclosure categories for
local processing; do not copy a store's checkbox interpretation into another store's consent taxonomy.

## Your AMO developer account

1. Sign in or register with a Mozilla account at [AMO Developer Hub](https://addons.mozilla.org/developers/).
2. Verify the account email and set the AMO profile display name to **James Arnett**. The Mozilla-account display
   name does not automatically populate the AMO profile. Enable two-step authentication and keep recovery codes private.
3. Accept Mozilla's developer agreement yourself when prompted.
4. When the Firefox package has passed checks and manual QA, choose **Submit a New Add-on → On this site**.
5. Upload `tabkeeper-firefox-1.1.0.zip`, keep desktop platforms selected, choose MIT and supply the listing, support
   and privacy-policy links. The add-on ID comes from the package; retain it for updates.
6. Capture actual Firefox screenshots for AMO. The existing Chrome captures remain correct for the Chrome listing;
   they are not evidence of Firefox UI testing. Core listing text can be reused with Firefox-specific wording.
7. Explain to reviewers that Tabkeeper has no login. Optional third-party status/AWS reads use an existing site
   session and optional site access, with no AWS keys or developer account required by the extension.

## Automated updates

Create a GitHub environment named `firefox-add-ons`. From the [AMO API credentials page](https://addons.mozilla.org/developers/addon/api/key/),
store the JWT issuer as **AMO_JWT_ISSUER** and JWT secret as **AMO_JWT_SECRET** in that environment's secrets.
Do not put either value in the repo, workflow input, issue or chat. The credentials belong to an AMO account
authorized to update this listing. Only the publishing step receives them, after validation and security checks.

The **Firefox Add-ons** workflow is manual. Supply an existing matching version tag. With **Submit** off (the
default), it runs checks and produces artifacts without contacting AMO. With **Submit** on, Mozilla's pinned
`web-ext sign --channel listed` client submits the tested package to the public listing; it may be published
after Mozilla approval. The workflow does not bypass review. A successful submission does not mean approval.
The initial listing should be completed manually before using this update workflow. Required listing metadata
or account issues are handled in AMO. Tag releases attach both tested browser ZIPs to GitHub Releases.

## Manual release checks

- Test actual Firefox grant, denial and revocation prompts and reload affected tabs after revocation.
- Test Jira and AWS navigation against real sessions, including a role switch and live ticket status changes.
- Check popup scrolling, shortcuts, downloads/import/export and restoring settings into a fresh Firefox profile.
- Exercise browser restart/session restore and event-page unloading with long pending closes and grace periods.
  Automated alarm tests verify a quiet waiting period; they do not prove a particular Firefox event page was unloaded.
- Review Firefox screenshots, store disclosures and platform selection before submitting. Existing unverified
  site presets stay unverified until tested live; no unsupported preset was promoted during the port.

References: [cross-browser backgrounds](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background),
[Firefox compatibility selection](https://extensionworkshop.com/documentation/publish/version-compatibility/),
[Mozilla data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/),
[submission](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/),
[web-ext](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/).
