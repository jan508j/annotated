import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadMedia } from '../extension/upload-media.mjs';

const blob = new Blob(['local test media'], { type: 'audio/webm' });
const response = (status, payload) => ({ status, ok: status >= 200 && status < 300, json: async () => payload });

test('disk uploads keep the existing single authenticated media request', async () => {
  const calls = [];
  const result = await uploadMedia({ apiOrigin: 'http://127.0.0.1:4317', mediaStorage: 'disk', token: 'test-session', role: 'voice', blob,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response(201, { id: 'media-test' }); } });
  assert.equal(result.id, 'media-test');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:4317/api/media');
  assert.equal(calls[0].options.headers['X-Media-Role'], 'voice');
  assert.equal(calls[0].options.body, blob);
});

test('blob upload reserves, uploads privately with a client token, then completes', async () => {
  const calls = [];
  const controller = new AbortController();
  const result = await uploadMedia({ apiOrigin: 'https://annotated.example', mediaStorage: 'blob', token: 'test-session', role: 'source-audio', blob,
    signal: controller.signal,
    fetchImpl: async (url, options) => {
      calls.push({ kind: 'fetch', url, options });
      return url.endsWith('/api/media/uploads')
        ? response(201, { id: 'upload-test', pathname: 'uploads/test.webm', clientToken: 'test-client-token', contentType: 'audio/webm' })
        : response(201, { id: 'media-test', duration: 1 });
    },
    putBlob: async (pathname, body, options) => { calls.push({ kind: 'put', pathname, body, options }); }
  });
  assert.equal(result.id, 'media-test');
  assert.deepEqual(calls.map(({ kind }) => kind), ['fetch', 'put', 'fetch']);
  assert.deepEqual(JSON.parse(calls[0].options.body), { role: 'source-audio', contentType: 'audio/webm', size: blob.size });
  assert.equal(calls[1].pathname, 'uploads/test.webm');
  assert.equal(calls[1].body, blob);
  assert.equal(calls[1].options.access, 'private');
  assert.equal(calls[1].options.token, 'test-client-token');
  assert.equal(calls[1].options.abortSignal, controller.signal);
  assert.equal(calls[2].url, 'https://annotated.example/api/media/uploads/upload-test/complete');
  assert.equal(calls[2].options.headers.Authorization, 'Bearer test-session');
});

test('authorization expiry is reported and an aborted upload cannot complete', async () => {
  let unauthorized = 0;
  await assert.rejects(uploadMedia({ apiOrigin: 'https://annotated.example', mediaStorage: 'blob', token: 'expired', role: 'voice', blob,
    onUnauthorized: () => { unauthorized += 1; }, fetchImpl: async () => response(401, { error: 'Session expired.' }) }), /Session expired/);
  assert.equal(unauthorized, 1);

  const controller = new AbortController();
  const calls = [];
  await assert.rejects(uploadMedia({ apiOrigin: 'https://annotated.example', mediaStorage: 'blob', token: 'test-session', role: 'voice', blob,
    signal: controller.signal,
    fetchImpl: async (url) => { calls.push(url); return response(201, { id: 'upload-test', pathname: 'uploads/test.webm', clientToken: 'test-client-token', contentType: 'audio/webm' }); },
    putBlob: async () => { controller.abort(); }
  }), { name: 'AbortError' });
  assert.equal(calls.length, 1);
});
