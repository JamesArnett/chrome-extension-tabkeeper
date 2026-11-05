import { mkdirSync, rmSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

mkdirSync('reports', { recursive: true });
rmSync('reports/unit.json', { force: true });
const result = spawnSync(process.execPath, [
  '--test', '--experimental-test-coverage',
  '--test-reporter=spec', '--test-reporter-destination=stdout',
  '--test-reporter=./scripts/coverage-reporter.mjs', '--test-reporter-destination=reports/unit.json',
], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
if (process.env.GITHUB_STEP_SUMMARY && existsSync('reports/unit.json')) {
  const { coverage, tests } = JSON.parse(readFileSync('reports/unit.json', 'utf8'));
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Unit tests and coverage\n\n| Metric | Result |\n| --- | --- |\n` +
    `| Tests | ${tests.passed}/${tests.tests} passed |\n` +
    `| Lines | ${coverage.coveredLinePercent.toFixed(2)}% |\n` +
    `| Branches | ${coverage.coveredBranchPercent.toFixed(2)}% |\n` +
    `| Functions | ${coverage.coveredFunctionPercent.toFixed(2)}% |\n\n` +
    'Coverage measures code exercised by Node tests; browser integration tests run separately.\n');
}
