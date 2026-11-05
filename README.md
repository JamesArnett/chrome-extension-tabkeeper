# Tabkeeper

[![CI](https://github.com/JamesArnett/chrome-extension-tabkeeper/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JamesArnett/chrome-extension-tabkeeper/actions/workflows/ci.yml)
[![Security](https://github.com/JamesArnett/chrome-extension-tabkeeper/actions/workflows/security.yml/badge.svg?branch=main)](https://github.com/JamesArnett/chrome-extension-tabkeeper/actions/workflows/security.yml)

A Chrome extension that closes tabs you never need to keep open: Zoom "redirecting to the app"
pages, AWS post-login confirmation windows, and anything else you can describe with a title or URL
match. Each rule has its own delay, so a tab is only closed after it has sat matching for as long as
you choose.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Click the toolbar icon to open the popup and add your first rule.

Requires Chrome 121 or newer.

The welcome page opens on first install. Click **Help** in the toolbar popup or settings header to open it again.

## Using it

The toolbar popup is the main pane: pause or snooze, tabs counting down (with **Keep**), the Close, Group and
AWS tabs with every setting and the add-rule forms, recent closes with **Reopen**, and import/export. Its rule lists
show only the rules that match the tab you are on. **All rules** opens the same page full width with every rule,
where you can also reorder them (also reachable from the extension's Options entry). Shortcuts: Alt+Shift+P pauses or
resumes, Alt+Shift+G groups the current tab.

- **Add rule** starts from the tab you have open: the form is pre-filled with the tab's title as a
  *contains* match and the site origin as a URL *starts with* match. Edit or clear whichever part is
  too specific before saving.
- **Rules**: each rule has a name, an optional title condition, an optional URL condition, a delay in
  seconds, and optionally a grace period before the tab is moved into the Closing group. Use the grace for
  login pages that bounce straight back to where they came from in the same tab (GitLab → Okta → GitLab):
  the countdown still runs, but a tab that returns within the grace never visibly leaves its group. Conditions can be *contains*, *starts with*, *ends with*, *equals*, or a
  JavaScript regular expression, with an optional case-sensitive flag. When both a title and a URL
  condition are set, both must match. The first enabled rule in the list that matches a tab wins, so
  order matters; use the arrows to reorder.
- **Closing soon**: tabs currently counting down, with a **Keep** button that cancels the close and
  exempts that tab from that rule for as long as it stays open. Every counting-down tab is also moved into one red tab group called **Closing** at the end of
  the tab strip, so pending closes never sit in the middle of your tabs. The group is nudged back to the end
  whenever you open a new tab. Cancel a close and the tab goes back to the group or position it came from. Tabs in popup windows cannot be grouped and simply close.
- **Pause / snooze**: the control in the header pauses closing on this machine for 15 minutes, an hour,
  four hours, until tomorrow morning, or until you resume. Pending closes are dropped; resuming rescans.
- **Automatic closing & options** (under the Close tab): close tabs that have been open longer than a
  limit, or not used for a limit, checked once a minute. These close quietly, without a countdown group,
  and are listed under Recent closes. Pinned tabs, the active tab in each window, tabs playing audio and
  tabs that ask "Leave site?" are never closed this way, nor is anything on your never-close list.
  The same section lets you keep the Closing group collapsed.
- **Pinned tabs** are never closed.
- **Active and audible tabs** are protected from age-based closing. Explicit close rules can close them;
  use Keep or Pause when you want a matching tab to stay open.
- **Unsaved edits** in the rule form are kept if the popup closes while you are typing. Reopen the
  popup and the form comes back as you left it.
- **Recent closes** lists the last 100 tabs the extension closed, with the rule that fired and a
  **Reopen** button.
- **Import / export**, below the tabs, writes one JSON file with close rules, grouping rules, AWS
  Console settings and options, and reads the same file back. Rules are also synced through your Chrome
  profile automatically.

## Tab groups and page status

The **Group** tab of the popup holds grouping rules. A grouping rule has a URL regex, a group title
template and a colour. Tabs whose URL (or, failing that, title) matches are put into a Chrome tab group:
`$1`-style templates give each ticket its own group (`ABC-123`), plain text gives one shared group
(`GitHub`). Colours can be fixed, random per group, or stable per title. Groups are per window, and
single-page navigations (Jira Cloud, GitLab) re-group the tab. **Apply to all open tabs** runs the rules
over everything already open.

Optionally a rule can **append a status read from the page**: the group becomes `ABC-123 - In Progress`
and follows the page live (drag a Jira card, merge an MR, the title updates). You give it a CSS selector
for the status element, optionally a "keep only" regex and a label, and can add more fields
(`project!17 - Open · CI passed`). Presets exist for Jira, GitHub, GitLab (MR, issue, pipeline), Azure
DevOps and ServiceNow; the ones not marked verified should be checked with **Test on current tab**, which
shows what would be read without grouping anything. Reading a page needs permission for that site; Chrome
asks the first time you save or test, and grouping works even if you decline.

**Max group title length** shortens long base titles with `…` (never the status) so Chrome's own
truncation does not hide the status. The help page linked from the form explains how to find a selector.

## AWS Console tabs

The **AWS** tab of the popup groups every AWS Console tab by the account and role you are signed in as,
read from the console's navigation bar after the page loads. Tick which fields appear in the group title
(account name, account ID, role, user, region) and pick a separator; the default is
`Acme Dev · AdminRole`. Tabs for the same account and role share a group per window, and switching
roles moves the tab. Colours are random per new group. AWS multi-session URLs
(`<account>-<id>.<region>.console.aws.amazon.com`) are recognised. Turning the feature on asks for permission to read
`*.console.aws.amazon.com`. If AWS changes its markup, the selectors are editable under Advanced and
**Test on current tab** shows exactly what is read.

## How it decides to close a tab

The background service worker evaluates a tab whenever it is created, its title or URL changes, or
it finishes loading. When a tab first matches a rule, a countdown starts. If the tab stops matching
before the countdown ends (you navigated away, the title changed, you pinned it), the close is
cancelled. When the countdown ends the tab is fetched again and re-checked before it is removed.
Pending countdowns survive the service worker being suspended, so long delays are safe.

## Development

```
npm test                              # all tests (node --test)
npm run coverage                      # same, with line/branch coverage (built-in)
npm run coverage:ci                   # Node 24+: coverage plus JSON reports
npm run security                      # local CodeQL + OSV scan (install scanners first)
node --test test/scheduler.test.js    # one file
npm run icons                         # regenerate icons/*.png
CHROME=/path/to/chrome npm run promo  # render store/ promo tiles and screenshots
CHROME=/path/to/chrome npm run e2e    # headless browser smoke test (see below)
```

The end-to-end script loads the extension into a headless browser and checks closing, pinned
exemption, pause, the popup, draft autosave, grouping, live status updates against a local fixture page,
title shortening, and the form's Test button. Branded Chrome 137+ ignores `--load-extension`, so
point `CHROME` at Chrome for Testing: `npx @puppeteer/browsers install chrome@stable` prints the
binary path. The script also needs `openssl` on PATH to mint a throwaway certificate for its fixture site.

No build step. Edit the files and click the reload icon on `chrome://extensions`.

```
npm run package                       # dist/tabkeeper-<version>.zip for the Chrome Web Store
```

See [AGENTS.md](AGENTS.md) for contributor guidance and the code layout, and
[the grouping spec](docs/spec-tab-groups-and-status.md) for expected behavior. The store listing draft and
privacy policy are in `docs/`.

GitHub Actions runs unit tests, coverage, packaging and Chrome for Testing integration tests. Pushing a version
tag such as `v1.0.0` creates a GitHub release with the tested ZIP. The manual **Chrome Web Store** workflow can
upload that version and optionally submit it for review. Store publishing requires an existing listing and
credentials configured in GitHub's `chrome-web-store` environment. See [the release guide](docs/RELEASING.md)
for setup and publishing steps.

CodeQL scans JavaScript and GitHub Actions; OSV-Scanner checks package dependencies. The Security workflow runs these on pushes,
pull requests, and weekly. Releases are blocked by high/critical CodeQL findings or any dependency vulnerability.
The README uses GitHub-native workflow status badges. Coverage percentages, test totals and security counts
appear in Actions job summaries and downloadable reports. Unit coverage measures code exercised by Node tests;
browser integration tests run separately. See
[security checks and local setup](docs/SECURITY_CHECKS.md) for scope, reports, and scanner installation.

Permissions used: `tabs` (read titles and URLs, close tabs), `tabGroups` (countdown labels and
grouping), `scripting` (inject the status reader), `storage`, `alarms`. Site access is **optional and per
origin**: nothing is granted at install, and only the sites you approve from the popup can be read. No
content scripts run on their own and nothing talks to the network.
The popup explains site access beside the status/AWS controls. **Privacy** in its header opens the bundled
permissions and data guide, including Chrome Sync, local history, custom selector boundaries and revoking access.

Licensed under the [MIT License](LICENSE). Copyright © 2026 James Arnett.
