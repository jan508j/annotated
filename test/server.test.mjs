import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from '../server/index.mjs';
import { sourceKey } from '../shared/source.mjs';

async function start(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'annotated-test-'));
  const server = createServer({ dataDir, seed: false });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { server, base, dataDir };
}

async function request(base, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${path}`, { ...options, headers, body });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { response, data };
}

async function requestWithHost(base, path, host) {
  const target = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = http.request(target, { headers: { host } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

async function signIn(base, persona) {
  const result = await request(base, '/api/dev/session', {
    method: 'POST',
    headers: { origin: base },
    json: { persona },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.user.isDemo, true);
  return { user: result.data.user, token: result.data.token, authorization: `Bearer ${result.data.token}`, cookie: result.response.headers.get('set-cookie').split(';')[0] };
}

function pngSize(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'share card has the PNG signature');
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('multiple highlights stay separate across receipts and feed, with combined limits and legacy compatibility', async (t) => {
  const { base } = await start(t);
  const mira = await signIn(base, 'mira');
  const payload = { clientId: 'highlights-1', source: { url: 'https://example.test/multiple', title: 'Original test article', kind: 'article', author: 'Fixture author' }, excerpts: ['A first original sentence.', 'A separate final sentence.'], commentary: 'The two passages make the point together.' };
  const post = json => request(base, '/api/annotations', { method: 'POST', headers: { authorization: mira.authorization }, json });
  const result = await post(payload);
  assert.equal(result.response.status, 201);
  assert.deepEqual(result.data.annotation.excerpts, payload.excerpts);
  assert.match(result.data.annotation.excerpt, /\[…\]/u);
  const id = result.data.annotation.id;
  assert.deepEqual((await request(base, `/api/annotations/${id}`)).data.annotation.excerpts, payload.excerpts);
  assert.deepEqual((await request(base, '/api/feed')).data.annotations[0].excerpts, payload.excerpts);
  assert.equal((await post(payload)).data.annotation.id, id, 'retry does not duplicate publication');
  const legacy = await post({ ...payload, clientId: 'legacy-single', excerpts: undefined, excerpt: 'One legacy selected sentence.' });
  assert.deepEqual(legacy.data.annotation.excerpts, ['One legacy selected sentence.']);
  for (const excerpts of [[], ['same', 'same'], Array.from({ length: 6 }, (_, i) => `Quote ${i}`), ['word '.repeat(51), 'another '.repeat(50)], [{ text: 'not plain text' }]]) {
    assert.equal((await post({ ...payload, clientId: 'invalid-highlights', excerpts })).response.status, 400);
  }
  const script = await request(base, '/shared/source-identity.mjs');
  assert.equal(script.response.status, 200);
  assert.match(script.data.toString(), /sourceIdentity/);
});

test('local sessions require a trusted origin and revoke cleanly', async (t) => {
  const { base } = await start(t);
  const health = await request(base, '/api/health');
  assert.deepEqual(health.data, { ok: true, mode: 'local', oauthConfigured: false });

  const noOrigin = await request(base, '/api/dev/session', { method: 'POST', json: { persona: 'mira' } });
  assert.equal(noOrigin.response.status, 403);
  const hostileOrigin = await request(base, '/api/dev/session', { method: 'POST', headers: { origin: 'https://example.test' }, json: { persona: 'mira' } });
  assert.equal(hostileOrigin.response.status, 403);

  const mira = await signIn(base, 'mira');
  const bearerSession = await request(base, '/api/session', { headers: { authorization: mira.authorization } });
  assert.equal(bearerSession.data.user.id, mira.user.id);
  assert.equal(bearerSession.data.oauthConfigured, false);

  const badCookieOrigin = await request(base, '/api/session', { headers: { cookie: mira.cookie, origin: 'https://example.test' } });
  assert.equal(badCookieOrigin.response.status, 403);
  const cookieSession = await request(base, '/api/session', { headers: { cookie: mira.cookie, origin: base } });
  assert.equal(cookieSession.data.user.handle, 'mira-local');

  const missingMutationOrigin = await request(base, '/api/logout', { method: 'POST', headers: { cookie: mira.cookie } });
  assert.equal(missingMutationOrigin.response.status, 403);

  const logout = await request(base, '/api/logout', { method: 'POST', headers: { authorization: mira.authorization } });
  assert.deepEqual(logout.data, { ok: true });
  const revoked = await request(base, '/api/session', { headers: { authorization: mira.authorization } });
  assert.equal(revoked.data.user, null);
});

test('annotations, comments, follows and private claims enforce ownership and moderation', async (t) => {
  const { base } = await start(t);
  const mira = await signIn(base, 'mira');
  const leo = await signIn(base, 'leo');
  const sourceUrl = 'https://example.test/fixture-article?utm_source=local-test';
  const payload = {
    clientId: 'local-client-1',
    source: { url: sourceUrl, title: 'Local <script>alert("source")</script> & article', kind: 'article', author: 'Fixture author' },
    excerpt: 'This excerpt is original test-only fixture language.',
    start: null,
    end: null,
    commentary: 'A <img src=x onerror="take"> & "quoted" local take.',
    isDemo: false,
  };
  const emptyArticleExcerpt = await request(base, '/api/annotations', { method: 'POST', headers: { authorization: mira.authorization }, json: { ...payload, clientId: 'empty-article', excerpt: '' } });
  assert.equal(emptyArticleExcerpt.response.status, 400);
  const created = await request(base, '/api/annotations', { method: 'POST', headers: { authorization: mira.authorization }, json: payload });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.annotation.isDemo, true, 'server forces local publications to demo');
  assert.equal(created.data.annotation.source.url, 'https://example.test/fixture-article');
  const annotationId = created.data.annotation.id;

  const receiptPage = await request(base, `/a/${annotationId}`);
  assert.equal(receiptPage.response.status, 200);
  const receiptMarkup = receiptPage.data.toString('utf8');
  assert.match(receiptMarkup, /<meta property="og:title" content="Local &lt;script&gt;alert\(&quot;source&quot;\)&lt;\/script&gt; &amp; article — Annotated">/);
  assert.match(receiptMarkup, /<meta property="og:description" content="A &lt;img src=x onerror=&quot;take&quot;&gt; &amp; &quot;quoted&quot; local take\./);
  assert.match(receiptMarkup, new RegExp(`<meta property="og:url" content="http://127\\.0\\.0\\.1:4317/a/${annotationId}">`));
  assert.match(receiptMarkup, new RegExp(`<meta property="og:image" content="http://127\\.0\\.0\\.1:4317/api/annotations/${annotationId}/share-card\\.png">`));
  assert.equal((receiptMarkup.match(/property="og:image"/g) || []).length, 1, 'annotation card replaces the default logo image');
  assert.match(receiptMarkup, /<meta property="og:image:width" content="2400">/);
  assert.match(receiptMarkup, /<meta property="og:image:height" content="1260">/);
  assert.match(receiptMarkup, /<meta property="og:image:alt" content="Annotation by Mira \(local demo\) on Local &lt;script&gt;alert\(&quot;source&quot;\)&lt;\/script&gt; &amp; article\.">/);
  assert.match(receiptMarkup, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(receiptMarkup, new RegExp(`<meta name="twitter:image" content="http://127\\.0\\.0\\.1:4317/api/annotations/${annotationId}/share-card\\.png">`));
  assert.doesNotMatch(receiptMarkup, /<script>alert\("source"\)<\/script>|<img src=x onerror="take">/);

  const shareCard = await request(base, `/api/annotations/${annotationId}/share-card.png`);
  assert.equal(shareCard.response.status, 200);
  assert.equal(shareCard.response.headers.get('content-type'), 'image/png');
  assert.equal(shareCard.response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(pngSize(shareCard.data), { width: 2400, height: 1260 });
  const tallCard = await request(base, `/api/annotations/${annotationId}/share-card.png?format=tall`);
  assert.equal(tallCard.response.status, 200);
  assert.deepEqual(pngSize(tallCard.data), { width: 2160, height: 2700 });
  assert.equal((await request(base, `/api/annotations/${annotationId}/share-card.png?format=other`)).response.status, 400);
  const downloadedCard = await request(base, `/api/annotations/${annotationId}/share-card.png?download=1`);
  assert.equal(downloadedCard.response.headers.get('content-disposition'), `attachment; filename="annotated-mira-local-demo-${annotationId.replace(/^annotation[_-]/, '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}.png"`);
  const cardHead = await request(base, `/api/annotations/${annotationId}/share-card.png`, { method: 'HEAD' });
  assert.equal(cardHead.response.status, 200);
  assert.equal(cardHead.data.length, 0);
  assert.equal(Number(cardHead.response.headers.get('content-length')), shareCard.data.length);
  assert.equal(await requestWithHost(base, `/api/annotations/${annotationId}/share-card.png`, 'attacker.example'), 403);
  const missingReceipt = await request(base, '/a/not-a-real-annotation');
  assert.equal(missingReceipt.response.status, 404);
  assert.doesNotMatch(JSON.stringify(missingReceipt.data), /og:title|local take/i);

  const duplicate = await request(base, '/api/annotations', { method: 'POST', headers: { authorization: mira.authorization }, json: { ...payload, commentary: 'A retry must not replace the first value.' } });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.data.annotation.id, annotationId);
  assert.equal(duplicate.data.annotation.commentary, payload.commentary);

  const forbiddenDelete = await request(base, `/api/annotations/${annotationId}`, { method: 'DELETE', headers: { authorization: leo.authorization } });
  assert.equal(forbiddenDelete.response.status, 403);
  const comment = await request(base, `/api/annotations/${annotationId}/comments`, { method: 'POST', headers: { authorization: leo.authorization }, json: { text: 'A local test response.' } });
  assert.equal(comment.response.status, 201);
  assert.equal(comment.data.comment.author.id, leo.user.id);
  const receipt = await request(base, `/api/annotations/${annotationId}`);
  assert.equal(receipt.data.annotation.commentCount, 1);
  assert.equal(receipt.data.comments[0].id, comment.data.comment.id);
  assert.equal(receipt.data.comments[0].author.id, leo.user.id);
  assert.equal(receipt.data.comments[0].text, 'A local test response.');
  const operatorDelete = await request(base, `/api/comments/${comment.data.comment.id}`, { method: 'DELETE', headers: { authorization: mira.authorization } });
  assert.equal(operatorDelete.response.status, 200);

  const follow = await request(base, `/api/users/${mira.user.id}/follow`, { method: 'POST', headers: { authorization: leo.authorization }, json: { following: true } });
  assert.deepEqual(follow.data, { following: true });
  const followingFeed = await request(base, '/api/feed?following=1', { headers: { authorization: leo.authorization } });
  assert.deepEqual(followingFeed.data.annotations.map((item) => item.id), [annotationId]);
  const profile = await request(base, `/api/users/${mira.user.id}`, { headers: { authorization: leo.authorization } });
  assert.equal(profile.data.isFollowing, true);
  assert.equal(profile.data.followerCount, 1);

  const lookup = await request(base, '/api/sources/lookup', { method: 'POST', json: { key: await sourceKey(sourceUrl) } });
  assert.equal(lookup.data.annotations[0].id, annotationId);
  assert.equal(JSON.stringify(lookup.data).includes('@example'), false, 'public source APIs do not leak claim contacts');

  const claim = await request(base, '/api/claims', { method: 'POST', json: { annotationId, name: 'Local claimant', email: 'claimant@example.test', reason: 'Fixture correction', details: 'This is a test-only private intake record.' } });
  assert.equal(claim.response.status, 201);
  assert.match(claim.data.reference, /^claim_/);
  const nonAdmin = await request(base, '/api/admin/claims', { headers: { authorization: leo.authorization } });
  assert.equal(nonAdmin.response.status, 403);
  const claims = await request(base, '/api/admin/claims', { headers: { authorization: mira.authorization } });
  assert.equal(claims.data.claims[0].email, 'claimant@example.test');

  const hide = await request(base, `/api/admin/claims/${claim.data.reference}`, { method: 'POST', headers: { authorization: mira.authorization }, json: { action: 'hide', scope: 'annotation', note: 'Hidden during local test.' } });
  assert.equal(hide.response.status, 200);
  assert.equal((await request(base, `/api/annotations/${annotationId}`)).response.status, 404);
  const hiddenReceipt = await request(base, `/a/${annotationId}`);
  assert.equal(hiddenReceipt.response.status, 404);
  assert.doesNotMatch(JSON.stringify(hiddenReceipt.data), /source|quoted|og:title/i);
  assert.equal((await request(base, `/api/annotations/${annotationId}/share-card.png`)).response.status, 404);
  assert.equal((await request(base, '/api/feed')).data.annotations.length, 0);
  const restore = await request(base, `/api/admin/claims/${claim.data.reference}`, { method: 'POST', headers: { authorization: mira.authorization }, json: { action: 'restore', scope: 'annotation', note: 'Restored after local test.' } });
  assert.equal(restore.response.status, 200);
  assert.equal((await request(base, `/api/annotations/${annotationId}`)).response.status, 200);

  const deleted = await request(base, `/api/annotations/${annotationId}`, { method: 'DELETE', headers: { authorization: mira.authorization } });
  assert.equal(deleted.response.status, 200);
  assert.equal((await request(base, `/api/annotations/${annotationId}`)).response.status, 404);
  const deletedReceipt = await request(base, `/a/${annotationId}`);
  assert.equal(deletedReceipt.response.status, 404);
  assert.doesNotMatch(JSON.stringify(deletedReceipt.data), /source|quoted|og:title/i);
  assert.equal((await request(base, `/api/annotations/${annotationId}/share-card.png`)).response.status, 404);
});

test('media is probed, normalized, owner-linked, ranged and hidden with its annotation', { timeout: 60_000 }, async (t) => {
  const { base, dataDir } = await start(t);
  const mira = await signIn(base, 'mira');
  const leo = await signIn(base, 'leo');
  const inputVideo = join(dataDir, 'portrait-input.mp4');
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x480:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', inputVideo]);
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const videoBytes = await import('node:fs').then(({ readFileSync }) => readFileSync(inputVideo));

  const upload = await request(base, '/api/media', { method: 'POST', headers: { authorization: mira.authorization, 'content-type': 'video/mp4', 'x-media-role': 'source-video' }, body: videoBytes });
  assert.equal(upload.response.status, 201, JSON.stringify(upload.data));
  assert.ok(upload.data.duration > 0 && upload.data.duration <= 90);
  assert.ok(upload.data.height <= 240);

  const privateToPublic = await request(base, upload.data.url);
  assert.equal(privateToPublic.response.status, 404);
  const wrongOwner = await request(base, upload.data.url, { headers: { authorization: leo.authorization } });
  assert.equal(wrongOwner.response.status, 404);
  const ownerRange = await request(base, upload.data.url, { headers: { authorization: mira.authorization, range: 'bytes=0-31' } });
  assert.equal(ownerRange.response.status, 206);
  assert.equal(ownerRange.data.length, 32);
  assert.match(ownerRange.response.headers.get('content-range'), /^bytes 0-31\//);

  const wrongOwnerPost = await request(base, '/api/annotations', {
    method: 'POST', headers: { authorization: leo.authorization }, json: {
      clientId: 'foreign-media', source: { url: `${base}/fixtures/video.html`, title: 'Fixture video', kind: 'video', author: 'Annotated fixture' },
      excerpt: 'Test excerpt.', start: 0, end: 1, commentary: 'Test commentary.', mediaId: upload.data.id,
    },
  });
  assert.equal(wrongOwnerPost.response.status, 403);

  const mismatchedRange = await request(base, '/api/annotations', {
    method: 'POST', headers: { authorization: mira.authorization }, json: {
      clientId: 'mismatched-video-range', source: { url: `${base}/fixtures/video.html`, title: 'Fixture video', kind: 'video', author: 'Annotated fixture' },
      excerpt: '', start: 0, end: 12, commentary: 'Test commentary.', mediaId: upload.data.id,
    },
  });
  assert.equal(mismatchedRange.response.status, 400);
  assert.match(mismatchedRange.data.error, /match the uploaded/);

  const published = await request(base, '/api/annotations', {
    method: 'POST', headers: { authorization: mira.authorization }, json: {
      clientId: 'video-media', source: { url: `${base}/fixtures/video.html`, title: 'Fixture video', kind: 'video', author: 'Annotated fixture' },
      excerpt: '', start: 0, end: 1, commentary: 'Test commentary.', mediaId: upload.data.id,
    },
  });
  assert.equal(published.response.status, 201, JSON.stringify(published.data));
  assert.equal((await request(base, upload.data.url, { headers: { range: 'bytes=-16' } })).response.status, 206);
  const visibleMediaCard = await request(base, `/api/annotations/${published.data.annotation.id}/share-card.png`);
  assert.equal(visibleMediaCard.response.status, 200);
  assert.deepEqual(pngSize(visibleMediaCard.data), { width: 2400, height: 1260 });

  const claim = await request(base, '/api/claims', { method: 'POST', json: { annotationId: published.data.annotation.id, name: 'Media claimant', email: 'media@example.test', reason: 'Media review', details: 'Private local media review details.' } });
  const hideMedia = await request(base, `/api/admin/claims/${claim.data.reference}`, { method: 'POST', headers: { authorization: mira.authorization }, json: { action: 'hide', scope: 'media', note: '' } });
  assert.equal(hideMedia.response.status, 200);
  assert.equal((await request(base, upload.data.url, { headers: { authorization: mira.authorization } })).response.status, 404);
  const hiddenMediaCard = await request(base, `/api/annotations/${published.data.annotation.id}/share-card.png`);
  assert.equal(hiddenMediaCard.response.status, 200, 'a public annotation degrades when only its source media is hidden');
  assert.deepEqual(pngSize(hiddenMediaCard.data), { width: 2400, height: 1260 });
  assert.notDeepEqual(hiddenMediaCard.data, visibleMediaCard.data, 'the cached public thumbnail is not reused after media is hidden');
  await request(base, `/api/admin/claims/${claim.data.reference}`, { method: 'POST', headers: { authorization: mira.authorization }, json: { action: 'restore', scope: 'media', note: '' } });
  assert.equal((await request(base, upload.data.url)).response.status, 200);
  await request(base, `/api/annotations/${published.data.annotation.id}`, { method: 'DELETE', headers: { authorization: mira.authorization } });
  assert.equal((await request(base, upload.data.url, { headers: { authorization: mira.authorization } })).response.status, 404);

  const longAudio = join(dataDir, 'too-long.ogg');
  const longGenerated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=91', '-c:a', 'libopus', '-b:a', '12k', longAudio]);
  assert.equal(longGenerated.status, 0, longGenerated.stderr?.toString());
  const audioBytes = await import('node:fs').then(({ readFileSync }) => readFileSync(longAudio));
  const rejected = await request(base, '/api/media', { method: 'POST', headers: { authorization: mira.authorization, 'content-type': 'audio/ogg', 'x-media-role': 'voice' }, body: audioBytes });
  assert.equal(rejected.response.status, 422);
  assert.match(rejected.data.error, /90 seconds/);
});

test('90 second WebM audio and video publish at or below 90 while longer media and ranges fail', { timeout: 60_000 }, async (t) => {
  const { base, dataDir } = await start(t);
  const mira = await signIn(base, 'mira');
  const exactPath = join(dataDir, 'exact-90.webm');
  const exactVideoPath = join(dataDir, 'exact-video-90.webm');
  const overPath = join(dataDir, 'over-90.webm');
  for (const [duration, path] of [['90', exactPath], ['90.1', overPath]]) {
    const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${duration}`, '-c:a', 'libopus', '-b:a', '12k', path]);
    assert.equal(generated.status, 0, generated.stderr?.toString());
  }
  const generatedVideo = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=5:d=90', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=90', '-shortest', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '80k', '-c:a', 'libopus', '-b:a', '12k', exactVideoPath]);
  assert.equal(generatedVideo.status, 0, generatedVideo.stderr?.toString());
  const probe = (path) => {
    const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return Number(result.stdout.trim());
  };
  const exactContainerDuration = probe(exactPath);
  const exactVideoContainerDuration = probe(exactVideoPath);
  const overContainerDuration = probe(overPath);
  assert.ok(exactContainerDuration > 90 && exactContainerDuration <= 90.02, `expected only WebM packet padding, got ${exactContainerDuration}`);
  assert.ok(exactVideoContainerDuration > 90 && exactVideoContainerDuration <= 90.02, `expected only WebM packet padding, got ${exactVideoContainerDuration}`);
  assert.ok(overContainerDuration > 90.02);

  const { readFileSync } = await import('node:fs');
  const exact = await request(base, '/api/media', {
    method: 'POST',
    headers: { authorization: mira.authorization, 'content-type': 'audio/webm', 'x-media-role': 'source-audio' },
    body: readFileSync(exactPath),
  });
  assert.equal(exact.response.status, 201, JSON.stringify(exact.data));
  assert.ok(exact.data.duration <= 90, `published duration was ${exact.data.duration}`);
  assert.ok(exact.data.duration >= 89.9, `normalization removed too much media: ${exact.data.duration}`);
  const exactVideo = await request(base, '/api/media', {
    method: 'POST',
    headers: { authorization: mira.authorization, 'content-type': 'video/webm', 'x-media-role': 'source-video' },
    body: readFileSync(exactVideoPath),
  });
  assert.equal(exactVideo.response.status, 201, JSON.stringify(exactVideo.data));
  assert.ok(exactVideo.data.duration <= 90, `published video duration was ${exactVideo.data.duration}`);
  assert.ok(exactVideo.data.duration >= 89.9, `video normalization removed too much media: ${exactVideo.data.duration}`);
  assert.ok(exactVideo.data.height <= 240);

  const annotation = await request(base, '/api/annotations', {
    method: 'POST', headers: { authorization: mira.authorization }, json: {
      clientId: 'exact-90-range', source: { url: `${base}/fixtures/audio.html`, title: 'Boundary fixture audio', kind: 'audio', author: 'Annotated fixture' },
      excerpt: '', start: 0, end: 90, commentary: 'A local boundary verification.', mediaId: exact.data.id,
    },
  });
  assert.equal(annotation.response.status, 201, JSON.stringify(annotation.data));
  const overRange = await request(base, '/api/annotations', {
    method: 'POST', headers: { authorization: mira.authorization }, json: {
      clientId: 'over-90-range', source: { url: `${base}/fixtures/audio.html`, title: 'Boundary fixture audio', kind: 'audio', author: 'Annotated fixture' },
      excerpt: '', start: 0, end: 90.001, commentary: 'This range must fail.', mediaId: exact.data.id,
    },
  });
  assert.equal(overRange.response.status, 400);

  const rejected = await request(base, '/api/media', {
    method: 'POST',
    headers: { authorization: mira.authorization, 'content-type': 'audio/webm', 'x-media-role': 'source-audio' },
    body: readFileSync(overPath),
  });
  assert.equal(rejected.response.status, 422);
  assert.match(rejected.data.error, /90 seconds/);
});


test('reading pages expose The point social image and browser manifest', async (t) => {
  const { base } = await start(t);
  const page = await request(base, '/feed');
  const html = page.data.toString('utf8');
  assert.match(html, /<meta property="og:image" content="http:\/\/127\.0\.0\.1:4317\/web\/logo\/logo-512\.png">/);
  assert.match(html, /<link rel="manifest" href="\/web\/site\.webmanifest">/);
  const manifest = await fetch(`${base}/web/site.webmanifest`);
  assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');
  for (const icon of (await manifest.json()).icons) {
    const image = await fetch(`${base}${icon.src}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await image.arrayBuffer());
    assert.equal(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, icon.sizes);
  }
});
