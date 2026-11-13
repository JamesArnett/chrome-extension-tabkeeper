# Releasing Tabkeeper

The next source version is **1.1.1**, hardening settings imports, regex handling, page status reads and tab closing
for Chrome and desktop Firefox. GitHub Actions can publish both browser ZIPs and submit store updates.
Each store controls its review and approval.

## Workflows

| Workflow | Trigger | Result |
| --- | --- | --- |
| CI | Branch pushes, pull requests, manual runs and weekly | Node 20 compatibility; Node 24 coverage, package validation and Chrome tests. Saves reports and ZIP; writes measured test/coverage summaries. |
| Security | Branch pushes, pull requests, manual runs and weekly | CodeQL and OSV scans, native status badge, job summaries with finding counts and downloadable reports. Also reused to gate releases. |
| Release | Push a `v<version>` tag | Repeats validation, browser tests and security scans, then creates a GitHub release containing both tested browser ZIPs. |
| Chrome Web Store | Actions → Chrome Web Store → Run workflow | Checks out, tests and scans the supplied tag, uploads its tested ZIP as a draft, and optionally submits it for review. |

Versions in `manifest.json`, `package.json`, the root package metadata in `package-lock.json`, the ZIP, and the
release tag must agree. A mismatch between the manifest, package version and tag fails the run.
The store workflow defaults to **upload only**. Select **Submit** to request review and automatic publication after
approval. It uses the official v2 API, waits for asynchronous upload completion, and blocks submission on warnings.
Publishing secrets are only provided to the publishing job, after the checks pass; CI on pull requests has none.
Any dependency vulnerability or high/critical CodeQL finding blocks publishing. See
[security checks](SECURITY_CHECKS.md) for local scanner setup, gate details and badge behavior.

## One-time account setup

1. Register at the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Create a new item by manually uploading `dist/tabkeeper-1.1.0.zip`. The API updates existing items;
   it cannot create the initial listing. Record its 32-character extension ID and your publisher ID.
3. Complete the listing using [STORE_LISTING.md](STORE_LISTING.md), images from `store/`, and the privacy declarations
   in the current dashboard. Verify the [privacy policy](PRIVACY.md) URL is accessible publicly. If the repository
   is private, host the policy publicly elsewhere and update the listing URL.
4. Follow Google's [API credentials guide](https://developer.chrome.com/docs/webstore/using-api) to enable the
   Chrome Web Store API, create an OAuth client, and obtain a refresh token with
   `https://www.googleapis.com/auth/chromewebstore` scope for the account that can manage the item.
   Configure the OAuth consent app for lasting access; tokens for external apps left in Testing can expire.
   Do not commit tokens or paste them into issues or chat.
5. In this repository's **Settings → Environments**, create `chrome-web-store`. Add these environment values:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `CWS_PUBLISHER_ID` | Publisher ID from the developer dashboard |
| Variable | `CWS_EXTENSION_ID` | Extension ID from the initial listing |
| Secret | `CWS_CLIENT_ID` | OAuth client ID |
| Secret | `CWS_CLIENT_SECRET` | OAuth client secret |
| Secret | `CWS_REFRESH_TOKEN` | OAuth refresh token |

Optionally restrict which branches can deploy to this environment and require a reviewer. These are GitHub
configuration options, not extra application requirements. The GitHub Release workflow uses the built-in
`GITHUB_TOKEN`; no personal access token is needed.

## Before the first public release

Run `npm run security` locally after installing the scanners, plus `npm run coverage:ci`, `npm run package` and
the browser integration tests. GitHub-native workflow badges and code-scanning uploads are verified by the pushed runs. Enable GitHub secret
scanning/push protection and require both CI and Security checks through the repository's rulesets.

Automated checks cover matching, countdown groups, Keep, age closing, popup/settings, injected status readers,
and a grouping alarm waking a stopped worker. They pre-grant fixture host permissions. They cannot certify
authenticated third-party markup or native permission prompts.

- [ ] On an unpacked test install, grant a site's optional permission; confirm denial is handled and granting
      enables status reads. Revoke the permission in Chrome and confirm grouping still works without status reads.
- [ ] On a real AWS Console tab, use AWS → Test to verify account, role and region. Test a role switch.
- [ ] Test GitLab issue, Azure DevOps and ServiceNow presets on the intended authenticated sites. They remain
      labelled unverified; do not change their `verified` flags without a live check.
- [ ] In normal Chrome, check shortcuts, snooze expiry, Reopen, Closing group placement/collapse and first-install guide.
- [ ] Confirm store visibility, regions, privacy declarations, public support URL and public privacy-policy URL.
- [x] Prepare the actual product screenshots in `store/` at 1280×800. Selected images and supporting captures
      are ready for Git; visible name approved, tenant hostnames masked, resized redactions verified.

These checks remain manual; fixture tests are not evidence of live AWS or other product compatibility.

## Creating a release

Update the manifest, package and lockfile versions together. Commit and push the release source first, then
wait for CI and Security to pass. Keep account credentials private. `HANDOFF.md` and `PLAN.md` are local working
notes ignored by Git.

Once the manual checks are complete, validate and create a signed annotated release tag with change details:

```sh
npm test
npm run coverage
CHROME="/path/to/Chrome for Testing" npm run e2e
npm run package
git tag -s v1.1.1
git push origin v1.1.1
```

Wait for **Release** to pass. Download the ZIP from the GitHub release or run **Chrome Web Store**, supply
`v1.1.1`, and choose upload-only or submission. A green submission means the API accepted the request;
check the developer dashboard for review status. If a submission has warnings or fails, fix them in the
dashboard before retrying. Do not overwrite or move released tags.

For updates, increment the manifest, package and lockfile versions, commit and push, then tag that version. Chrome Web Store versions
must increase. To revert behavior, ship the previous code with a new, higher version.

API references: [upload](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload),
[upload status](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus),
[submit for review](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish).

## Firefox / AMO

The reusable verification workflow also validates and tests desktop Firefox. Releases attach a second package,
`tabkeeper-firefox-<version>.zip`, generated from the same source. The manual **Firefox Add-ons** workflow
defaults to validation only; selecting Submit sends the checked package to AMO for listed distribution.
Create the initial AMO listing manually and configure `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` in the
`firefox-add-ons` GitHub environment. See [Firefox setup and release instructions](FIREFOX.md). Do not change
the repository name or existing Chrome support/privacy URLs as part of browser packaging.
