import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createServer } from '../server/index.mjs';
import { normalizeProfilePhoto, profileBio } from '../server/profile.mjs';

async function setup(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'annotated-profiles-'));
  const server = createServer({ dataDir, seed: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, body, authorization, headers = {}) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(authorization ? { authorization } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, data: (response.headers.get('content-type') || '').includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  }
  const mira = await request('/api/dev/session', { persona: 'mira' }, null, { origin: base });
  const leo = await request('/api/dev/session', { persona: 'leo' }, null, { origin: base });
  return { base, db: server.database, request, mira: `Bearer ${mira.data.token}`, leo: `Bearer ${leo.data.token}`, cookie: mira.headers.get('set-cookie').split(';')[0] };
}

async function photo(format = 'png', fill = '#f00') {
  const canvas = createCanvas(512, 256);
  const context = canvas.getContext('2d');
  context.fillStyle = '#00f'; context.fillRect(0, 0, 512, 256);
  context.fillStyle = fill; context.fillRect(128, 0, 256, 256);
  const bytes = await canvas.encode(format);
  return `data:image/${format};base64,${bytes.toString('base64')}`;
}

test('profile photos are cropped, re-encoded and bounded before storage', async () => {
  for (const format of ['png', 'jpeg', 'webp']) {
    const normalized = await normalizeProfilePhoto(await photo(format));
    const bytes = Buffer.from(normalized.base64, 'base64');
    const image = await loadImage(bytes);
    assert.equal(image.width, 256); assert.equal(image.height, 256);
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
    assert.ok(bytes.length <= 65536);
    const canvas = createCanvas(256, 256); const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const pixel = context.getImageData(128, 128, 1, 1).data;
    assert.ok(pixel[0] > 230 && pixel[2] < 25, 'centre of photo is retained');
  }
  const oversized = createCanvas(2049, 1).toDataURL('image/png');
  for (const invalid of ['data:image/svg+xml;base64,PHN2Zz4=', 'https://example.com/avatar.png', 'data:image/png;base64,YWJj', oversized]) await assert.rejects(normalizeProfilePhoto(invalid), { status: 400 });
  assert.equal(profileBio('  Short\r\n bio\rsecond line  '), 'Short\n bio\nsecond line');
  assert.equal(Array.from(profileBio('😀'.repeat(160))).length, 160);
  assert.throws(() => profileBio('😀'.repeat(161)), { status: 400 });
  assert.throws(() => profileBio('Line one\u0000Line two'), { status: 400 });
  assert.equal(profileBio('é'.repeat(160)).length, 160);
  assert.throws(() => profileBio('a'.repeat(161)), { status: 400 });
});

