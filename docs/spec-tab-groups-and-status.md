# Spec: rule-based tab grouping and live page status

You are extending **Tabkeeper** (this repository) with two new features. Read `AGENTS.md` and, if available, the local `PLAN.md`
first and keep to their conventions: Manifest V3, vanilla ES modules, no bundler, thin entry points, all logic
in dependency-injected modules that run under `node --test`, popup DOM built with `createElement` and
`textContent` only.

This document is a **behavioural specification**, not a design. It describes what the user sees and the
problems that any implementation of this behaviour will run into. Design your own architecture, module
boundaries, storage layout and naming that fit this codebase.

## Ground rules

1. **Independent implementation.** The behaviour below was prototyped in a fork of a third-party extension
   (Tab Star). That project has no licence file, so its code is not available for reuse. Do not fetch, read or
   paraphrase the Tab Star source or the fork. Work only from this document and from Chrome's documentation.
   Where this document mentions how the prototype did something, it is explaining a pitfall, not prescribing
   a solution.
2. **Scope.** Two features: (A) group tabs by a URL rule, (B) append a status read from the page to the group
   title. Everything else in this document, including the popup behaviour, settings and presets, exists to
   serve those two. Do not add features that are not listed.
3. **Where this says "Ask James", stop and ask before deciding.** Otherwise make ordinary judgement calls
   yourself and record them in `PLAN.md`.
4. **Permissions are part of the spec.** Feature B cannot be built without the `scripting` permission and
   per-origin optional host permissions. See "Permissions" below. This is a deliberate change from the
   current "no host permissions" stance in `PLAN.md`; update `PLAN.md` to record it.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Grouping rule | A user-defined rule that puts matching tabs into a Chrome tab group. |
| Base title | The group title produced by the rule before any status is appended, e.g. `ABC-123`. |
| Status | A short string read from the page, e.g. `In Progress`. |
| Status suffix | ` - <status>` appended to the base title. The full title is `ABC-123 - In Progress`. |
| Status field | One thing to read from the page: a CSS selector plus an optional "keep only" regex and label. |
| Dynamic title | A base title that contains a captured part of the URL, so each ticket gets its own group. |
| Fixed title | A base title with no captured parts; every matching tab goes into the same group. |

---

## Feature A: group tabs by URL rule

### What a grouping rule contains

| Field | Behaviour |
| --- | --- |
| Rule name | Display-only label for the rule list. Never appears in the tab strip. If left blank, defaults to the group title template. |
| URL regex | A JavaScript regular expression, entered without slashes or flags. Matched with `RegExp.prototype.exec` semantics against the tab URL first, and if that fails, against the tab title. Capturing groups `( )` feed the title template. |
| Group title template | Either plain text (fixed title) or text containing `$1` to `$9`, which are replaced with the corresponding capture groups (dynamic title). |
| Colour | One of Chrome's eight tab group colours: grey, blue, red, yellow, green, pink, purple, cyan. |
| Random colour | When on, each **newly created** group gets a random colour instead of the chosen one. Only applies to dynamic titles; a fixed-title rule always uses its chosen colour. |
| Enabled | Per-rule toggle. Disabled rules never match. |
| Status enabled | Turns on Feature B for this rule. |
| Status fields | One or more status fields (Feature B). |
| Site origin | The http(s) origin the user grants page access for (Feature B). |

### Matching

- Tabs whose URL starts with `chrome://`, `chrome-extension://` or `about:` are never matched.
- Evaluate rules in list order against the **URL**. The first enabled rule that matches wins. Only if no rule
  matches the URL, evaluate rules in list order against the tab **title**. Title matching exists for sites
  whose identifier is not in the URL (ServiceNow puts the incident number in the title, not the URL).
- A rule whose regex does not compile is skipped and an error is logged. It must not stop other rules from
  being evaluated.
- Compile each regex once per rule change, not on every tab event.
- Close-rule, grouping, AWS URL and keep-only regexes share a 500-character pattern cap and conservative
  structural checks. Repeated groups containing repetition or alternatives, backreferences, and finite
  repetition counts above 1,000 are rejected on Save/import and during runtime compilation, including synced
  or previously saved rules. These checks can reject some valid patterns and reduce backtracking risks without
  providing a guaranteed execution deadline.
