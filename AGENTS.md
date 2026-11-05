# AGENTS.md

Guidance for coding agents and contributors working in this repository.

## What this is

**Tabkeeper** is a Manifest V3 Chrome extension written in vanilla JavaScript ES modules. There is no bundler and
no runtime dependency. It has three features:

1. **Close rules.** Tabs whose title and/or URL match a rule are closed after a per-rule delay. While counting down
   they sit in one red "Closing" tab group at the end of the tab strip. Optional age-based closing closes tabs
   open, or unused, for longer than a limit.
2. **Grouping rules.** Tabs are put into Chrome tab groups by URL regex, optionally with a live status read from the
   page appended to the group title (`ABC-123 - In Progress`).
3. **AWS Console grouping.** AWS Console tabs are grouped by the signed-in account and role.

`PLAN.md` is the decision log: every product decision and judgement call, with dates. `docs/spec-tab-groups-and-status.md`
is the behavioural spec for grouping and status. Keep both consistent with the code. That spec mentions a third-party
extension used as a prototype; it is unlicensed, so do not fetch, read or copy its code.

`HANDOFF.md` summarises the project state and the remaining work to publish.

`PLAN.md` and `HANDOFF.md` are local working notes excluded from Git and may be absent in a fresh clone.
The shared behavioural spec and release instructions live in `docs/`.

## Commands

```
npm test                              # node --test, runs every test/*.test.js
node --test test/scheduler.test.js    # one file
npm run coverage                      # node --test --experimental-test-coverage
npm run package                       # dist/tabkeeper-<version>.zip for the Chrome Web Store
npm run icons                         # regenerate icons/*.png from scripts/make-icons.mjs
CHROME=/path/to/chrome npm run e2e    # scripts/e2e.mjs: headless browser test over the DevTools protocol
CHROME=/path/to/chrome npm run promo  # scripts/make-promo.mjs: store/ promo tiles and screenshots
```

Node 20 or newer. There is no build or lint step. Load the repo root unpacked at `chrome://extensions` and press
its reload button after edits.

The e2e and promo scripts need **Chrome for Testing**: branded Chrome 137+ ignores `--load-extension`.
`npx @puppeteer/browsers install chrome@stable` downloads it and prints the binary path. `openssl` must be on PATH
(the e2e mints a throwaway certificate for its HTTPS fixture site). Run the e2e after any change to
`src/background.js`, `popup/`, `options/` or the manifest, since unit tests cannot load those.

Unpacked extensions get an ID derived from the folder path, and all stored settings belong to that ID. Moving or
renaming the folder, or removing and re-adding the extension, starts with empty settings. Export settings first.

## Layout

```
manifest.json
src/            service worker and all logic (ES modules, plus two classic scripts injected into pages)
popup/          shared.js (UI helpers) and popup.css (base styles)
options/        the UI: toolbar popup (options.html?popup=1) and full-tab settings page (options_ui)
help/guide.html bundled guide, opened on first install
icons/          16/32/48/128 for the manifest; 256/512 for store artwork
test/           node --test suites; test/helpers/chrome-mock.js is an in-memory chrome.* API
scripts/        e2e, icon, promo and packaging scripts
store/          rendered Web Store images
docs/           spec, store listing draft, privacy policy draft
```

## Architecture

Entry points are deliberately thin:

- `src/background.js` (service worker) wires `chrome.tabs`, `chrome.tabGroups`, `chrome.windows`, `chrome.alarms`,
  `chrome.commands`, `chrome.storage.onChanged` and `chrome.runtime.onMessage` to three objects: the scheduler
  (rule closing), the grouper (grouping, status, AWS) and the age closer. Listeners are registered synchronously at
  top level (an MV3 requirement) and wait for `start()`. Messages: `cancel` (`keep: true` makes Keep stick),
  `status-report` (the only message pages may send), `group-test`, `group-apply`, `group-apply-all`, `aws-test`,
  `set-title-limit`, `sweep`, `version`.
- `options/options.js` is the whole UI: pause/snooze, Closing soon with Keep, Close | Group | AWS views,
  recent closes with Reopen, import/export. The toolbar popup loads the same page as
  `options/options.html?popup=1` (`IN_POPUP`, body class `in-popup`: 630 px wide). In the popup the Close and
  Group rule lists show only rules matching the current tab (`closeRuleMatchesTab`, `groupRuleMatchesTab`), without
  reorder arrows; the "All rules" button opens the full page (`options_ui`), which lists every rule. `popup/shared.js` and `popup/popup.css` are shared helpers and base
  styles for it.
- The "current tab" is `pickActiveTab()` in `popup/shared.js`: the active tab when the UI is a popup, otherwise the
  most recently used non-extension tab of the window (the settings tab itself is active then).
- Rule CRUD goes through storage and `chrome.storage.onChanged`; Test/Apply/limit go through messages.

Logic lives in `src/` modules that take their dependencies as arguments so they run in Node:

