import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = mkdtempSync(join(tmpdir(), 'tabkeeper-firefox-lint-'));
try {
  execFileSync(process.execPath, ['scripts/package.mjs', 'firefox'], { cwd: root, stdio: 'inherit' });
  const { version } = JSON.parse(readFileSync(join(root, 'package.json')));
  execFileSync('unzip', ['-oq', join(root, 'dist', `tabkeeper-firefox-${version}.zip`), '-d', stage]);
  const result = spawnSync(process.execPath, [join(root, 'node_modules/web-ext/bin/web-ext.js'),
    'lint', '--no-config-discovery', '--source-dir', stage, '--output', 'json'], { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  mkdirSync(join(root, 'reports'), { recursive: true });
  writeFileSync(join(root, 'reports/firefox-lint.json'), result.stdout);
  const report = JSON.parse(result.stdout);
  console.log(`Firefox lint: ${report.summary.errors} errors, ${report.summary.warnings} warnings.`);
  for (const finding of [...report.errors, ...report.warnings]) console.log(`${finding.code}: ${finding.message}`);
  if (result.status || report.summary.errors) process.exitCode = 1;
} finally {
  rmSync(stage, { recursive: true, force: true });
}
