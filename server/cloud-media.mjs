import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as blobSdk from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import { MediaError, MAX_MEDIA_BYTES, MAX_OUTPUT_BYTES, mediaType, processMediaFile } from './media-processing.mjs';

const DAY = 86_400_000;
const TOKEN_TTL = 10 * 60_000;
const PREFIX = 'blob:';
const ID = /^media_[a-f0-9]{32}$/;
const PATH = /^(?:drafts\/media_[a-f0-9]{32}\.upload|media\/media_[a-f0-9]{32}\.(?:mp4|m4a))$/;
const iso = at => new Date(at).toISOString();
const lock = db => db.kind === 'postgres' ? ' FOR UPDATE' : '';
export const isCloudMedia = path => typeof path === 'string' && path.startsWith(PREFIX);

export function cloudMediaPath(path) {
  const key = isCloudMedia(path) ? path.slice(PREFIX.length) : path;
  if (!PATH.test(key)) throw new MediaError(404, 'Media not found.');
  return key;
}

export function cloudLimits(env = process.env) {
  const integer = (name, fallback, max) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be a positive integer within the preview limit.`);
    return value;
  };
  return {
    dailyUploads: integer('MEDIA_DAILY_UPLOAD_LIMIT', 20, 100),
    monthlyUploads: integer('MEDIA_MONTHLY_UPLOAD_LIMIT', 200, 1000),
    storageBytes: integer('MEDIA_STORAGE_LIMIT_BYTES', 1024 ** 3, 5 * 1024 ** 3),
  };
}

export async function createCloudMedia(db, { token, limits = cloudLimits(), sdk = blobSdk, generateToken = generateClientTokenFromReadWriteToken, normalize = processMediaFile, clock = Date.now }) {
  if (!token) throw new Error('Private Blob storage credentials are required.');
  await db.transaction(async tx => {
    if (db.kind === 'postgres') await tx.prepare('SELECT pg_advisory_xact_lock(194092402)').get();
    await tx.exec(`CREATE TABLE IF NOT EXISTS media_uploads (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL,
      pathname TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL, max_bytes INTEGER NOT NULL,
      state TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      raw_deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS cloud_budget (id TEXT PRIMARY KEY, uploads INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS media_uploads_cleanup ON media_uploads(created_at,raw_deleted);`);
    await tx.prepare('INSERT INTO cloud_budget (id,uploads) VALUES (?,0) ON CONFLICT(id) DO NOTHING').run('storage');
  });
  const result = row => ({ id: row.id, url: `/media/${row.id}`, duration: row.duration, width: row.width, height: row.height });
  const getMedia = id => db.prepare('SELECT * FROM media WHERE id=?').get(id);

  async function reserve(user, body) {
    const target = mediaType(body.role);
    const contentType = String(body.contentType || '').split(';')[0].trim().toLowerCase();
    const allowed = target.kind === 'video' ? ['video/webm', 'video/mp4'] : ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav'];
    if (!allowed.includes(contentType)) throw new MediaError(415, 'Use a supported video or audio recording.');
    const size = Number(body.size);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MEDIA_BYTES) throw new MediaError(413, 'Recordings must be between 1 byte and 30 MB.');
    const at = clock();
    const id = `media_${randomUUID().replaceAll('-', '')}`;
    const pathname = `drafts/${id}.upload`;
    await db.transaction(async tx => {
      await tx.prepare(`SELECT id FROM cloud_budget WHERE id=?${lock(db)}`).get('storage');
      for (const [key, maximum] of [[`day:${iso(at).slice(0,10)}`, limits.dailyUploads], [`month:${iso(at).slice(0,7)}`, limits.monthlyUploads]]) {
        await tx.prepare('INSERT INTO cloud_budget (id,uploads) VALUES (?,0) ON CONFLICT(id) DO NOTHING').run(key);
        const entry = await tx.prepare('SELECT uploads FROM cloud_budget WHERE id=?').get(key);
        if (Number(entry.uploads) >= maximum) throw new MediaError(429, 'This preview has reached its recording capacity. Your written take is safe; please try again later.');
        await tx.prepare('UPDATE cloud_budget SET uploads=uploads+1 WHERE id=?').run(key);
      }
      const stored = await tx.prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM media').get();
      const drafts = await tx.prepare('SELECT COALESCE(SUM(max_bytes),0) AS total FROM media_uploads WHERE raw_deleted=0').get();
      const pending = await tx.prepare("SELECT COUNT(*) AS total FROM media_uploads WHERE state IN ('pending','processing')").get();
      if (Number(stored.total) + Number(drafts.total) + Number(pending.total) * MAX_OUTPUT_BYTES + size + MAX_OUTPUT_BYTES > limits.storageBytes) {
        throw new MediaError(429, 'This preview has reached its recording storage capacity. Your written take is safe.');
      }
      await tx.prepare(`INSERT INTO media_uploads (id,owner_id,role,pathname,content_type,max_bytes,state,created_at,expires_at,raw_deleted)
        VALUES (?,?,?,?,?,?,'pending',?,?,0)`).run(id, user.id, body.role, pathname, contentType, size, iso(at), iso(at + TOKEN_TTL));
    });
    let clientToken;
    try {
      clientToken = await generateToken({ token, pathname, maximumSizeInBytes: size, allowedContentTypes: [contentType], validUntil: at + TOKEN_TTL, allowOverwrite: false, addRandomSuffix: false, cacheControlMaxAge: 0 });
    } catch {
      await db.prepare("UPDATE media_uploads SET state='failed' WHERE id=?").run(id);
      throw new MediaError(503, 'Upload preparation failed. Please try again.');
    }
    return { id, pathname, clientToken, contentType, expiresAt: iso(at + TOKEN_TTL) };
  }

  async function download(pathname, destination, maximum) {
    const response = await sdk.get(cloudMediaPath(pathname), { access: 'private', token, useCache: false, abortSignal: AbortSignal.timeout(60_000) });
    if (!response?.stream || Number(response.blob.size) > maximum) throw new MediaError(422, 'The uploaded recording is missing or too large.');
    let received = 0;
    const bounded = new Transform({ transform(chunk, _, callback) {
      received += chunk.length;
      callback(received > maximum ? new MediaError(413, 'The recording is too large.') : null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.stream), bounded, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    return received;
  }

  async function complete(user, id) {
    if (!ID.test(id)) throw new MediaError(404, 'Recording not found.');
    const entry = await db.transaction(async tx => {
      const row = await tx.prepare(`SELECT * FROM media_uploads WHERE id=?${lock(db)}`).get(id);
      if (!row || row.owner_id !== user.id) throw new MediaError(404, 'Recording not found.');
      if (row.state === 'ready') return row;
      if (row.state === 'processing') throw new MediaError(409, 'This recording is still being processed. Please try again shortly.');
      if (row.state !== 'pending' || row.created_at <= iso(clock() - DAY)) throw new MediaError(410, 'This upload expired. Please record it again.');
      await tx.prepare("UPDATE media_uploads SET state='processing' WHERE id=?").run(id);
      return row;
    });
    if (entry.state === 'ready') {
      const media = await getMedia(id);
      if (!media) throw new MediaError(410, 'This recording expired. Please record it again.');
      return result(media);
    }
    const directory = await mkdtemp(join(tmpdir(), 'annotated-media-'));
    const input = join(directory, 'input.upload');
    const target = mediaType(entry.role);
    const output = join(directory, `output${target.extension}`);
    const finalPath = `media/${id}${target.extension}`;
    let persisted = false;
    try {
      const metadata = await sdk.head(entry.pathname, { token });
      if (metadata.pathname !== entry.pathname || metadata.size !== Number(entry.max_bytes) || metadata.contentType.split(';')[0] !== entry.content_type) throw new MediaError(422, 'The recording does not match its upload.');
      if (await download(entry.pathname, input, Number(entry.max_bytes)) !== Number(entry.max_bytes)) throw new MediaError(422, 'The recording upload was incomplete.');
      const normalized = await normalize(entry.role, input, output);
      const actualBytes = (await stat(output)).size;
      if (actualBytes > MAX_OUTPUT_BYTES) throw new MediaError(422, 'The processed recording is too large.');
      await sdk.put(finalPath, createReadStream(output), { access: 'private', token, contentType: target.contentType, addRandomSuffix: false, allowOverwrite: false });
      await db.transaction(async tx => {
        await tx.prepare(`INSERT INTO media (id,owner_id,role,path,content_type,bytes,duration,width,height,hidden,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,0,?)`).run(id, user.id, entry.role, PREFIX + finalPath, target.contentType, actualBytes, normalized.duration, normalized.width, normalized.height, iso(clock()));
        await tx.prepare("UPDATE media_uploads SET state='ready' WHERE id=?").run(id);
      });
      persisted = true;
      return result(await getMedia(id));
    } catch (error) {
      if (!persisted) {
        await sdk.del(finalPath, { token }).catch(() => {});
        await db.prepare("UPDATE media_uploads SET state='failed' WHERE id=?").run(id);
      }
      if (error instanceof MediaError) throw error;
      throw new MediaError(422, 'The recording could not be uploaded or processed. Your written take is safe; please try recording again.');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async function localFile(path, callback) {
    const pathname = cloudMediaPath(path);
    const directory = await mkdtemp(join(tmpdir(), 'annotated-card-'));
    const file = join(directory, 'source.mp4');
    try { await download(pathname, file, MAX_OUTPUT_BYTES); return await callback(file); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }

  async function open(path, range) {
    const response = await sdk.get(cloudMediaPath(path), { access: 'private', token, ...(range ? { headers: { Range: range } } : {}), abortSignal: AbortSignal.timeout(60_000) });
    if (!response?.stream) throw new MediaError(404, 'Media not found.');
    return response;
  }

  async function cleanup() {
    const cutoff = iso(clock() - DAY);
    const summary = { drafts: 0, media: 0, failures: 0 };
    // Token expiry precedes cleanup by almost a day, so a spent token cannot
    // recreate a draft after deletion. Failed deletions retain their retry row.
    const drafts = await db.prepare('SELECT * FROM media_uploads WHERE created_at<=? AND raw_deleted=0 ORDER BY created_at LIMIT 50').all(cutoff);
    for (const entry of drafts) {
      try {
        await sdk.del(cloudMediaPath(entry.pathname), { token });
        // A crashed process can leave a final object without a media row.
        if (!(await getMedia(entry.id))) await sdk.del(`media/${entry.id}${mediaType(entry.role).extension}`, { token });
        await db.prepare("UPDATE media_uploads SET raw_deleted=1,state=CASE WHEN state IN ('pending','processing') THEN 'failed' ELSE state END WHERE id=?").run(entry.id);
        summary.drafts++;
      } catch { summary.failures++; }
    }
    const old = await db.prepare(`SELECT id FROM media m WHERE created_at<=? AND path LIKE 'blob:%'
      AND NOT EXISTS (SELECT 1 FROM annotations a WHERE a.media_id=m.id OR a.voice_media_id=m.id) ORDER BY created_at LIMIT 50`).all(cutoff);
    for (const entry of old) {
      try {
        await db.transaction(async tx => {
          const media = await tx.prepare(`SELECT * FROM media WHERE id=?${lock(db)}`).get(entry.id);
          if (!media || await tx.prepare('SELECT 1 FROM annotations WHERE media_id=? OR voice_media_id=?').get(entry.id, entry.id)) return;
          await sdk.del(cloudMediaPath(media.path), { token });
          await tx.prepare('DELETE FROM media WHERE id=?').run(entry.id);
          summary.media++;
        });
      } catch { summary.failures++; }
    }
    return summary;
  }
  return { reserve, complete, open, localFile, cleanup };
}