- `scheduler.js`: `createScheduler({ storage, tabs, alarms, tabGroups, now, setTimeout, clearTimeout })`. Every public
  method runs through one promise queue, so tab events cannot interleave. Pending closes are persisted in
  `session.pending` and re-armed by `start()` after a worker restart. Delays under 30 s use `setTimeout`, longer ones
  `chrome.alarms` (`close:<tabId>`). Long grouping grace periods use `group:<tabId>` alarms too. `fire()` re-fetches and re-matches the tab before removing it. Pending tabs join
  one red "Closing" group per window (`CLOSING_GROUP_TITLE`, tracked in `session.closingGroups`), kept at the end of
  the strip and collapsed by default. A rule's `groupAfterSeconds` delays that move (`groupAt`, `claimLater`) so a
  login page that redirects back never visibly leaves its group. Keep records `session.kept[tabId] = [ruleIds]`.
- `matcher.js`: compiles close-rule conditions; invalid rules never match; first enabled rule wins; kept ids skipped.
- `rules.js`: close-rule schema, `validateRule`, `normalizeRule`, import/export, `suggestFieldsFromTab`.
- `explain.js`: `explainClose()`, the pure text behind "Test this tab".
- `age-closer.js`: `createAgeCloser(...)`; `sweep()` runs from a one-minute alarm. First-seen times in
  `session.firstSeen`; tabs that survive `tabs.remove` (a "Leave site?" dialog) go into `session.ageBlocked`.
  Exempt: pinned, active, audible, pending a rule close, never-close list.
- `storage.js`: `createStorage(chrome.storage)`.
  - sync: `rule:<id>` + `ruleOrder`, `grule:<id>` + `groupRuleOrder` (one key per rule for the 8 KB item quota),
    `awsSettings`, `closeSettings`.
  - local: `paused`, `pausedUntil`, `log`, `draft`, `groupDraft`, `maxTitleLength`, `popupView`.
  - session: `pending`, `closingGroups`, `kept`, `groupRecord`, `firstSeen`, `ageBlocked`.
- `draft.js`: debounced autosave of unfinished forms. `log.js`: capped newest-first close log, protected by a
  Web Lock shared by the worker and settings pages so concurrent appends and Clear cannot overwrite each other.
- `grouper.js`: `createGrouper(...)`. One queue serialises group lookups and record writes (prevents duplicate
  groups). `findOrCreateGroup` checks the session record, then adopts by title (`parseTitle`), then creates. Page
  reads run outside the queue and re-enter via `applyStatus`, which refuses if the tab is not in the recorded group.
  `onStatusReport` re-matches the sender before trusting it. AWS console tabs are routed to `evaluateAwsTab` first.
- `group-rules.js`: grouping-rule schema and validation, `matchGroupRules` (URL first, then title),
  `resolveBaseTitle`, `pickColor` (`colorMode` fixed | random | title).
- `titles.js`: the only place for the ` - ` separator, `…`, the 80-char status cap, 8-char base floor and the
  12 minimum limit. `buildTitle` and its inverse `parseTitle` must change together.
- `group-record.js`: session record `{ windowId: { baseTitle: { groupId, status, ruleId } } }`.
- `status-core.js` + `reader.js`: **classic scripts, not modules.** Injected into pages with
  `chrome.scripting.executeScript({ files })`, so they must stay self-contained. status-core is also loaded by the
  settings page via `<script src>` and by tests via `vm.runInThisContext` (`test/helpers/status-core.js`).
- `status-reader.js`: worker wrapper over `chrome.scripting`/`chrome.permissions`; `pickBestFrame`.
- `presets.js`: grouping presets; the Jira selector is the default for blank selectors.
- `aws.js`: AWS console URL pattern (handles multi-session hosts), account/role parsing, title composition. The URL
  pattern is stored with the settings: when `AWS_DEFAULT_URL_PATTERN` changes, add the old value to
  `LEGACY_URL_PATTERNS` or existing users keep the stale one.
- `build.js`: `SOURCE_FILES` + `computeSourceHash()` for the developer "reload extension" banner (hidden for store
  installs). Add new worker-side files to `SOURCE_FILES`.

## Testing conventions

`test/helpers/chrome-mock.js` provides in-memory storage areas, a `tabs` API (`_add`, `_update`, `_close`, `group`,
`ungroup`, `move`), `createTabGroups()` (deletes empty groups like Chrome), `createAlarms()` with `_due(time)`, and a
deterministic clock (`createClock`) whose `advance(ms)` runs timers in order. Tests inject the clock and
`await x.idle()` after advancing. Add a test for every new scheduler or grouper state transition.

## Things that are easy to get wrong

- CSS `[hidden] { display: none !important }` is deliberate: classes that set `display` would otherwise override
  the `hidden` attribute and leave notices stuck on screen.
- Build DOM with `createElement`/`textContent` only. No `innerHTML`: rule names, patterns and tab titles are user- or
  web-controlled.
- Pending/kept/firstSeen maps are keyed by string tab ids (JSON keys); timers and alarms use numbers.
- Saving a rule writes two sync keys; background.js debounces `onChanged` by 100 ms so one save means one rescan.
- User regexes are built inside try/catch with a pattern-length cap.
- Selector lists are split on top-level commas and each alternative is evaluated separately, in written order.
  Never pass the whole list to `querySelectorAll`: page order would let a generic fallback win.
- Never rename a tab group that is not in the grouping record (protects hand-made groups). A failed or empty
  status read never clears an existing suffix.
- `chrome.permissions.request` only works inside a user-gesture handler before any `await`.
- Headless Chrome cannot answer permission prompts: the e2e loads a temp copy of the extension with the fixture
  origin pre-granted. Keep the shipped manifest's host access optional.
