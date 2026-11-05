import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const badge = (label, message, color) => ({ schemaVersion: 1, label, message, color });
const unavailable = (label) => badge(label, 'unavailable', 'lightgrey');

export function makeBadges({ unit, codeql, dependencies }) {
  const lines = unit?.coverage?.coveredLinePercent;
  const tests = unit?.tests;
  return {
    coverage: Number.isFinite(lines) && tests?.success === true
      ? badge('unit coverage', `${lines.toFixed(2)}%`, lines >= 90 ? 'brightgreen' : lines >= 80 ? 'yellow' : 'red')
      : unavailable('unit coverage'),
    tests: tests && Number.isInteger(tests.passed) && Number.isInteger(tests.tests)
      ? badge('unit tests', `${tests.passed}/${tests.tests} passed`, tests.success ? 'brightgreen' : 'red')
      : unavailable('unit tests'),
    codeql: Number.isInteger(codeql?.findings) && codeql.findings >= 0
      ? badge('CodeQL findings', String(codeql.findings), codeql.findings ? 'red' : 'brightgreen')
      : unavailable('CodeQL findings'),
    dependencies: Number.isInteger(dependencies?.vulnerabilities) && dependencies.vulnerabilities >= 0
      ? badge('dependency vulns', String(dependencies.vulnerabilities), dependencies.vulnerabilities ? 'red' : 'brightgreen')
      : unavailable('dependency vulns'),
  };
}

async function publish(files, env) {
  const api = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}`;
  async function request(path, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(`${api}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) throw new Error(`Badge publication failed: ${method} ${path} (HTTP ${response.status}).`);
    return response.json();
  }
  const previous = await request('git/ref/heads/badges');
  const tree = await request('git/trees', { tree: Object.entries(files).map(([path, value]) => ({
    path, mode: '100644', type: 'blob', content: JSON.stringify(value, null, 2) + '\n',
  })) });
  const commit = await request('git/commits', {
    message: `Metrics for ${env.GITHUB_SHA}`, tree: tree.sha,
    parents: previous ? [previous.object.sha] : [],
  });
  if (previous) await request('git/refs/heads/badges', { sha: commit.sha, force: false }, 'PATCH');
  else await request('git/refs', { ref: 'refs/heads/badges', sha: commit.sha });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const read = (name) => {
    try { return JSON.parse(readFileSync(`reports/${name}.json`, 'utf8')); }
    catch { return null; } // Missing or invalid reports must never turn into a green zero.
  };
  const metrics = {
    commit: process.env.GITHUB_SHA ?? 'local', updated: new Date().toISOString(),
    run: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    unit: read('unit'), codeql: read('codeql'), dependencies: read('dependencies'),
  };
  const files = { 'metrics.json': metrics };
  for (const [name, data] of Object.entries(makeBadges(metrics))) files[`${name}.json`] = data;
  mkdirSync('reports/badges', { recursive: true });
  for (const [name, data] of Object.entries(files)) writeFileSync(`reports/badges/${name}`, JSON.stringify(data, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = Object.values(makeBadges(metrics)).map((b) => `| ${b.label} | ${b.message} |`).join('\n');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `| Metric | Result |\n| --- | --- |\n${rows}\n\nCommit: \`${metrics.commit}\`\n`);
  }
  if (process.argv.includes('--publish')) await publish(files, process.env);
}
