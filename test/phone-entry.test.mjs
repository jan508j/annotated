import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server/index.mjs';

async function start(t, sourcePreviewFetcher) {
  const dataDir = mkdtempSync(join(tmpdir(), 'annotated-phone-test-'));
  const server = createServer({ dataDir, seed: false, sourcePreviewFetcher });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(dataDir, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('OS sharing opens a bounded draft fragment without creating content or exposing shared text in a query', async t => {
  const base = await start(t);
  for (const path of ['/write', '/phone', '/install']) assert.equal((await fetch(base + path)).status, 200);
  for (const path of ['/web/article-editor.js', '/shared/article-draft.mjs', '/web/mobile-setup.js']) {
    const asset = await fetch(base + path);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
  }
  const body = new URLSearchParams({ title: 'Quoted <title>', text: 'A passage to review.\nhttps://example.com/article', url: 'https://example.com/article' });
  const response = await fetch(base + '/share', { method: 'POST', body, redirect: 'manual' });
  assert.equal(response.status, 303);
  const target = new URL(response.headers.get('location'), base);
  assert.equal(target.pathname, '/write'); assert.equal(target.search, '');
  assert.equal(new URLSearchParams(target.hash.slice(1)).get('text'), body.get('text'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await (await fetch(base + '/api/feed')).json()).annotations.length, 0);
  assert.equal((await fetch(base + '/share', { method: 'POST', body: new URLSearchParams({ text: 'a'.repeat(12001) }) })).status, 413);
  assert.equal((await fetch(base + '/share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 415);
});

test('title lookup requires same-origin intent and has a safe manual-title fallback', async t => {
  let calls = 0;
  const base = await start(t, async url => { calls++; if (url.endsWith('/blocked')) throw new Error('private upstream details'); return { url, title: 'Fetched title' }; });
  const post = (url, origin) => fetch(base + '/api/source-preview', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ url }) });
  assert.equal((await post('https://example.com/', undefined)).status, 403);
  assert.equal((await post('https://example.com/', 'https://foreign.example')).status, 403);
  assert.equal(calls, 0);
  const result = await post('https://example.com/', base);
  assert.equal(result.status, 200); assert.equal((await result.json()).title, 'Fetched title');
  const failure = await post('https://example.com/blocked', base);
  assert.equal(failure.status, 422); assert.doesNotMatch(await failure.text(), /private upstream/);
});
