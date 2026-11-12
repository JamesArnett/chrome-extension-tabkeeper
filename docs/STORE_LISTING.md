# Chrome Web Store listing draft

Everything the Developer Dashboard asks for, ready to paste. Review the bracketed items before submitting.

## Store listing tab

**Name:** Tabkeeper

**Summary** (132 characters max):

> Close the tabs you never needed, group the ones you do. Auto-close rules, rule-based tab groups with live status, AWS Console sorting.

**Category:** Productivity → Tools [confirm the closest category in the current dashboard]

**Language:** English

**Description:**

```
Tabkeeper keeps your tab strip tidy without you thinking about it.

CLOSE TABS YOU NEVER NEEDED
Zoom "launching meeting" pages, sign-in confirmation pages, redirect stubs: describe them once by title or URL and
Tabkeeper closes them after a delay you choose. Tabs counting down wait in one red "Closing" group at the end of
your tab strip, and the toolbar popup shows each countdown with a Keep button.
• Match on title, URL or both: contains, starts with, ends with, equals, or a regular expression
• Per-rule delay, plus an optional grace period for login pages that bounce straight back
• Optional age limits: close tabs open longer than, or unused for, a time you set
• Pinned tabs are never closed. Age-based closing also skips active and audible tabs; explicit close rules can close them.
• Every close is listed with a Reopen button

GROUP TABS BY RULE, WITH LIVE STATUS
Put every tab for a ticket into one group named after it, e.g. ABC-123, and optionally add the status from the
page: "ABC-123 - In Progress". The title follows the page as the status changes.
• Presets for Jira, GitHub, GitLab merge requests, issues and pipelines, Azure DevOps and ServiceNow
• Test any rule on the current tab before saving it
• Fixed, random, or per-ticket colours

AWS CONSOLE TABS BY ACCOUNT AND ROLE
Every AWS Console tab is grouped by the account and role you are signed in as, including multi-session consoles.
Choose what the group title shows.

PRIVATE BY DESIGN
No servers, no accounts, no analytics. Tabkeeper reads page content only on sites you explicitly approve, and
no data is sent to the developer. When enabled, Chrome Sync stores and syncs rules and settings through your
Google account. These can include site URLs, patterns, selectors, AWS grouping settings and age-based closing
settings. Chrome can also sync tab group titles through its history and tabs sync setting. You control sync in
Chrome's sync settings.

Shortcuts: Alt+Shift+P pauses closing, Alt+Shift+G groups the current tab.
```

**Graphics** (all in `store/`):

| Slot | File |
| --- | --- |
| Store icon 128×128 | `icons/icon128.png` |
| Actual capture 1, close countdown and Keep | `store/screenshot-1-close-countdown.png` |
| Actual capture 2, Jira vertical tabs, To Do | `store/screenshot-3a-jira-to-do.png` |
| Actual capture 3, Jira vertical tabs, In Progress | `store/screenshot-3b-jira-in-progress.png` |
| Actual capture 4, Jira vertical tabs, Done | `store/screenshot-3c-jira-done.png` |
| Actual capture 5, AWS Console grouping | `store/screenshot-4-aws-console-grouping.png` |
| Small promo tile 440×280 | `store/promo-small-440x280.png` |
| Marquee promo tile 1400×560 (optional) | `store/promo-marquee-1400x560.png` |

The selected five captures show closing, the Jira status sequence To Do → In Progress → Done, and AWS grouping.
The Jira sequence replaces the earlier single vertical-tab capture. Each state shows the issue status and
matching tab-group title together with the options window closed.

The actual captures are final 1280×800 RGB PNGs in sRGB. Python/Pillow removed the 78-pixel black strip
along the top and 10 pixels from the bottom of each original, then resized with Lanczos filtering. Tab groups,
popups and status labels are preserved without distortion or added margins. James approved publishing his
visible name. Hostnames and the AWS account prefix remain masked; Jira masks cover the address bar and, where
present, the settings URL. Full-resolution redacted backups are outside the repository.

Additional supporting captures are `store/screenshot-2-jira-horizontal-tabs.png` and
`store/screenshot-jira-grouping-settings.png`. The horizontal capture includes a cookie banner. The settings
capture has its subdomain masked in both the address bar and expanded rule. Original unredacted captures and
the superseded vertical-tab image were moved to a private backup outside the repository.

Chrome's [screenshot guidance](https://developer.chrome.com/docs/webstore/images#screenshots) specifies
1280×800 or 640×400 pixels with square corners and full-bleed content. The older `screenshot-1…4-1280x800.png`
files are generated previews with sample data.

**Official URL / Homepage:** https://github.com/JamesArnett/chrome-extension-tabkeeper
**Support URL:** https://github.com/JamesArnett/chrome-extension-tabkeeper/issues

## Privacy practices tab

**Single purpose:**

> Tabkeeper manages browser tabs: it closes tabs that match the user's rules and organises tabs into tab groups
> according to the user's rules.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `tabs` | Reads the title and URL of open tabs to match them against the user's close and grouping rules, and closes or moves tabs when a rule applies. |
| `tabGroups` | Creates, names, colours, moves and collapses tab groups: the "Closing" group for tabs about to close, and groups made by the user's grouping rules. |
| `scripting` | On sites the user has explicitly granted, injects a reader for configured status text/form values or AWS navigation labels, to show them in tab group titles. It does not edit page content. |
| `storage` | Saves the user's rules and settings, the list of recently closed tabs, and temporary state such as countdowns. |
| `alarms` | Schedules tab closes that are more than 30 seconds away, the once-a-minute check for age-based closing, and the end of a snooze. |
| Host permissions (optional) `http://*/*`, `https://*/*` | No site access at install. Saving a status rule requests its site origin; Test requests the current tab's site. AWS grouping requests `https://*.console.aws.amazon.com/*` for regional/account console hosts. Chrome grants page access across each approved site, rather than access limited to one selector. The popup explains the scope before the request. |

The `tabs` permission produces Chrome's browsing-history access warning at installation because Tabkeeper reads
the titles and URLs of open tabs to match rules. Explain this in the listing alongside the optional site-access
disclosure and link to the privacy policy.

**Remote code:** No, I am not using remote code. All code is in the package.

**Data usage:** Disclose the local processing of open-tab titles/URLs, configured page status values and AWS
labels, local close history, and Chrome Sync for rules/settings through the user's Google account. Rules/settings
can contain internal hostnames and page selectors. Chrome's history and tabs sync can also sync group titles
containing status or AWS labels. The extension makes no network requests or
developer uploads, has no analytics, and does not sell data or use it for unrelated purposes or creditworthiness.
Select the applicable dashboard categories using its current definitions; review **Web history** and **Website
content** in particular. Keep declarations consistent with the privacy policy, rather than describing local
processing as no data access. Re-read the dashboard wording at submission time.

**Privacy policy URL:** https://github.com/JamesArnett/chrome-extension-tabkeeper/blob/main/docs/PRIVACY.md

Verify this URL is publicly accessible after the source is pushed. A private repository needs a separately
hosted public policy before submission.

## Distribution tab

Visibility: [Public | Unlisted]. Regions: [All regions].
