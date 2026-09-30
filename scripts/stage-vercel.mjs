import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// Upload only release inputs; credentials, local data, fixtures and research
// never enter Vercel's deployment archive.
const root = resolve(import.meta.dirname, '..');
const target = join(root, 'artifacts', 'vercel-app');
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const path of ['api', 'server', 'shared', 'web', 'extension/fonts', 'extension/fonts.css', 'extension/marker-tokens.css', 'package.json', 'package-lock.json', 'vercel.json', 'artifacts/production-extension.zip']) {
  await cp(join(root, path), join(target, path), { recursive: true, filter: path => !path.includes('/web/fixtures') });
}
const packagePath = join(target, 'package.json');
const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
pkg.engines.node = '24.x';
pkg.allowScripts = { 'ffmpeg-static@5.2.0': true };
await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.env') || entry.name === '.neon' || entry.name === '.data') throw new Error('A private path entered deployment staging.');
    if (entry.isDirectory()) await check(join(directory, entry.name));
  }
}
await check(target);
console.log('Staged the allowlisted Vercel release in artifacts/vercel-app.');
