import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);

test('local packaging keeps local config and permissions in the existing artifact', async () => {
  const run = packageExtension({ APP_MODE: 'local' });
  assert.equal(run.status, 0, run.stderr);
  const config = await readFile(new URL('artifacts/extension/config.mjs', root), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('artifacts/extension/manifest.json', root), 'utf8'));
  assert.match(config, /"mode": "local"/);
  assert.match(config, /"apiOrigin": "http:\/\/127\.0\.0\.1:4317"/);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1:4317/*', 'http://localhost:4317/*']);
  assert.equal(manifest.permissions.includes('identity'), false);
});

test('production packaging isolates an HTTPS config and exact backend permission', async () => {
  const run = packageExtension({ APP_MODE: 'production', BASE_URL: 'https://annotated.example.test' });
  assert.equal(run.status, 0, run.stderr);
  const config = await readFile(new URL('artifacts/production-extension/config.mjs', root), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('artifacts/production-extension/manifest.json', root), 'utf8'));
  assert.match(config, /"mode": "production"/);
  assert.match(config, /"apiOrigin": "https:\/\/annotated\.example\.test"/);
  assert.doesNotMatch(config, /127\.0\.0\.1|localhost/);
  assert.equal(manifest.name, 'Annotated');
  assert.match(manifest.key, /^MIIB/);
  assert.deepEqual(manifest.host_permissions, ['https://annotated.example.test/*']);
  assert.equal(manifest.permissions.includes('identity'), true);
  assert.deepEqual(manifest.action.default_icon, manifest.icons);
  for (const hue of ['coral', 'citrus', 'mint', 'sky', 'lilac', 'recording']) {
    for (const size of [16, 32, 48, 128]) {
      const png = await readFile(new URL(`artifacts/production-extension/icons/${hue}/icon-${size}.png`, root));
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
      if (hue === 'citrus') assert.equal(manifest.icons[size], `icons/citrus/icon-${size}.png`);
    }
  }
  await readFile(new URL('artifacts/production-extension.zip', root));
  assert.match(run.stdout, /Extension ID mifcamngnbedglmnldpdnhilmbhemhfn/);
});

test('blob packaging bundles the client SDK and grants its exact upload API host', async () => {
  const run = packageExtension({ APP_MODE: 'production', BASE_URL: 'https://annotated.example.test', MEDIA_STORAGE: 'blob' });
  assert.equal(run.status, 0, run.stderr);
  const config = await readFile(new URL('artifacts/production-extension/config.mjs', root), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('artifacts/production-extension/manifest.json', root), 'utf8'));
  const sdk = await readFile(new URL('artifacts/production-extension/blob-client.mjs', root), 'utf8');
  assert.match(config, /"mediaStorage": "blob"/);
  assert.deepEqual(manifest.host_permissions, ['https://annotated.example.test/*', 'https://vercel.com/*']);
  assert.match(sdk, /vercel\.com\/api\/blob/);
  assert.doesNotMatch(sdk, /from\s+["'](?:@vercel\/blob|undici|crypto)/);
});

test('production packaging rejects non-HTTPS and path-bearing backend URLs', () => {
  for (const BASE_URL of ['http://annotated.example.test', 'https://annotated.example.test/api']) {
    const run = packageExtension({ APP_MODE: 'production', BASE_URL });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /HTTPS origin/);
  }
});

test('production packaging rejects an invalid extension public key before packaging', () => {
  const run = packageExtension({ APP_MODE: 'production', BASE_URL: 'https://annotated.example.test', EXTENSION_PUBLIC_KEY: 'not-a-key' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /EXTENSION_PUBLIC_KEY/);
});

function packageExtension(overrides) {
  return spawnSync(process.execPath, ['scripts/package.mjs'], {
    cwd: root,
    env: { ...process.env, MEDIA_STORAGE: 'disk', ...overrides },
    encoding: 'utf8'
  });
}
