// Uses installed scanners; large tool bundles and databases stay outside the source tree.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const codeql = process.env.CODEQL ?? 'codeql';
const osv = process.env.OSV_SCANNER ?? 'osv-scanner';
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw new Error(`Cannot run ${command}. Install the scanner or set CODEQL / OSV_SCANNER.`, { cause: result.error });
  return result.status ?? 1;
}
for (const tool of [codeql, osv]) {
  if (run(tool, ['--version'])) process.exit(1);
}
mkdirSync('reports/codeql', { recursive: true });
rmSync('reports/codeql.json', { force: true });
rmSync('reports/dependencies.json', { force: true });
for (const file of ['javascript.sarif', 'actions.sarif']) rmSync(`reports/codeql/${file}`, { force: true });
const scratch = mkdtempSync(join(tmpdir(), 'tabkeeper-codeql-'));
let failed = false;
try {
  failed = run(process.execPath, ['scripts/security-report.mjs', 'osv']) !== 0;
  for (const language of ['javascript', 'actions']) {
    const db = join(scratch, language);
    if (run(codeql, ['database', 'create', db, `--language=${language}`, '--build-mode=none', `--source-root=${resolve('.')}`])) {
      throw new Error(`CodeQL could not extract ${language}.`);
    }
    if (run(codeql, ['database', 'analyze', db,
      `codeql/${language}-queries:codeql-suites/${language}-security-extended.qls`,
      '--format=sarif-latest', `--output=${resolve(`reports/codeql/${language}.sarif`)}`,
      '--threads=2', '--ram=4096',
    ])) throw new Error(`CodeQL could not analyze ${language}.`);
  }
  failed = run(process.execPath, ['scripts/security-report.mjs', 'codeql']) !== 0 || failed;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
