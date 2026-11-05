import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function summarizeSarif(documents) {
  let findings = 0;
  let blocking = 0;
  if (!documents.length) throw new Error('No CodeQL reports found.');
  for (const document of documents) {
    if (document.version !== '2.1.0' || !document.runs?.length) throw new Error('Invalid SARIF report.');
    for (const run of document.runs) {
      if (run.invocations?.some((invocation) => invocation.executionSuccessful === false)) {
        throw new Error('CodeQL analysis was incomplete.');
      }
      if (!Array.isArray(run.results)) throw new Error('Missing CodeQL results.');
      for (const result of run.results) {
        if (result.suppressions?.some((s) => s.status === 'accepted')) continue;
        if (result.kind && result.kind !== 'fail') continue;
        findings++;
        const rule = run.tool.driver.rules?.find((r) => r.id === result.ruleId);
        const severity = Number(rule?.properties?.['security-severity']);
        if (severity >= 7 || result.level === 'error') blocking++;
      }
    }
  }
  return { findings, blocking };
}

export function summarizeOsv(report) {
  if (!Array.isArray(report.results)) throw new Error('Invalid OSV report.');
  let packages = 0;
  let vulnerabilities = 0;
  for (const source of report.results) {
    if (!Array.isArray(source.packages)) throw new Error('Invalid OSV packages.');
    for (const pkg of source.packages) {
      packages++;
      // OSV groups aliases (CVE/GHSA/etc.) for one vulnerability together.
      vulnerabilities += pkg.groups?.length ?? pkg.vulnerabilities?.length ?? 0;
    }
  }
  return { packages, vulnerabilities };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync('reports', { recursive: true });
  const mode = process.argv[2];
  if (mode === 'codeql') {
    rmSync('reports/codeql.json', { force: true });
    const documents = readdirSync('reports/codeql').filter((f) => f.endsWith('.sarif'))
      .map((f) => JSON.parse(readFileSync(`reports/codeql/${f}`, 'utf8')));
    const summary = summarizeSarif(documents);
    writeFileSync('reports/codeql.json', JSON.stringify(summary));
    const message = `CodeQL: ${summary.findings} findings, ${summary.blocking} high/critical or error findings.`;
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CodeQL\n\n${message}\n`);
    if (summary.blocking) process.exitCode = 1;
  } else if (mode === 'osv') {
    rmSync('reports/dependencies.json', { force: true });
    rmSync('reports/osv-raw.json', { force: true });
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const declared = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
      .some((key) => Object.keys(pkg[key] ?? {}).length);
    if (declared && !['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'].some(existsSync)) {
      throw new Error('Dependencies require a committed lockfile for a complete scan.');
    }
    const scan = spawnSync(process.env.OSV_SCANNER ?? 'osv-scanner', [
      'scan', 'source', '--recursive', '--all-packages', '--all-vulns', '--format', 'json', '.',
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    process.stderr.write(scan.stderr ?? '');
    if (scan.error) throw scan.error;
    let summary;
    if (scan.status === 128 && !declared) {
      summary = { packages: 0, vulnerabilities: 0, note: 'No package sources found; package.json declares no dependencies.' };
      writeFileSync('reports/osv-raw.json', JSON.stringify({ results: [], note: summary.note }));
    } else if (scan.status === 0 || scan.status === 1) {
      writeFileSync('reports/osv-raw.json', scan.stdout);
      summary = summarizeOsv(JSON.parse(scan.stdout));
      if (scan.status === 1 && !summary.vulnerabilities) throw new Error('OSV reported an unclassified finding.');
      if (declared && !summary.packages) throw new Error('OSV did not discover the declared dependencies.');
    } else throw new Error(`OSV scan failed (exit ${scan.status}).`);
    writeFileSync('reports/dependencies.json', JSON.stringify(summary));
    const message = `OSV: ${summary.packages} packages, ${summary.vulnerabilities} vulnerable package/advisory pairs.`;
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Dependency vulnerabilities\n\n${message}\n\n${summary.note ?? ''}\n`);
    if (summary.vulnerabilities) process.exitCode = 1;
  } else throw new Error('Expected codeql or osv.');
}