- URL/title regex matching skips subjects longer than 4,096 characters. Page status text and raw previews
  use only the first 4,096 characters before keep-only matching. The ordinary 80-character status cap still applies.

### Resolving the base title

1. If the template contains `$N` tokens, replace each with capture group N, or with nothing if that group did
   not participate. Collapse runs of whitespace to one space and trim.
2. If the expansion is empty (every referenced group was empty), fall back to the rule name, then to the raw
   template.
3. If the template has no `$N` tokens, use it verbatim.

Examples:

| Regex | Template | URL | Base title |
| --- | --- | --- | --- |
| `/browse/([A-Z]+-\d+)` | `$1` | `.../browse/ABC-123` | `ABC-123` |
| `github\.com/[^/]+/([^/]+)/pull/(\d+)` | `$1#$2` | `.../hello-world/pull/42` | `hello-world#42` |
| `github\.com/` | `GitHub` | any GitHub page | `GitHub` (one group for all) |

### When a tab is evaluated

- When a tab finishes loading (`status === 'complete'`).
- When a tab's URL changes while it is already complete. Jira Cloud and GitLab are single-page apps and
  navigate from one ticket to another without a page load. Without this, a tab that moves from `ABC-123` to
  `ABC-124` stays in the `ABC-123` group.
- When the user clicks **Apply to current tab** in the popup.

Apps that change content without changing the URL are not re-grouped. That is an accepted limitation.

### Placing the tab in a group

Groups are **per window**: the same base title in two windows is two groups. For a matched tab:

1. Look for the group that belongs to this base title in this window.
2. If none exists, create a new group containing the tab, titled with the base title, coloured per the rule.
3. If one exists and the tab is not already in it, move the tab into it. If the tab is already in it, do
   nothing.

### Recognising "the group for this base title" when the title has changed

This is the central difficulty of Feature A once Feature B exists. The group's visible title is not stable:
it becomes `ABC-123 - In Progress`, then `ABC-123 - Done`, and may be shortened to `ABC-12… - Done` by the
title-length setting. The extension must still recognise it as the `ABC-123` group when a second `ABC-123`
tab opens or the page refreshes.

Required behaviour:

- Keep a **record of the groups the extension created or adopted**, keyed by window and base title, holding
  the group id and the status currently shown. Chrome group ids do not survive a browser restart, so this
  record should live in session-scoped storage, not synced or local storage. It must survive the service
  worker being suspended and restarted.
- When the record has no entry for a base title (fresh session, worker restarted before the record was
  written, group created by an older version), **fall back to scanning the window's existing groups by
  title** and adopt the first one whose title could have been produced from this base title. When adopting,
  recover the status from the title so the record is complete.
- Title tolerance during that scan is deliberately narrow:
  - An exact match (`ABC-123`) always counts.
  - The `ABC-123 - <anything>` form only counts if the rule has status enabled.
  - The shortened `ABC-1… ` or `ABC-1… - <anything>` form only counts if the title-length limit is on, the
    head is at least 3 characters, and the base title starts with the head.
  - Rationale: a fixed-title rule named `GitHub` must not adopt a group the user created by hand and named
    `GitHub - Docs`. Rules without status keep exact-match semantics.
- When Chrome reports a group was removed, forget its record entry.
- **Never rename a group that is not in the record.** This is the only thing that protects groups the user
  made by hand.

### Concurrency

Opening a ticket often opens several tabs for it at once (or one tab fires `complete` and a URL change back
to back). If two evaluations for the same base title both look up the group, both see "no group yet" and
both create one, leaving two `ABC-123` groups. Every read-modify-write of the group record, and the group
lookup that depends on it, must be serialised. The existing scheduler already serialises through a promise
queue; use the same discipline for this.

---

## Feature B: append a live status from the page

### Title format

`<base title>` when no status is known, `<base title> - <status>` once one is. The separator is a space,
hyphen, space. When a rule reads several status fields, their values are joined with ` · ` (space, middle
dot, space): `project!17 - Open · CI passed`.

### Status fields

Each field has:

