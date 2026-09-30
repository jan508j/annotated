import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { createCloudMedia } from '../server/cloud-media.mjs';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const DAY = 86_400_000;
const id = suffix => `media_${suffix.padStart(32, '0')}`;

async function fixture(t, { limits = { dailyUploads: 20, monthlyUploads: 200, storageBytes: 1024 ** 3 } } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE media (id TEXT PRIMARY KEY,owner_id TEXT,role TEXT,path TEXT,content_type TEXT,bytes INTEGER,duration REAL,width INTEGER,height INTEGER,hidden INTEGER,created_at TEXT);
    CREATE TABLE annotations (media_id TEXT,voice_media_id TEXT);`);
  db.prepare('INSERT INTO users VALUES (?)').run('owner');
  db.prepare('INSERT INTO users VALUES (?)').run('other');
  let queue = Promise.resolve();
  db.kind = 'sqlite';
  db.transaction = work => {
    const task = queue.then(async () => {
      db.exec('BEGIN IMMEDIATE');
      try { const value = await work(db); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    queue = task.catch(() => {});
    return task;
  };
  t.after(() => db.close());
  const objects = new Map();
  const calls = { tokens: [], puts: [], deletes: [], gets: [] };
  const sdk = {
    async head(pathname) {
      const object = objects.get(pathname);
      return object && { pathname, size: object.bytes.length, contentType: object.type };
    },
    async get(pathname, options) {
      calls.gets.push({ pathname, options });
      const object = objects.get(pathname);
      return object && { blob: { size: object.bytes.length }, stream: new Blob([object.bytes]).stream() };
    },
    async put(pathname, stream, options) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      calls.puts.push({ pathname, options, bytes });
      objects.set(pathname, { bytes, type: options.contentType });
    },
    async del(pathname) { calls.deletes.push(pathname); objects.delete(pathname); },
  };
  const cloud = await createCloudMedia(db, {
    token: 'unit-test-token', limits, sdk, clock: () => NOW,
    generateToken: async options => { calls.tokens.push(options); return 'scoped-unit-test-token'; },
    normalize: async (_role, input, output) => {
      assert.equal((await readFile(input)).toString(), 'test upload');
      await writeFile(output, 'normalized test media');
      return { duration: 5, width: 320, height: 180 };
    },
  });
  return { db, cloud, objects, calls };
}

test('upload token is exact and private; completion is owner-scoped and idempotent', async t => {
  const f = await fixture(t);
  const reserved = await f.cloud.reserve({ id: 'owner' }, { role: 'source-video', contentType: 'video/webm;codecs=vp8', size: 11 });
  assert.match(reserved.pathname, /^drafts\/media_[a-f0-9]{32}\.upload$/);
  assert.equal(reserved.clientToken, 'scoped-unit-test-token');
  assert.deepEqual(f.calls.tokens[0], {
    token: 'unit-test-token', pathname: reserved.pathname, maximumSizeInBytes: 11,
    allowedContentTypes: ['video/webm'], validUntil: NOW + 600_000,
    allowOverwrite: false, addRandomSuffix: false, cacheControlMaxAge: 0,
  });
  f.objects.set(reserved.pathname, { bytes: Buffer.from('test upload'), type: 'video/webm' });
  await assert.rejects(f.cloud.complete({ id: 'other' }, reserved.id), { status: 404 });
  const first = await f.cloud.complete({ id: 'owner' }, reserved.id);
  assert.deepEqual(first, { id: reserved.id, url: `/media/${reserved.id}`, duration: 5, width: 320, height: 180 });
  assert.equal(f.calls.puts.length, 1);
  assert.equal(f.calls.puts[0].pathname, `media/${reserved.id}.mp4`);
  assert.equal(f.calls.puts[0].options.access, 'private');
  assert.equal(f.calls.puts[0].options.allowOverwrite, false);
  assert.deepEqual(await f.cloud.complete({ id: 'owner' }, reserved.id), first);
  assert.equal(f.calls.puts.length, 1, 'retry does not publish a second object');
  await f.cloud.open(`blob:media/${reserved.id}.mp4`, 'bytes=0-3');
  assert.equal(f.calls.gets.at(-1).options.access, 'private');
  assert.deepEqual(f.calls.gets.at(-1).options.headers, { Range: 'bytes=0-3' });
});

test('concurrent reservations enforce daily quota and rejected work does not spend it', async t => {
  const f = await fixture(t, { limits: { dailyUploads: 1, monthlyUploads: 1, storageBytes: 1024 ** 3 } });
  await assert.rejects(f.cloud.reserve({ id: 'owner' }, { role: 'source-video', contentType: 'image/png', size: 11 }), { status: 415 });
  const requests = await Promise.allSettled([1, 2].map(() => f.cloud.reserve({ id: 'owner' }, { role: 'source-video', contentType: 'video/webm', size: 11 })));
  assert.equal(requests.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(requests.filter(item => item.status === 'rejected' && item.reason.status === 429).length, 1);
  assert.equal(f.db.prepare("SELECT uploads FROM cloud_budget WHERE id='day:2026-09-24'").get().uploads, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM media_uploads').get().count, 1);
});

test('storage reservation accounts for published media and pending output allowance', async t => {
  const f = await fixture(t, { limits: { dailyUploads: 20, monthlyUploads: 200, storageBytes: 12 * 1024 * 1024 } });
  await assert.rejects(f.cloud.reserve({ id: 'owner' }, { role: 'source-video', contentType: 'video/webm', size: 11 }), { status: 429 });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM media_uploads').get().count, 0);
  assert.equal(f.db.prepare("SELECT uploads FROM cloud_budget WHERE id='day:2026-09-24'").get(), undefined, 'rolled-back reservation spends no quota');
});

test('cleanup keeps referenced media and removes old unreferenced objects and drafts', async t => {
  const f = await fixture(t);
  const old = new Date(NOW - DAY - 1).toISOString();
  const recent = new Date(NOW).toISOString();
  const insert = (mediaId, createdAt) => {
    const path = `media/${mediaId}.mp4`;
    f.db.prepare('INSERT INTO media VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(mediaId, 'owner', 'source-video', `blob:${path}`, 'video/mp4', 12, 5, 320, 180, 0, createdAt);
    f.objects.set(path, { bytes: Buffer.from('test media'), type: 'video/mp4' });
  };
  insert(id('1'), old);
  insert(id('2'), old);
  insert(id('3'), recent);
  f.db.prepare('INSERT INTO annotations VALUES (?,?)').run(id('2'), null);
  const draft = id('4');
  f.db.prepare('INSERT INTO media_uploads VALUES (?,?,?,?,?,?,?,?,?,?)').run(draft, 'owner', 'source-video', `drafts/${draft}.upload`, 'video/webm', 11, 'pending', old, old, 0);
  f.objects.set(`drafts/${draft}.upload`, { bytes: Buffer.from('test upload'), type: 'video/webm' });
  const summary = await f.cloud.cleanup();
  assert.deepEqual(summary, { drafts: 1, media: 1, failures: 0 });
  assert.equal(f.db.prepare('SELECT 1 FROM media WHERE id=?').get(id('1')), undefined);
  assert.ok(f.db.prepare('SELECT 1 FROM media WHERE id=?').get(id('2')));
  assert.ok(f.db.prepare('SELECT 1 FROM media WHERE id=?').get(id('3')));
  assert.equal(f.objects.has(`media/${id('1')}.mp4`), false);
  assert.equal(f.objects.has(`media/${id('2')}.mp4`), true);
  assert.equal(f.objects.has(`drafts/${draft}.upload`), false);
  assert.equal(f.db.prepare('SELECT state,raw_deleted FROM media_uploads WHERE id=?').get(draft).raw_deleted, 1);
});
