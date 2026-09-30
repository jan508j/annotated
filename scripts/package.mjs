import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PILOT_EXTENSION_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAurBpzSvG0fFV9hGFIxtmlmZ7RTC+aTA5FeICwvmPRE0yTXFxuS65wEA1XW9RsSmL+jSHhWGm0srX6pzRPsCQHTv2FPs4ld+extq6/eAB9JphiG9VNuovuS3U5iUKum+gIJYir4vghoebFBN8jmaNsdd3IkDTJ59ZihojNI/z6bRSPpHlaNpcOPHCVf4CznUh+bO7wOvp1P8FrPT5gmfOT9pI7AzlXwErznanCFgkdmUhRneLVdLpueD/mp2K8JKCfzK/REoIvzGgaiI2KGyUI2HXpn2d5fASXilVhMsno4BL/A0rGgi8yLz6pJD7O93DKwUDFV/m1/q3NSgaf9DHMQIDAQAB';

const mode = process.env.APP_MODE || 'local';
if (!['local', 'production'].includes(mode)) throw new Error('APP_MODE must be local or production.');

const production = mode === 'production';
const mediaStorage = process.env.MEDIA_STORAGE || 'disk';
if (!['disk', 'blob'].includes(mediaStorage) || (!production && mediaStorage !== 'disk')) throw new Error('MEDIA_STORAGE must be disk locally or disk/blob in production.');
const apiOrigin = production ? productionOrigin(process.env.BASE_URL) : 'http://127.0.0.1:4317';
const extensionPublicKey = production ? validPublicKey(process.env.EXTENSION_PUBLIC_KEY || PILOT_EXTENSION_PUBLIC_KEY) : null;
const directoryName = production ? 'production-extension/' : 'extension/';
const zipName = production ? 'production-extension.zip' : 'annotated-extension.zip';
const target = new URL(`../artifacts/${directoryName}`, import.meta.url);
const zip = new URL(`../artifacts/${zipName}`, import.meta.url);

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(new URL('../extension/', import.meta.url), target, { recursive: true });
await cp(new URL('../shared/source.mjs', import.meta.url), new URL('source.mjs', target));
await cp(new URL('../shared/source-identity.mjs', import.meta.url), new URL('source-identity.mjs', target));
await cp(new URL('../shared/highlights.mjs', import.meta.url), new URL('highlights.mjs', target));
await cp(new URL('../shared/marker.mjs', import.meta.url), new URL('marker.mjs', target));
await cp(new URL('../shared/share-sheet.mjs', import.meta.url), new URL('share-sheet.mjs', target));
await cp(new URL('../shared/share-sheet.css', import.meta.url), new URL('share-sheet.css', target));

await writeFile(new URL('config.mjs', target), configSource({ mode, apiOrigin, mediaStorage }));
if (mediaStorage === 'blob') {
  const { build } = await import('esbuild');
  await build({
    stdin: { contents: "export { put } from '@vercel/blob/client';", resolveDir: fileURLToPath(new URL('../', import.meta.url)), sourcefile: 'blob-client-entry.mjs' },
    outfile: fileURLToPath(new URL('blob-client.mjs', target)),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'chrome116',
    minify: true,
    logLevel: 'silent'
  });
}

const manifestUrl = new URL('manifest.json', target);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
if (production) {
  manifest.name = 'Annotated';
  manifest.key = extensionPublicKey;
  manifest.permissions = [...new Set([...manifest.permissions, 'identity'])];
  manifest.host_permissions = [`${apiOrigin}/*`, ...(mediaStorage === 'blob' ? ['https://vercel.com/*'] : [])];
  await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
}

await validatePackage(target, manifest, { mode, apiOrigin, mediaStorage });
await rm(zip, { force: true });
const run = spawnSync('/usr/bin/zip', ['-qr', zip.pathname, '.'], { cwd: target.pathname, encoding: 'utf8' });
if (run.status !== 0) throw new Error(run.stderr);
const bytes = await readFile(zip);
console.log(`Packaged Annotated ${manifest.version} (${mode}): ${bytes.length} bytes`);
console.log(`SHA256 ${createHash('sha256').update(bytes).digest('hex')}`);
if (production) console.log(`Extension ID ${extensionId(extensionPublicKey)}`);
console.log(`Unpacked extension: ${target.pathname}`);

function productionOrigin(value) {
  if (!value) throw new Error('Production packaging requires BASE_URL.');
  let url;
  try { url = new URL(value); }
  catch { throw new Error('BASE_URL must be a valid HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('BASE_URL must be a credential-free HTTPS origin with no path, query or fragment.');
  }
  return url.origin;
}

function configSource(config) {
  return `export const APP_CONFIG = Object.freeze(${JSON.stringify(config, null, 2)});\n\n`
    + 'export function sessionStorageKey(config = APP_CONFIG) {\n'
    + '  return `annotated-session:${new URL(config.apiOrigin).origin}`;\n'
    + '}\n';
}

function validPublicKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error('EXTENSION_PUBLIC_KEY must be a base64 DER public key.');
  }
  const der = Buffer.from(value, 'base64');
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'rsa' || !key.export({ format: 'der', type: 'spki' }).equals(der)) throw new Error();
  } catch {
    throw new Error('EXTENSION_PUBLIC_KEY must be a valid RSA SPKI DER public key.');
  }
  return der.toString('base64');
}

function extensionId(publicKey) {
  const digest = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest().subarray(0, 16);
  return [...digest].flatMap((byte) => [byte >> 4, byte & 15]).map((nibble) => 'abcdefghijklmnop'[nibble]).join('');
}

async function validatePackage(directory, manifest, expected) {
  if (manifest.manifest_version !== 3 || !manifest.side_panel) throw new Error('Expected an MV3 side-panel extension.');
  for (const file of [manifest.background?.service_worker, manifest.side_panel.default_path, ...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {})]) {
    if (!file || file.includes('..') || file.startsWith('/')) throw new Error('Invalid packaged entry path.');
    await access(new URL(file, directory));
  }
  for (const file of ['panel.html', 'offscreen.html', 'microphone.html']) {
    const html = await readFile(new URL(file, directory), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
      if (/^https?:/.test(match[1])) throw new Error('Packaged UI must not load remote assets.');
      await access(new URL(match[1], directory));
    }
  }
  const config = await readFile(new URL('config.mjs', directory), 'utf8');
  if (!config.includes(`"mode": "${expected.mode}"`) || !config.includes(`"apiOrigin": "${expected.apiOrigin}"`) || !config.includes(`"mediaStorage": "${expected.mediaStorage}"`)) {
    throw new Error('Generated extension config does not match the requested build.');
  }
  const expectedHosts = expected.mode === 'production'
    ? [`${expected.apiOrigin}/*`, ...(expected.mediaStorage === 'blob' ? ['https://vercel.com/*'] : [])]
    : ['http://127.0.0.1:4317/*', 'http://localhost:4317/*'];
  if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(expectedHosts)) {
    throw new Error('Manifest host permissions do not exactly match the extension config.');
  }
  if (manifest.permissions.includes('identity') !== (expected.mode === 'production')) {
    throw new Error('The identity permission must be present only in production packages.');
  }
  if (expected.mode === 'production' && manifest.key !== extensionPublicKey) throw new Error('Production manifest key does not match the validated public key.');
  if (expected.mediaStorage === 'blob') await access(new URL('blob-client.mjs', directory));
  if (expected.mode === 'production' && (/127\.0\.0\.1|localhost/.test(config) || /local demo/i.test(manifest.name))) {
    throw new Error('Production package contains local configuration.');
  }
}