| Part | Behaviour |
| --- | --- |
| Selector | A CSS selector. **A comma-separated list is a list of ordered fallbacks**, not a single selector. Each alternative is evaluated on its own, in the order written; the first alternative that yields an element with non-empty text wins. The pitfall: passing the whole list to `querySelectorAll` returns matches in **page order**, so a generic last-resort alternative such as `.badge` beats a specific one whenever both are present. On GitLab this picked up a "Beta" badge instead of the merge request state. Split on top-level commas only, so `:is(a, b)` and attribute values containing commas stay intact. An alternative that is not valid CSS is skipped; the others are still tried. |
| Keep only | Optional regex applied to the element's text, case-insensitive. If it has a capture group, the first group is kept, otherwise the whole match. `#\d+\s+(\S+)` turns `Pipeline #18395789 passed` into `passed`. If it does not match, the field has no value and the diagnostic says so. |
| Label | Optional plain prefix: label `CI` and value `passed` gives `CI passed`. |

An empty selector is treated as the default Jira selector (see presets). The first field cannot be removed;
the popup always shows at least one row.

### What "the element's text" means

- `<select>`: the text of the selected option, falling back to the control's value.
- `<input>` and `<textarea>`: the control's value.
- Skip password and hidden inputs. Skip input, textarea and select controls whose autocomplete tokens include
  username, current-password, new-password, one-time-code or any `cc-` payment-card hint. Excluded controls provide
  neither a value nor raw diagnostic text; continue to later matches or selector alternatives.
- Anything else: `textContent`.
- In all cases, collapse whitespace runs to one space and trim. An element whose text is empty after this
  does not count as a match; keep looking.

### Reading the page

- The reader runs **inside the page** (injected from the service worker; it needs the `scripting`
  permission and host access to the origin, see Permissions). It is injected into **all frames**, because
  classic ServiceNow renders its form inside an iframe. Cross-origin frames whose origin has not been
  granted are simply not searched.
- The reader must be **self-contained**: it cannot reference anything from the service worker's scope.
- Pages render late. Jira Cloud shows the status button seconds after `complete`. The reader therefore
  waits until **every** field has a value, or a timeout, whichever comes first, then returns whatever it has.
  Fields that never appeared are omitted from the joined status rather than failing the read. Use a
  `MutationObserver` to wake up when the DOM changes rather than polling.
- Timeouts: **10 seconds** for a real read on tab load, **3 seconds** for the popup's test button.
- With several frames, prefer the frame that produced the most field values. On a total miss, prefer the
  frame whose selectors matched the most elements, so the diagnostics can say "matched 3 elements but none
  had text" rather than "matched nothing".
- Each field's result carries diagnostics for the popup: the value, the raw text before "keep only", a short
  description of the element it came from (tag, id or `data-testid` or `aria-label` or first two classes,
  plus up to two identifiable ancestors, e.g. `button[data-testid="…"] (inside div#status › form.issue)`),
  how many elements the selectors matched, and an error code from: invalid selector, invalid keep-only
  regex, keep-only did not match, keep-only kept nothing, matched elements but none had text, matched
  nothing.

### Normalising the status

Before the status touches a title, collapse whitespace and **cap it at 80 characters**, ending in `…` when
cut. This stops a wrong selector from dumping a paragraph into the tab strip. The same normalisation must be
used for the popup's preview, so what the user sees in Test is exactly what the group gets.

### Applying the status to the group

- Only groups in the record may be renamed (see Feature A).
- The caller knows which base title the tab belongs to. If the tab's group is in the record **under a
  different base title**, refuse and log a warning. This happens when the user drags an `ABC-124` tab into
  the `ABC-123` group: the group must not be renamed to ABC-124's status.
- If the normalised status equals the status already recorded for the group, do nothing. This avoids
  pointless API calls and flicker.
- If the group no longer exists, drop its record entry.
- A **failed or empty read never clears an existing suffix**. The group keeps its last known status.
- One status per group. If several tabs in the group report, the most recent read wins.

### Live updates without a reload

After the first successful read on a tab, the page must be **watched** so that changing the status in the
product's UI (dragging a Jira card, merging an MR) renames the group without a refresh.

