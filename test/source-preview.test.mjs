import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fetchSourcePreview } from '../server/source-preview.mjs';

const publicDns = async () => [{ address: '8.8.8.8', family: 4 }];

function fixtureRequest(replies, calls = []) {
  return (options, onResponse) => {
    calls.push(options);
    const reply = replies.shift();
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      if (!reply || reply.hang) return;
      const response = new PassThrough();
      response.statusCode = reply.status || 200;
      response.headers = reply.headers || { 'content-type': 'text/html; charset=utf-8' };
      onResponse(response);
      response.end(reply.body || '');
    });
    return req;
  };
}

test('reads a bounded HTML title, decodes entities, and pins DNS for the connection', async () => {
  const calls = [];
  const request = fixtureRequest([{ body: '<html><head><title> An &amp; B &#8212; “C” </title></head><body>article</body></html>' }], calls);
  const result = await fetchSourcePreview('https://example.com/story#section', { resolveHostname: publicDns, request });
  assert.deepEqual(result, { url: 'https://example.com/story', title: 'An & B — “C”' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agent, false);
  assert.equal(calls[0].autoSelectFamily, false);
  assert.deepEqual(calls[0].headers, { Accept: 'text/html, application/xhtml+xml' });
  assert.equal(calls[0].hostname, 'example.com');
  assert.deepEqual(await new Promise((resolve, reject) => calls[0].lookup('example.com', {}, (error, address, family) => error ? reject(error) : resolve({ address, family }))), { address: '8.8.8.8', family: 4 });
  assert.deepEqual(await new Promise((resolve, reject) => calls[0].lookup('example.com', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses))), [{ address: '8.8.8.8', family: 4 }]);
  assert.throws(() => calls[0].lookup('different.example', {}, error => { if (error) throw error; }), /Could not read a title/);
});

test('reads explicit Open Graph publisher independently of title and author', async () => {
  const html = '<head><meta content="The News &amp; Review" name="site" property="og:site_name"><meta name="author" content="Jane Reporter"><title>Climate report | The News &amp; Review</title></head>';
  const result = await fetchSourcePreview('https://news.example/story', { resolveHostname: publicDns, request: fixtureRequest([{ body: html }]) });
  assert.deepEqual(result, { url: 'https://news.example/story', title: 'Climate report | The News & Review', publisher: 'The News & Review' });
});

test('uses JSON-LD publisher.name when Open Graph site name is absent', async () => {
  const html = '<head><title>A report</title><script type="application/ld+json">{"@graph":[{"@type":"Person","name":"Jane Reporter"},{"@type":"NewsArticle","author":{"name":"Jane Reporter"},"publisher":{"@type":"Organization","name":"Example Gazette"}}]}</script></head>';
  const result = await fetchSourcePreview('https://news.example/story', { resolveHostname: publicDns, request: fixtureRequest([{ body: html }]) });
  assert.equal(result.publisher, 'Example Gazette');
  assert.equal(result.title, 'A report');
});

test('ignores invalid or absent publisher metadata and bounds a valid name', async () => {
  const invalid = '<head><title>Report</title><script>"<meta property=\\"og:site_name\\" content=\\"False News\\">"</script><script type="application/ld+json">{bad json}</script><meta name="author" content="Jane Reporter"></head>';
  const blank = await fetchSourcePreview('https://news.example/story', { resolveHostname: publicDns, request: fixtureRequest([{ body: invalid }]) });
  assert.equal('publisher' in blank, false);
  const longName = 'N'.repeat(120);
  const bounded = await fetchSourcePreview('https://news.example/story', { resolveHostname: publicDns, request: fixtureRequest([{ body: `<head><meta property='og:site_name' content='${longName}'></head>` }]) });
  assert.equal(bounded.publisher, 'N'.repeat(100));
});

test('rejects private, reserved, and mapped destinations before requesting', async () => {
  for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/', 'http://10.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://192.0.2.1/']) {
    let calls = 0;
    await assert.rejects(fetchSourcePreview(url, { request: () => { calls++; throw new Error('connected'); } }), /Could not read a title/);
    assert.equal(calls, 0, url);
  }
  let calls = 0;
  await assert.rejects(fetchSourcePreview('https://example.com/', {
    resolveHostname: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
    request: () => { calls++; throw new Error('connected'); }
  }), /Could not read a title/);
  assert.equal(calls, 0);
});

test('validates each redirect before a connection', async () => {
  const calls = [];
  const request = fixtureRequest([{ status: 302, headers: { location: 'http://127.0.0.1/private' } }], calls);
  await assert.rejects(fetchSourcePreview('https://example.com/start', { resolveHostname: publicDns, request }), /Could not read a title/);
  assert.equal(calls.length, 1);

  const calls2 = [];
  const request2 = fixtureRequest([
    { status: 301, headers: { location: 'https://next.example/story' } },
    { body: '<title>Redirect destination</title>' }
  ], calls2);
  const result = await fetchSourcePreview('https://example.com/start', { resolveHostname: publicDns, request: request2 });
  assert.deepEqual(result, { url: 'https://next.example/story', title: 'Redirect destination' });
  assert.equal(calls2.length, 2);

  const calls3 = [];
  const request3 = fixtureRequest([{ status: 302, headers: { location: 'https://private.example/story' } }], calls3);
  await assert.rejects(fetchSourcePreview('https://example.com/start', {
    resolveHostname: async host => [{ address: host === 'private.example' ? '10.0.0.2' : '8.8.8.8', family: 4 }],
    request: request3
  }), /Could not read a title/);
  assert.equal(calls3.length, 1);

  const calls4 = [];
  const request4 = fixtureRequest(Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/again' } })), calls4);
  await assert.rejects(fetchSourcePreview('https://example.com/start', { resolveHostname: publicDns, request: request4 }), /Could not read a title/);
  assert.equal(calls4.length, 4);
});

test('enforces response size and total time limits', async () => {
  const oversized = fixtureRequest([{ body: `<title>${'A'.repeat(100)}</title>${'B'.repeat(200)}` }]);
  await assert.rejects(fetchSourcePreview('https://example.com/', { resolveHostname: publicDns, request: oversized, maxBytes: 128 }), /Could not read a title/);
  const hanging = fixtureRequest([{ hang: true }]);
  await assert.rejects(fetchSourcePreview('https://example.com/', { resolveHostname: publicDns, request: hanging, timeoutMs: 20 }), /Could not read a title/);
});

test('accepts HTML without a title and rejects non-HTML or private URLs', async () => {
  const blank = await fetchSourcePreview('https://example.com/', {
    resolveHostname: publicDns,
    request: fixtureRequest([{ body: '<html><head><script>"<title>Wrong</title>"</script></head><body>Nothing here</body></html>' }])
  });
  assert.equal(blank.title, '');
  await assert.rejects(fetchSourcePreview('https://example.com/', {
    resolveHostname: publicDns,
    request: fixtureRequest([{ headers: { 'content-type': 'application/json' }, body: '{"title":"No"}' }])
  }), /Could not read a title/);
  for (const url of ['https://u:p@example.com/', 'https://example.com/?api_key=private', 'https://www.youtube.com/watch?v=abcdefghijk&token=private', 'https://example.com:444/', 'file:///tmp/test']) {
    await assert.rejects(fetchSourcePreview(url, { resolveHostname: publicDns, request: () => { throw new Error('requested'); } }), /Could not read a title/);
  }
});
