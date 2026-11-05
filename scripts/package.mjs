// Builds dist/tabkeeper-<version>.zip for upload to the Chrome Web Store.
// Only runtime files go in: manifest, src/, popup/, options/, help/ and the
// manifest icons, the MIT license, plus the store banner used by the welcome page. Tests,
// scripts, docs and other store artwork stay out.
//
//   npm run package
//
// Before zipping it checks that every file referenced by the manifest, the HTML
// pages and the ES module imports exists, and that src/build.js lists real files.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRelease } from './check-release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
validateRelease(manifest, JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')), process.env.RELEASE_TAG ?? '');
const DIRS = ['src', 'popup', 'options', 'help'];
const RUNTIME_ASSETS = ['store/promo-marquee-1400x560.png'];
const problems = [];

const exists = (rel) => existsSync(join(ROOT, String(rel).split(/[?#]/)[0]));
const need = (rel, from) => {
  if (!exists(rel)) problems.push(`${from} references missing file ${rel}`);
};

// Manifest references.
const icons = new Set([...Object.values(manifest.icons ?? {}), ...Object.values(manifest.action?.default_icon ?? {})]);
for (const icon of icons) need(icon, 'manifest.json');
need(manifest.background?.service_worker, 'manifest.json background');
need(manifest.action?.default_popup, 'manifest.json action');
if (manifest.options_ui?.page) need(manifest.options_ui.page, 'manifest.json options_ui');
for (const asset of RUNTIME_ASSETS) need(asset, 'runtime assets');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (name === '.DS_Store') continue;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}
const files = DIRS.flatMap(walk);

// HTML src/href and JS relative imports.
for (const rel of files) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const base = dirname(rel);
  const refs = [];
  if (rel.endsWith('.html')) for (const m of text.matchAll(/\b(?:src|href)="([^"#:]+)"/g)) refs.push(m[1]);
  if (rel.endsWith('.js')) for (const m of text.matchAll(/\bfrom\s+'(\.[^']+)'/g)) refs.push(m[1]);
  if (rel.endsWith('.css')) for (const m of text.matchAll(/@import\s+url\("([^"]+)"\)/g)) refs.push(m[1]);
  for (const ref of refs) need(relative(ROOT, resolve(ROOT, base, ref)), rel);
}

// Stale-worker hash list must point at real files.
const buildSrc = readFileSync(join(ROOT, 'src/build.js'), 'utf8');
for (const m of buildSrc.matchAll(/'((?:src\/[\w-]+\.js)|manifest\.json)'/g)) need(m[1], 'src/build.js SOURCE_FILES');

// Nothing that cannot run in an extension page.
for (const rel of files) {
  if (/\.test\.js$/.test(rel)) problems.push(`test file inside a shipped folder: ${rel}`);
  const text = readFileSync(join(ROOT, rel), 'utf8');
  if (/\binnerHTML\s*=/.test(text)) problems.push(`innerHTML assignment in ${rel}`);
  if (/\beval\s*\(|new Function\s*\(/.test(text)) problems.push(`eval/new Function in ${rel}`);
}

if (problems.length) {
  console.error('Package check failed:\n  ' + problems.join('\n  '));
  process.exit(1);
}

const stage = mkdtempSync(join(tmpdir(), 'tabkeeper-pkg-'));
try {
  cpSync(join(ROOT, 'manifest.json'), join(stage, 'manifest.json'));
  cpSync(join(ROOT, 'LICENSE'), join(stage, 'LICENSE'));
  for (const dir of DIRS) cpSync(join(ROOT, dir), join(stage, dir), { recursive: true, filter: (p) => !p.endsWith('.DS_Store') });
  mkdirSync(join(stage, 'icons'));
  for (const icon of icons) cpSync(join(ROOT, icon), join(stage, icon));
  for (const asset of RUNTIME_ASSETS) {
    mkdirSync(dirname(join(stage, asset)), { recursive: true });
    cpSync(join(ROOT, asset), join(stage, asset));
  }

  mkdirSync(join(ROOT, 'dist'), { recursive: true });
  const out = join(ROOT, 'dist', `tabkeeper-${manifest.version}.zip`);
  rmSync(out, { force: true });
  execFileSync('zip', ['-r', '-X', '-q', out, '.'], { cwd: stage });
  const listing = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).trim().split('\n');
  console.log(`wrote ${relative(ROOT, out)} (${listing.length} files, ${(statSync(out).size / 1024).toFixed(1)} KB)`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