- Install one observer per document, even if the reader is injected again (a second injection should update
  the observer's idea of the current value, not add a second observer).
- Observe the whole document for child, subtree, character data and `value` attribute changes. Debounce
  about 250 ms, then re-run the same read. Report to the service worker only if the new status is non-empty
  and differs from the last reported one.
- **The service worker must not trust these reports blindly.** A page the user has navigated away from (or
  a tab that was moved) can still have a live observer. Before applying a reported status, verify that the
  sending tab is in a group, that the tab's current URL or title still matches a rule with status enabled,
  and that the group is recorded under that rule's base title (the same drag check as above). Otherwise
  ignore the report.
- Reports sent after the extension reloads will fail to deliver; the page-side code must swallow that.

### Permissions

- Before a status or AWS permission request, show a contextual explanation in the popup/settings page.
  Identify the saved rule's site separately from the current tab used by Test; explain AWS's console-subdomain
  grant. Chrome's dialog cannot contain custom extension text. Host access is site-wide, not selector-limited;
  describe configured text/form-value reads, optional access, and the fact that closing/basic grouping work
  without it. Keep request calls directly in the user gesture handler, before any await.
- Provide a bundled permissions/privacy guide and links from the popup. Explain tab metadata access without
  host grants, Chrome Sync for rules/settings, local close history/drafts, temporary group/status/account state,
  no developer uploads, and the need to reload affected pages after revocation to remove existing readers.
- Add the `scripting` permission.
- Declare `http://*/*` and `https://*/*` as **optional** host permissions only. Never move them into
  required `host_permissions`; the point is that installing the extension triggers no all-sites warning and
  the user grants exactly the sites they track.
- The popup requests `<origin>/*` for the rule's site origin when the user saves a status-enabled rule, and
  for the active tab's origin when they click Test. The request **must be issued from inside the click
  handler before any other `await`**, or Chrome rejects it for lacking a user gesture.
- If the user declines, the rule is still saved and a message explains that status will not be read until
  access is allowed. Grouping (Feature A) works regardless of permissions.
- Before injecting, check that the origin is granted. If not, skip the read and log a console warning.
  Never attempt to inject into an ungranted origin.

---

## Settings

One global setting: **Max group title length**.

- `0` means no limit. Any value from 1 to 11 is raised to 12, because nothing shorter can hold a name and a
  status. Stored locally (not synced), since it depends on the user's screen.
- Chrome renders a group title on one line and truncates the **end** when the tab strip is crowded, which is
  where the status lives. The setting therefore shortens the **base title** with `…` and always keeps the
  full status suffix.
- The base is never cut below 8 characters, so ticket keys like `ABC-123` and `INC0010042` stay whole even
  if the title then exceeds the limit. Identity beats the limit.
- The shortened head is trimmed of trailing whitespace before the `…`.
- Changing the setting re-titles every group in the record immediately and the popup reports how many were
  changed.

| Setting | Title |
| --- | --- |
| 0 | `perimeterx-lambda-at-edge pipeline #18395616 - Blocked` |
| 32 | `perimeterx-lambda-at-… - Blocked` |
| 20 | `perimeter… - Blocked` |

The ellipsis character and separator are load-bearing: title shortening, the title-scan tolerance in
Feature A, and status recovery from an adopted title all depend on them. Keep them in one place.

---

## Popup behaviour

Everything lives in the existing popup. **Ask James** how the new sections should sit alongside the existing
close rules (same list with a type badge, a separate section, or tabs) before building the UI.

### Rule list entry

Shows the rule name with a colour dot, a `STATUS` badge when status is enabled, an enable toggle, the title
template (with `(fixed)` when it has no `$N`), the regex, and for status rules a one-line summary of the
status fields (`label: selector → /keep-only/`, joined by ` · `) plus the site origin. Edit and Delete
(with confirmation).

### Rule form

Three numbered sections, in this order, with one-line help under each field:

1. **Which tabs?** Rule name, URL regex.
2. **What should the tab group be called?** Title template, random colour checkbox, colour swatches.
3. **Show a status from the page? (optional)** A checkbox that reveals: a short explanation, a collapsible
   "What is a CSS selector and how do I get one?" explainer (right-click the status, Inspect, prefer
   `id` / `data-testid` / `aria-label` over generated class names, paste it and Test), the status field
   rows with **Add another status field** and per-row Remove, and the **Site origin** field pre-filled from
   the active tab's origin.

Above the form, a **Start from a preset** menu. Choosing a preset fills rule name, regex, title template,
turns status on, fills the status fields, fills the origin from the active tab if empty, and shows the
preset's notes with its example title. Unverified presets are suffixed `(unverified)` in the menu and the
hint warns the user to Test first.

A **Full guide** link opens a bundled help page in a new tab (content: what a selector is, finding one in
DevTools, preferring stable attributes, verifying in the console, fallbacks, multiple fields, testing,
keeping titles short, things to know). Keep the help page and any Markdown docs in sync.

### Validation (on Save and on Test)

- Regex is required; title template is required for Save but not for Test.
- Regex must compile.
- Apply the shared regex safety checks described under Matching to URL and keep-only patterns.
- If the template uses `$N`, the regex must contain at least one unescaped capturing group `(` not followed
  by `?`. Otherwise explain how to add one.
- Each status selector must be valid CSS (probe it with `querySelector` in a try/catch) and each "keep only"
  regex must compile. Report the field number.
- Site origin must be an http(s) URL; normalise whatever the user typed (with or without scheme) to a bare
  origin.

### Buttons

**Add rule / Update rule.** Requests the origin permission (user gesture, see Permissions), saves, refreshes
the list, resets the form.

**Test on current tab.** A dry run: nothing is grouped, no observer is installed. Requests permission for
the active tab's origin, then shows a result panel coloured green (all good), amber (partial) or red
(error) with rows:

| Row | Content |
| --- | --- |
| Group title | The resolved base title, with `(same for every matching tab)` for fixed titles. If the regex did not match, say so and show the tab's URL and title so the user can see why. If it matched but the title is empty, tell them to fill in the template. |
| Status / Field N | The value, then `(kept from "<raw>")` when keep-only changed it, then `read from <element description>`. On failure, a plain-language explanation keyed to the error code (see table below). |
| Final title | The preview, run through the same normalisation and shortening as a real update. When shortened, label it `Final title (shortened to N)`. |

Failure explanations:

| Error | Message |
| --- | --- |
| regex did not match | The URL regex matches neither the URL nor the title. Check escaping (`\.` for dots). |
| access not granted | Access to `<origin>` was not granted. Click Test again and allow it. |
| matched nothing | Selector matched no element within 3 seconds. Right-click the status, Inspect, copy a stable id or data-testid. |
| matched N but no text | You probably selected a wrapper or an icon. Try the parent, or the inner element that holds the words. |
| keep-only did not match | Show the raw text that was read so the user can adjust the regex. |
| keep-only kept nothing | Check the parentheses. |
| browser page | The current tab is a browser page the extension cannot read. Open a normal web page. |

**Apply to current tab.** Runs the **saved** rules against the active tab. On a match the popup closes. On
no match, explain that Apply only runs saved rules and point to Add rule or Test if the form has content.

### Stale service worker banner

Chrome keeps the old service worker running after files on disk change until the extension is reloaded,
which produces baffling behaviour during development (templates not expanding, new messages unknown). The
prototype kept a build number that the popup compared against the worker's on open and showed a "Reload
extension" banner with a button that calls `chrome.runtime.reload()`. **Ask James** whether to carry this
over; it is a developer convenience, not user-facing behaviour.

---

## Presets

Presets are starting points, shared by the popup (menu) and the service worker (default selector). Each has
an id, display name, regex, title template, status fields, example URL, example title, a verified flag and
one or two sentences of notes. **Verified** means the selectors were confirmed on the live product in
October 2026; everything else was derived from the product's markup and may need adjusting. Only flip a
preset to verified after confirming it live.

The default selector, used when a status field's selector is blank, is the Jira one.

| Service | URL regex | Title template | Status fields (selector; keep only; label) | Verified |
| --- | --- | --- | --- | --- |
| Jira (Cloud & Data Center) issue | `/browse/([A-Z][A-Z0-9_]+-\d+)` | `$1` | `[data-testid="issue.views.issue-base.foundation.status.status-field-wrapper"] button, #status-val` | Yes |
| GitHub pull request / issue | `github\.com/[^/]+/([^/]+)/(?:pull\|issues)/(\d+)` | `$1#$2` | `[data-testid="header-state"], .gh-header-meta .State, .gh-header-sticky .State` | No |
| GitLab merge request (+ pipeline) | `/([^/]+)/-/merge_requests/(\d+)` | `$1!$2` | Field 1: `.merge-request-sticky-header .detail-page-description .gl-badge .gl-badge-content, .merge-request-details .detail-page-description .gl-badge .gl-badge-content, .issuable-status-badge .gl-badge-content, [data-testid="issuable-status-badge"] .gl-badge-content`. Field 2: `.mr-pipeline-title`; keep only `#\d+\s+(\S+)`; label `CI` | Yes |
| GitLab issue | `/([^/]+)/-/issues/(\d+)` | `$1#$2` | `.issuable-details .detail-page-description .gl-badge .gl-badge-content, .issuable-status-badge .gl-badge-content, [data-testid="issue-state-badge"] .gl-badge-content, [data-testid="work-item-state-badge"], .issuable-status-badge` | No |
| GitLab pipeline | `/([^/]+)/-/pipelines/(\d+)` | `$1 pipeline #$2` | `[data-testid="pipeline-details-header"] [data-testid="ci-icon-text"], [data-testid="ci-icon-text"]` | Yes |
| Azure DevOps work item | `dev\.azure\.com/[^/]+/([^/]+)/_workitems/edit/(\d+)` | `$1 #$2` | `input[aria-label="State Field"], [aria-label="State Field"] input` | No |
| ServiceNow incident | `\b(INC\d{7,})\b` | `$1` | `select[id$=".state"] option:checked, [aria-label="State"] input` | No |

Example titles: `ABC-123 - In Progress`, `hello-world#42 - Open`, `project!17 - Open · CI passed`,
`project#5 - Open`, `project pipeline #18395616 - Blocked`, `Project #1234 - Active`,
`INC0010042 - In Progress`.

Notes worth keeping with the presets:

- **Jira.** First alternative is the status button on Jira Cloud, second the status field on Server/Data
  Center.
- **GitHub.** Reads Open, Draft, Merged or Closed. GitHub Enterprise users replace the hostname.
- **GitLab MR.** Confirmed on GitLab 19.3 self-managed. The state badge is in the sticky header under
  `.detail-page-description`. It is **not** inside `.detail-page-header`: that row holds the "Try Rapid
  Diffs · Beta" badge, and the tab strip holds count badges, all using `.gl-badge-content`. The older
  `.issuable-status-badge` alternatives are fallbacks for other GitLab versions. Field 2 reads the pipeline
  widget text `Pipeline #18395789 passed` and keeps the last word; MRs without a pipeline show field 1 only.
- **GitLab pipeline.** Job badges lower on the page reuse `data-testid="ci-icon-text"`, so the
  header-scoped alternative is listed first.
- **Azure DevOps.** The State field is an `<input>`, so the value is read. `*.visualstudio.com` hosts need
  the regex edited.
- **ServiceNow.** The incident number is not in the URL, so the regex matches the tab title. Classic UI
  renders the form in an iframe. Workspace (Next Experience) layouts may need a different selector.

---

## Pitfalls and guards, in rough order of pain

Some of these were bugs the prototype hit (duplicate groups, single-page navigation, the GitLab badge,
the stale worker); the rest are guards it carries. An independent implementation needs all of them.

1. **Duplicate groups.** Several tabs for one ticket finishing together each created a group. Serialise all
   group-record reads and writes.
2. **Service worker restarts mid-session.** In-memory state vanished; groups were no longer recognised.
   Keep the record in session storage, await its load in every handler, and fall back to a title scan.
3. **Single-page navigation.** Jira Cloud and GitLab change the URL without a load event. Handle URL change
   on an already-complete tab, not just `complete`.
4. **Comma selectors evaluated in page order.** A generic fallback beat the specific selector. Evaluate
   alternatives one at a time in written order.
5. **Stale observers renaming the wrong group.** A page navigated away from kept reporting. Verify the
   sender tab still matches a status rule and that its group is recorded under that rule's base title.
6. **Dragged tabs.** A tab dragged into another ticket's group renamed that group. Pass the expected base
   title into the rename and refuse on mismatch.
7. **Hand-made groups renamed.** Only rename recorded groups, and keep title-scan tolerance narrow for
   fixed-title rules.
8. **Paragraph in the tab strip.** A wrong selector read a whole description. Cap status at 80 characters.
9. **Chrome truncating the status away.** Long project names hid the status. Shorten the base, never the
   status, and never below 8 characters.
10. **Old worker still running after edits.** Mystifying during development. Some kind of build check or a
    habit of reloading from `chrome://extensions` after every worker edit.
11. **Permission request rejected.** `chrome.permissions.request` must run in the click handler before any
    other `await`.
12. **Injected function captured worker scope.** Anything the injected reader references must be defined
    inside it, or passed as an argument.
13. **Null reads must not clear a good status.** A transient miss while the page is still rendering
    would otherwise blank the suffix. Keep the last known status.
14. **Group ids reset on browser restart.** Hence session storage for the record and adoption by title.
15. **Late-rendering pages.** Wait on a `MutationObserver` with a deadline rather than polling on an
    interval; it wakes exactly when the DOM changes and costs nothing while idle.
16. **Invalid selector alternative threw and aborted the read.** Catch per alternative, keep trying.
17. **Random colour is for dynamic titles only.** A fixed-title rule has one shared group, and recreating
    it with a new random colour each session would be confusing. Pick the colour once, at creation.
18. **Rename churn.** Re-applying an identical status on every observer tick spammed the API. No-op when
    unchanged.

## Accepted limitations

- Status is shown at the group level only; per-tab titles are untouched.
- One status per group; the most recent read wins.
- Manually renaming a tracked group is overwritten on the next status update.
- Cross-origin iframes are searched only if their origin was granted.
- Apps that change content without changing the URL are re-read by the observer but not re-grouped.
- Groups are per window.

## Behaviours to cover with tests

The matcher, title resolution, title building and shortening, title-scan tolerance, status normalisation,
group-record logic (including the concurrency case and the dragged-tab case), the selector-list splitter,
and the keep-only extraction are all pure or dependency-injected and belong under `node --test` with the
existing Chrome mock. At minimum:

- URL matched before title; first enabled rule wins; invalid regex skipped; `chrome://` ignored.
- `$1`/`$2` expansion, whitespace collapse, empty expansion falls back to rule name, fixed title verbatim.
- Group found by record; found by exact title; found by ` - status` only when status enabled; found by
  `head…` only when limit set; hand-made `GitHub - Docs` not adopted by fixed rule `GitHub`.
- Two concurrent evaluations for the same base title create one group.
- Status applied; identical status is a no-op; unrecorded group refused; mismatched base title refused;
  removed group dropped from record; null read leaves suffix alone.
- Shortening: limit 0, limit under 12 raised, base never below 8, status never cut, trailing space trimmed
  before `…`, status over 80 characters capped.
- Selector list split respects quotes, parentheses and brackets; alternatives tried in order; invalid
  alternative skipped.
- Keep-only: capture group kept, whole match kept when no group, no match reported, empty capture reported.
- Element text: select option text, input value, textContent, whitespace collapsed, empty text skipped.
- Observer report ignored when the tab no longer matches a status rule or its group is recorded elsewhere.

The injected reader and the popup cannot be unit-tested in Node; extend `scripts/e2e.mjs` to load a local
fixture page with a late-rendering status element and assert the group title, then change the element and
assert the rename.


## Cross-browser delivery (2026-11-07)

Chrome and desktop Firefox use the same scheduler, grouper, reader and UI. The root manifest remains the
Chrome target; packaging generates Firefox's module event-page manifest with a stable AMO ID and desktop
minimum version 140. Browser API namespace selection and Firefox host-pattern normalization live in
`src/browser-api.js`; no runtime polyfill or source fork is required. Optional site access remains optional
in both shipped targets. Firefox grants cover the host's ports, while rules still match actual URLs.

Extension UI messages are authorized from browser-supplied sender ID and the complete extension URL prefix,
so both chrome-extension and moz-extension origins work without trusting web-page readers. Guard Chrome-only
tab replacement events. Browser-specific settings links, permission instructions and sync-provider wording
must reflect the running browser. Browser-managed sync does not transfer rules between Chrome and Firefox.

Firefox's native collapse behavior may leave the active tab visible while the other group members collapse;
do not move or close the active tab merely to emulate Chrome's native presentation. Other grouping, status,
Keep and age-close behavior remains as specified above. Android is not a supported target.

## AWS identity reads (2026-11-07)

AWS role selectors accept a complete `role/user` label or the complete label `root`. A successful read is
split into role and user; `root` has no separate user. If no selected element matches, retain its raw text
for Test diagnostics only. Failed or empty role reads must leave role/user absent from the composed group
title, never substitute unrelated navigation text such as “Recently visited”. Account and region fields
may still supply a partial title. Cover root sessions and failed matches in both browser integration suites.
