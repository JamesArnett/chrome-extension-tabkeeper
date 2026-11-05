// Shared by local packaging and CI; never release a tag for a different version.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const manifest = read('manifest.json');
const pkg = read('package.json');

export function validateRelease(manifest, pkg, tag = '') {
  const version = manifest.version;
  if (!/^\d+\.\d+\.\d+$/.test(version) || version.split('.').some((n) => Number(n) > 65535 || String(Number(n)) !== n)) {
    throw new Error('Use a three-part Chrome version with components from 0 to 65535.');
  }
  if (pkg.version !== version) throw new Error('package.json and manifest.json versions must match.');
  if (tag && tag !== `v${version}`) throw new Error(`Tag must be v${version}, received ${tag}.`);
  if (!manifest.description || manifest.description.length > 132) throw new Error('Manifest description must be 1–132 characters.');
  return version;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(`Validated Tabkeeper ${validateRelease(manifest, pkg, process.env.RELEASE_TAG ?? '')}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