test('profile edits are owner-only, atomic, and visible throughout public author data', async t => {
  const { request, mira, leo, base, cookie } = await setup(t);
  const endpoint = '/api/users/demo-leo/profile';
  assert.equal((await request(endpoint, { bio: 'changed' })).status, 401);
  assert.equal((await request(endpoint, { bio: 'changed' }, mira)).status, 403, 'even an admin cannot edit another profile');
  assert.equal((await request('/api/users/demo-mira/profile', { bio: 'changed' }, null, { cookie, origin: 'https://evil.test' })).status, 403);
  assert.equal((await request('/api/users/demo-mira/profile', { bio: 'changed' }, null, { cookie })).status, 403);
  assert.equal((await request(endpoint, { name: 'replacement' }, leo)).status, 400);
  const saved = await request(endpoint, { bio: 'A short bio.\nSecond line 😀', photo: await photo() }, leo);
  assert.equal(saved.status, 200); assert.equal(saved.data.user.bio, 'A short bio.\nSecond line 😀');
  const avatar = saved.data.user.avatarUrl;
  const image = await request(avatar);
  assert.equal(image.status, 200); assert.match(image.headers.get('content-type'), /image\/webp/);
  assert.equal((await fetch(base + avatar, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(base + avatar, { headers: { 'if-none-match': image.headers.get('etag') } })).status, 304);
  assert.equal((await request(endpoint, { bio: 'Must not save', photo: 'bad photo' }, leo)).status, 400);
  const afterFailedSave = (await request('/api/users/demo-leo')).data.user;
  assert.equal(afterFailedSave.bio, 'A short bio.\nSecond line 😀');
  assert.equal(afterFailedSave.avatarUrl, avatar, 'failed photo leaves the saved photo intact');
  assert.equal((await request(endpoint, { bio: 'Updated only.' }, leo)).data.user.avatarUrl, avatar);
  assert.equal((await request('/api/session', undefined, leo)).data.user.avatarUrl, avatar);
  const created = await request('/api/annotations', { clientId: 'profile-article', source: { url: 'https://example.test/profile', title: 'Original source', kind: 'article', author: '', publisher: 'Example Publisher' }, excerpt: 'A selected passage.', commentary: 'A real take.' }, leo);
  assert.equal(created.status, 201); assert.equal(created.data.annotation.author.avatarUrl, avatar);
  assert.equal(created.data.annotation.source.publisher, 'Example Publisher');
  const comment = await request(`/api/annotations/${created.data.annotation.id}/comments`, { text: 'A reply.' }, leo);
  assert.equal(comment.data.comment.author.avatarUrl, avatar);
  const receipt = (await request(`/api/annotations/${created.data.annotation.id}`)).data;
  assert.equal(receipt.comments[0].author.avatarUrl, avatar);
  const profile = (await request('/api/users/demo-leo')).data;
  assert.equal(profile.annotationCount, 1); assert.equal(profile.followerCount, 0); assert.equal(profile.followingCount, 0);
  await request('/api/users/demo-leo/follow', { following: true }, mira);
  assert.equal((await request('/api/users/demo-leo')).data.followerCount, 1);
  assert.equal((await request('/api/users/demo-mira')).data.followingCount, 1);
  assert.equal((await request('/api/sources/' + created.data.annotation.source.id)).data.source.publisher, 'Example Publisher');
  assert.equal((await request(endpoint, { photo: null }, leo)).data.user.avatarUrl, null);
  assert.equal((await request(avatar)).status, 404, 'removed image is no longer served');
  assert.equal((await request('/api/users/demo-leo')).data.user.bio, 'Updated only.');
});

test('source filtering precedes limits and combines with following and visibility', async t => {
  const { db, request, mira } = await setup(t);
  // Metadata-only local fixtures test query behavior, not captured-media validity.
  for (const [index, kind, author, hidden, deleted, voice] of [
    [1, 'article', 'demo-leo', 0, 0, true], [2, 'video', 'demo-leo', 0, 0, false],
    [3, 'audio', 'demo-leo', 0, 0, false], [4, 'video', 'demo-mira', 0, 0, false],
    [5, 'article', 'demo-leo', 1, 0, false], [6, 'audio', 'demo-leo', 0, 1, false]
  ]) {
    const at = `2026-09-30T10:0${index}:00.000Z`;
    db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?,?)').run(`s${index}`, `k${index}`, `https://example.test/${index}`, 'Local filter fixture', kind, '', at);
    if (voice) db.prepare('INSERT INTO media VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('voice-fixture', author, 'voice', '/not-a-recording', 'audio/mp4', 1, 1, null, null, 0, at);
    db.prepare(`INSERT INTO annotations (id,client_id,author_id,source_id,excerpt,commentary,voice_media_id,is_demo,hidden,deleted,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(`a${index}`, `c${index}`, author, `s${index}`, 'Fixture evidence', 'Fixture take', voice ? 'voice-fixture' : null, 1, hidden, deleted, at);
  }
  const ids = async (path, token) => (await request(path, undefined, token)).data.annotations.map(a => a.id);
  assert.deepEqual(await ids('/api/feed?limit=1'), ['a4']);
  assert.deepEqual(await ids('/api/feed?type=text&limit=1'), ['a1'], 'voice commentary does not turn article evidence into audio');
  assert.deepEqual(await ids('/api/feed?type=audio'), ['a3']);
  assert.deepEqual(await ids('/api/feed?format=text&limit=1'), ['a1']);
  assert.deepEqual(await ids('/api/feed?format=audio'), ['a3']);
  assert.deepEqual(await ids('/api/feed?format=video&type=text&limit=1'), ['a4'], 'canonical format takes precedence over type');
  assert.deepEqual(await ids('/api/feed?format=all&type=unknown'), ['a4', 'a3', 'a2', 'a1']);
  assert.equal((await request('/api/feed?type=unknown')).status, 400);
  assert.equal((await request('/api/feed?format=unknown&type=text')).status, 400);
  assert.equal((await request('/api/feed?format=')).status, 400);
  assert.equal((await request('/api/feed?following=1&type=video')).status, 401);
  assert.equal((await request('/api/feed?audience=following&format=video')).status, 401);
  assert.equal((await request('/api/feed?audience=unknown')).status, 400);
  assert.equal((await request('/api/feed?audience=&following=1')).status, 400);
  await request('/api/users/demo-leo/follow', { following: true }, mira);
  assert.deepEqual(await ids('/api/feed?following=1&type=video&limit=1', mira), ['a2']);
  assert.deepEqual(await ids('/api/feed?audience=following&format=video&limit=1', mira), ['a2']);
  assert.deepEqual(await ids('/api/feed?audience=everyone&following=1&format=video&limit=1'), ['a4'], 'canonical audience takes precedence over following');
  assert.deepEqual(await ids('/api/feed?audience=following&following=0&format=audio', mira), ['a3']);
  assert.deepEqual(await ids('/api/feed?type=all'), ['a4', 'a3', 'a2', 'a1']);
  assert.equal((await request('/api/users/demo-leo')).data.annotationCount, 3);
});

test('profile people lists distinguish followers from following and expose only public identity', async t => {
  const { db, request, mira, leo } = await setup(t);
  assert.deepEqual((await request('/api/users/demo-mira/followers')).data, { users: [], nextOffset: null });
  await request('/api/users/demo-leo/follow', { following: true }, mira);
  db.prepare('UPDATE users SET email=?,provider_subject=? WHERE id=?').run('private@example.test', 'private-provider-subject', 'demo-mira');
  db.prepare('INSERT INTO user_profiles (user_id,bio,avatar_base64,avatar_version,updated_at) VALUES (?,?,?,?,?)').run('demo-mira', 'Public bio', 'private-image-bytes', 'photo-version', new Date().toISOString());
  const followers = (await request('/api/users/demo-leo/followers')).data;
  assert.equal(followers.users[0].id, 'demo-mira');
  assert.equal(followers.users[0].avatarUrl, '/api/users/demo-mira/avatar?v=photo-version');
  assert.deepEqual(Object.keys(followers.users[0]).sort(), ['avatarUrl','color','handle','id','name']);
  assert.equal((await request('/api/users/demo-leo/following')).data.users.length, 0);
  assert.equal((await request('/api/users/demo-mira/following')).data.users[0].id, 'demo-leo');
  assert.equal((await request('/api/users/demo-mira/followers')).data.users.length, 0);
  await request('/api/users/demo-mira/follow', { following: true }, leo);
  assert.equal((await request('/api/users/demo-mira/followers')).data.users[0].id, 'demo-leo');
  await request('/api/users/demo-leo/follow', { following: false }, mira);
  assert.equal((await request('/api/users/demo-leo/followers')).data.users.length, 0);
  assert.equal((await request('/api/users/demo-mira/following')).data.users.length, 0);
  assert.equal((await request('/api/users/missing/followers')).status, 404);
  for (const offset of ['-1','1.5','not-a-number','1e3','9007199254740992','']) {
    assert.equal((await request('/api/users/demo-mira/following?offset='+offset)).status, 400);
  }
});

test('feed pages stay ordered across equal timestamps, new posts, deletions and filtered following', async t => {
  const { db, request, mira } = await setup(t);
  const at = '2026-10-01T10:00:00.000Z';
  for (const kind of ['article', 'video']) db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?,?)')
    .run(kind, kind, `https://example.test/${kind}`, 'Local pagination fixture', kind, '', at);
  const insert = (id, author = 'demo-leo', kind = 'article', hidden = 0, deleted = 0, date = at) => db.prepare(`INSERT INTO annotations
    (id,client_id,author_id,source_id,excerpt,commentary,is_demo,hidden,deleted,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, id, author, kind, 'Local fixture evidence', 'Local fixture take', 1, hidden, deleted, date);
  const expected = Array.from({ length: 32 }, (_, i) => `page-${String(32 - i).padStart(2, '0')}`);
  expected.forEach(id => insert(id));
  insert('hidden', 'demo-leo', 'article', 1); insert('deleted', 'demo-leo', 'article', 0, 1);
  const first = (await request('/api/feed?limit=15')).data;
  assert.deepEqual(first.annotations.map(a => a.id), expected.slice(0, 15));
  assert.ok(first.annotations.every(a => a.isFollowing === false));
  assert.equal(typeof first.nextCursor, 'string');
  // Moving the head or removing the page boundary must not skip/duplicate older rows.
  insert('newer', 'demo-leo', 'article', 0, 0, '2026-10-01T11:00:00.000Z');
  db.prepare('UPDATE annotations SET deleted = 1 WHERE id = ?').run(expected[14]);
  const second = (await request(`/api/feed?limit=15&cursor=${first.nextCursor}`)).data;
  assert.deepEqual(second.annotations.map(a => a.id), expected.slice(15, 30));
  const third = (await request(`/api/feed?limit=15&cursor=${second.nextCursor}`)).data;
  assert.deepEqual(third.annotations.map(a => a.id), expected.slice(30));
  assert.equal(third.nextCursor, null);

  for (const id of ['video-1', 'video-2', 'video-3']) insert(id, 'demo-leo', 'video');
  insert('video-other', 'demo-mira', 'video');
  await request('/api/users/demo-leo/follow', { following: true }, mira);
  const filter = '/api/feed?audience=following&format=video&limit=2';
  const followed = (await request(filter, undefined, mira)).data;
  assert.deepEqual(followed.annotations.map(a => a.id), ['video-3', 'video-2']);
  assert.ok(followed.annotations.every(a => a.isFollowing === true));
  const last = (await request(`${filter}&cursor=${followed.nextCursor}`, undefined, mira)).data;
  assert.deepEqual(last.annotations.map(a => a.id), ['video-1']);
  assert.equal(last.nextCursor, null);
  assert.equal((await request(`${filter}&cursor=${followed.nextCursor}`)).status, 401);
  const exact = (await request('/api/feed?format=video&limit=4')).data;
  assert.equal(exact.annotations.length, 4); assert.equal(exact.nextCursor, null);
  const signedIn = (await request('/api/feed?format=video&limit=4', undefined, mira)).data;
  assert.ok(signedIn.annotations.every(a => a.isFollowing === (a.author.id === 'demo-leo')));
  assert.deepEqual((await request('/api/feed?format=audio&limit=15')).data, { annotations: [], nextCursor: null });
  for (const cursor of ['', 'garbage', 'a'.repeat(513), Buffer.from('{"createdAt":"bad","id":"page-01"}').toString('base64url'),
    Buffer.from(JSON.stringify({ createdAt: at, id: "' OR 1=1" })).toString('base64url')]) {
    assert.equal((await request('/api/feed?cursor=' + cursor)).status, 400);
  }
});

test('profile people lists paginate deterministically without truncating large lists', async t => {
  const { db, request } = await setup(t);
  const ids = Array.from({ length: 53 }, (_, i) => `list-fixture-${String(i).padStart(2,'0')}`);
  for (const id of ids) {
    db.prepare('INSERT INTO users (id,name,handle,color,is_demo,is_admin) VALUES (?,?,?,?,?,?)').run(id, 'Local list fixture', id, '#f8ce73', 1, 0);
    db.prepare('INSERT INTO follows VALUES (?,?,?)').run(id, 'demo-mira', '2026-09-30T12:00:00.000Z');
  }
  const first = (await request('/api/users/demo-mira/followers')).data;
  assert.deepEqual(first.users.map(u => u.id), ids.slice(0,50));
  assert.equal(first.nextOffset, 50);
  const last = (await request('/api/users/demo-mira/followers?offset='+first.nextOffset)).data;
  assert.deepEqual(last.users.map(u => u.id), ids.slice(50));
  assert.equal(last.nextOffset, null);
  assert.deepEqual((await request('/api/users/demo-mira/followers?offset=100')).data, { users: [], nextOffset: null });
});
