import { lstatSync, opendirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const DRAFT_MEDIA_TTL_MS = 24 * 60 * 60 * 1000;
export const MEDIA_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const BATCH_SIZE = 100;
const MEDIA_FILE = /^media_[a-f0-9]{32}\.(?:mp4|m4a)$/;
const TEMP_FILE = /^media_[a-f0-9]{32}\.(?:upload|mp4|m4a)$/;

// Single-instance SQLite service: no await between checking references, unlinking
// and deleting the row, so publication cannot interleave with this operation.
export function sweepAbandonedMedia(db, dataDir, at = Date.now()) {
  const mediaDir = resolve(dataDir, 'media');
  const cutoff = at - DRAFT_MEDIA_TTL_MS;
  const result = { uploads: 0, orphanFiles: 0, temporaryFiles: 0, failures: 0 };
  // Refuse a substituted directory as well as substituted files.
  if (!lstatSync(mediaDir).isDirectory()) return { ...result, failures: 1 };
  const linked = db.prepare('SELECT 1 FROM annotations WHERE media_id=? OR voice_media_id=?');
  const rows = db.prepare(`SELECT id,path FROM media m WHERE created_at <= ?
    AND NOT EXISTS (SELECT 1 FROM annotations a WHERE a.media_id=m.id OR a.voice_media_id=m.id)
    ORDER BY created_at,id LIMIT ?`).all(new Date(cutoff).toISOString(), BATCH_SIZE);
  const removeRow = db.prepare('DELETE FROM media WHERE id=?');
  for (const media of rows) {
    const file = resolve(media.path);
    // Only generated direct children of our media directory may be deleted.
    if (dirname(file) !== mediaDir || !MEDIA_FILE.test(basename(file)) || !basename(file).startsWith(`${media.id}.`)) {
      result.failures += 1;
      continue;
    }
    try {
      if (linked.get(media.id, media.id)) continue;
      try {
        if (!lstatSync(file).isFile()) { result.failures += 1; continue; }
        unlinkSync(file);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      removeRow.run(media.id);
      result.uploads += 1;
    } catch { result.failures += 1; }
  }

  // A crash after normalization/rename can leave files without a database row.
  // Recent files and every row-backed file are preserved. Never recurse or follow
  // symlinks; normal uploads finish within minutes, far inside the 24-hour grace.
  const knownMedia = db.prepare('SELECT 1 FROM media WHERE id=? OR path=?');
  for (const [directory, pattern, countKey] of [
    [mediaDir, MEDIA_FILE, 'orphanFiles'],
    [resolve(dataDir, 'tmp'), TEMP_FILE, 'temporaryFiles'],
  ]) {
    let directoryHandle;
    try {
      if (!lstatSync(directory).isDirectory()) { result.failures += 1; continue; }
      directoryHandle = opendirSync(directory);
      let entry;
      let attempts = 0;
      while (attempts < BATCH_SIZE && (entry = directoryHandle.readSync())) {
        if (!entry.isFile() || !pattern.test(entry.name)) continue;
        const file = join(directory, entry.name);
        const mediaId = entry.name.slice(0, entry.name.lastIndexOf('.'));
        if (directory === mediaDir && knownMedia.get(mediaId, file)) continue;
        try {
          const details = lstatSync(file);
          if (!details.isFile() || details.mtimeMs > cutoff) continue;
          attempts += 1;
          unlinkSync(file);
          result[countKey] += 1;
        } catch (error) {
          attempts += 1;
          if (error.code !== 'ENOENT') result.failures += 1;
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') result.failures += 1; }
    finally { directoryHandle?.closeSync(); }
  }
  return result;
}
