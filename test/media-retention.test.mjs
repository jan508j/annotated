import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server/index.mjs';
import { DRAFT_MEDIA_TTL_MS, MEDIA_CLEANUP_INTERVAL_MS, sweepAbandonedMedia } from '../server/media-retention.mjs';

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'annotated-retention-'));
  const server = createServer({ dataDir, seed: false });
  const db = server.database;
  const at = Date.now();
  let closed = false;
  server.on('close', () => { closed = true; });
  t.after(async () => {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    else if (!closed) db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const old = at - DRAFT_MEDIA_TTL_MS - 60_000;
  const upload = ({ created = old, role = 'source-video', file, missing = false } = {}) => {
    const id = `media_${randomUUID().replaceAll('-', '')}`;
    const path = file || join(dataDir, 'media', `${id}${role === 'source-video' ? '.mp4' : '.m4a'}`);
    if (!missing) {
      // Original test bytes: these tests check retention, not media playback.
      writeFileSync(path, 'Original retention test bytes');
      utimesSync(path, new Date(created), new Date(created));
    }
    db.prepare('INSERT INTO media VALUES (?,?,?,?,?,?,?,?,?,0,?)').run(id, 'demo-mira', role, path,
      role === 'source-video' ? 'video/mp4' : 'audio/mp4', 29, 1, null, null, new Date(created).toISOString());
    return { id, path };
  };
  db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?,?)').run('source-retention', 'retention-test', 'https://example.test/retention', 'Retention fixture', 'video', 'Test corpus', new Date(at).toISOString());
  const attach = (source, voice, { hidden = 0, deleted = 0 } = {}) => {
    const id = randomUUID();
    db.prepare('INSERT INTO annotations (id,client_id,author_id,source_id,excerpt,start,end,commentary,media_id,voice_media_id,is_demo,hidden,deleted,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, id, 'demo-mira', 'source-retention', '', 0, 1,
      'A local retention test', source?.id || null, voice?.id || null, 1, hidden, deleted, new Date(at).toISOString());
  };
  return { dataDir, db, server, at, old, upload, attach };
}

test('retention removes only expired unreferenced uploads and keeps every annotation reference', t => {
  const f = fixture(t);
  const abandonedSource = f.upload();
  const abandonedVoice = f.upload({ role: 'voice' });
  const missing = f.upload({ missing: true });
  const recent = f.upload({ created: f.at });
  const atBoundary = f.upload({ created: f.at - DRAFT_MEDIA_TTL_MS + 1 });
  const source = f.upload();
  const voice = f.upload({ role: 'voice' });
  const hidden = f.upload();
  const deleted = f.upload();
  f.attach(source, voice);
  f.attach(hidden, null, { hidden: 1 });
  f.attach(deleted, null, { deleted: 1 });
  f.db.prepare('UPDATE media SET hidden=1 WHERE id=?').run(hidden.id);
  const result = sweepAbandonedMedia(f.db, f.dataDir, f.at);
  assert.deepEqual(result, { uploads: 3, orphanFiles: 0, temporaryFiles: 0, failures: 0 });
  for (const media of [abandonedSource, abandonedVoice, missing]) {
    assert.equal(existsSync(media.path), false);
    assert.equal(f.db.prepare('SELECT 1 FROM media WHERE id=?').get(media.id), undefined);
  }
  for (const media of [recent, atBoundary, source, voice, hidden, deleted]) {
    assert.equal(existsSync(media.path), true);
    assert.ok(f.db.prepare('SELECT 1 FROM media WHERE id=?').get(media.id));
  }
  assert.equal(sweepAbandonedMedia(f.db, f.dataDir, f.at).uploads, 0, 'a repeated sweep is harmless');
});

test('retention cleans old interrupted files without following symlinks or deleting unrelated files', t => {
  const f = fixture(t);
  const make = (folder, name, created = f.old) => {
    const path = join(f.dataDir, folder, name);
    writeFileSync(path, 'Original interrupted-upload test bytes');
    utimesSync(path, new Date(created), new Date(created));
    return path;
  };
  const name = suffix => `media_${randomUUID().replaceAll('-', '')}.${suffix}`;
  const orphan = make('media', name('mp4'));
  const staleInput = make('tmp', name('upload'));
  const staleOutput = make('tmp', name('m4a'));
  const recentTemp = make('tmp', name('upload'), f.at);
  const recentOrphan = make('media', name('mp4'), f.at);
  const unrelated = make('media', 'keep-me.mp4');
  const outside = make('', 'outside.mp4');
  const symlink = join(f.dataDir, 'media', name('mp4'));
  symlinkSync(outside, symlink);
  const badRow = f.upload({ file: outside });
  const result = sweepAbandonedMedia(f.db, f.dataDir, f.at);
  assert.deepEqual(result, { uploads: 0, orphanFiles: 1, temporaryFiles: 2, failures: 1 });
  for (const path of [orphan, staleInput, staleOutput]) assert.equal(existsSync(path), false);
  for (const path of [recentTemp, recentOrphan, unrelated, outside, symlink]) assert.equal(existsSync(path), true);
  assert.ok(f.db.prepare('SELECT 1 FROM media WHERE id=?').get(badRow.id));
  assert.match(readFileSync(outside, 'utf8'), /retention test bytes/);
});

test('retention batches old uploads and continues on the next sweep', t => {
  const f = fixture(t);
  for (let n = 0; n < 105; n++) f.upload();
  assert.equal(sweepAbandonedMedia(f.db, f.dataDir, f.at).uploads, 100);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM media').get().count, 5);
  assert.equal(sweepAbandonedMedia(f.db, f.dataDir, f.at).uploads, 5);
});

test('service runs retention at startup and periodically; expired clips cannot be read or published', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t);
  const stale = f.upload();
  const recent = f.upload({ created: f.at });
  await new Promise((resolve, reject) => {
    f.server.once('error', reject);
    f.server.listen(0, '127.0.0.1', resolve);
  });
  assert.equal(existsSync(stale.path), false, 'listening triggers a startup sweep');
  assert.equal(existsSync(recent.path), true);
  f.db.prepare('UPDATE media SET created_at=? WHERE id=?').run(new Date(f.old).toISOString(), recent.id);
  t.mock.timers.tick(MEDIA_CLEANUP_INTERVAL_MS);
  assert.equal(existsSync(recent.path), false, 'the interval removes later expired drafts');
  const base = `http://127.0.0.1:${f.server.address().port}`;
  const login = await fetch(`${base}/api/dev/session`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ persona: 'mira' })
  }).then(res => res.json());
  const headers = { authorization: `Bearer ${login.token}` };
  assert.equal((await fetch(`${base}/media/${recent.id}`, { headers })).status, 404);
  const failed = await fetch(`${base}/api/annotations`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'expired-media', source: { url: 'https://example.test/retention', title: 'Retention test', kind: 'video', author: 'Test corpus' }, start: 0, end: 1, commentary: 'Preserve this written take.', mediaId: recent.id })
  });
  assert.equal(failed.status, 410);
  assert.match((await failed.json()).error, /Record it again/);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM annotations').get().count, 0);
});
