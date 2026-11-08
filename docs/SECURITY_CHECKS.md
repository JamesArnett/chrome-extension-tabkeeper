# Security checks and repository badges

The repository uses two complementary scanners without a paid account or additional GitHub secrets:

| Tool | What it checks | Release gate |
| --- | --- | --- |
| GitHub CodeQL | JavaScript/TypeScript and GitHub Actions, using `security-extended` queries | Findings with security severity >= 7.0, or SARIF error level |
| Google OSV-Scanner | Known vulnerabilities in discovered package dependencies | Any reported vulnerability, including low severity |

OSV-Scanner is open source (Apache-2.0). CodeQL's CLI is licensed under GitHub's terms and is free for public
repositories; its query libraries are open source. This repository is intended to be public. Review eligibility
before making it private. These checks complement code review and browser testing; their counts describe what
these scanners reported, rather than a guarantee that the extension has no vulnerabilities.

Tabkeeper has no runtime npm dependencies. Its locked Firefox development tools are included in OSV scans. OSV's no-packages result is accepted only when `package.json`
declares none. Errors fail the scan. If dependencies are added, commit the package manager's lockfile; the gate
rejects declared dependencies without one. The count is affected package/advisory pairs, with CVE/GHSA aliases
grouped together by OSV. It is not a count of source-code findings or secrets.

## Run before pushing

Use Node 24 or newer for the machine-readable coverage command. `npm test` and ordinary `npm run coverage`
also support Node 20.

1. Download the [official CodeQL bundle](https://github.com/github/codeql-action/releases) for your platform and
   extract it outside the repository. Choose `codeql-bundle-osx64` for macOS (also supports Apple Silicon for
   these interpreted languages). The bundle includes the compatible query packs.
2. Download [OSV-Scanner](https://github.com/google/osv-scanner/releases) for your OS/architecture and make the
   executable runnable. Verify both downloads against the published SHA-256 digests. CI pins OSV 2.7.0 and its
   Linux binary checksum; local OSV 2.7.0 and CodeQL 2.27.4 were used when adding this setup.
3. Put both executables on `PATH`, or set their paths:

```sh
export CODEQL="/path/to/codeql/codeql"
export OSV_SCANNER="/path/to/osv-scanner"
npm run security
npm run coverage:ci
npm run package
CHROME="/path/to/Chrome for Testing" npm run e2e
```

`npm run security` runs both CodeQL languages and OSV with the same queries and gates as CI, returning a nonzero
exit code for a blocking finding or a scanner error. Nothing is uploaded to GitHub. CodeQL database files are
created in the OS temporary directory and removed afterward. Scanning requires enough disk/RAM for CodeQL;
the local analysis uses two threads and a 4 GB RAM budget. OSV needs network access for vulnerability lookups
when packages are present. See [CodeQL installation](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/scan-from-the-command-line/set-up-codeql-cli).

Reports are written to ignored `reports/`: CodeQL SARIF, OSV JSON, and unit JSON. Open SARIF with a SARIF
viewer, or read the counts in `codeql.json` and `dependencies.json`. Optional
[actionlint](https://github.com/rhysd/actionlint)
validates workflow syntax locally; GitHub permissions, uploads, and native badges are verified in the pushed workflow runs.

## GitHub behavior

- CI and Security run independently on branch pushes, pull requests, manual dispatch, and weekly on the default branch.
- CodeQL uploads branch/PR findings to **Security → Code scanning**. Tag checks produce downloadable SARIF and
  gate release without uploading tag results to the dispatch branch. Use this workflow's advanced CodeQL setup;
  do not also enable a duplicate default-setup scan.
- Unit/coverage and scanner reports are retained as workflow artifacts for 14 days, including reports from
  failed gates when available. GitHub and Chrome Web Store publishing both depend on the security checks.
- The README displays only native GitHub workflow badges: **CI** and **Security** (CodeQL + OSV). These report
  workflow pass/fail status, not vulnerability counts or coverage percentages. The MIT license is linked in the
  README and exposed by GitHub's own license UI. There is no generated badge branch or badge publisher.
- Coverage percentages, test totals and security counts appear in the corresponding Actions job summaries.
  Full JSON/SARIF reports remain downloadable artifacts. Scanner errors fail the run rather than report zero.
- Coverage includes code exercised by Node tests, including release/reporting helpers. Browser-only extension
  entry points are covered by separate integration tests and are not part of the unit percentage.
- GitHub's native workflow badge does not display a coverage percentage. A standard percentage badge needs a
  coverage service such as Codecov or Coveralls; this repo currently uses GitHub-only summaries and reports.
  GitHub's own Code Quality coverage feature has separate plan/eligibility requirements and is not enabled here.
  No Codecov, Snyk, personal access token, or paid service is required for the configured checks.
- Actions are pinned to commit SHAs. Dependabot checks those references weekly. Update the OSV version and its
  verified checksum together when upgrading the scanner.

Also check GitHub's **Settings → Code security** after the first push: enable secret scanning and push protection
where available, and use branch protection/rulesets to require both CI and Security checks. Secret scanning is separate from these two
scanners and is not included in their vulnerability counts.

References: [CodeQL](https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-code-scanning),
[OSV output and exit codes](https://google.github.io/osv-scanner/output/),
[GitHub workflow badges](https://docs.github.com/en/actions/how-tos/monitor-workflows/add-a-status-badge),
[GitHub Code Quality coverage](https://docs.github.com/en/code-security/how-tos/maintain-quality-code/set-up-code-coverage).
