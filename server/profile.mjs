import { createHash } from 'node:crypto';

// Additive tables leave existing users/sources and old INSERT statements intact.
// Only the small re-encoded thumbnail is stored, never the original photo.
export const PROFILE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id), bio TEXT NOT NULL DEFAULT '',
    avatar_base64 TEXT, avatar_version TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS source_metadata (
    source_id TEXT PRIMARY KEY REFERENCES sources(id), publisher TEXT NOT NULL
  );
`;
export const PROFILE_JSON_BYTES = 750 * 1024;
const MAX_PHOTO_BYTES = 512 * 1024;
export class ProfileError extends Error {
  constructor(message) { super(message); this.status = 400; }
}
const invalid = (message = 'Choose a valid JPEG, PNG or WebP photo.') => new ProfileError(message);

export function profileBio(value) {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw invalid('Use plain text for your bio.');
  const bio = value.replace(/\r\n?/gu, '\n').trim();
  if (Array.from(bio).length > 160) throw invalid('Keep your bio to 160 characters.');
  return bio;
}

// Inspect dimensions before handing untrusted bytes to the image decoder.
function dimensions(bytes, type) {
  if (type === 'png' && bytes.length >= 33 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && bytes.toString('ascii', 12, 16) === 'IHDR') return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (type === 'jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
      offset += length;
    }
  }
  if (type === 'webp' && bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      if (bytes[20] & 2) throw invalid('Choose a still photo, not an animation.');
      return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    }
    if (chunk === 'VP8 ' && bytes.subarray(23, 26).toString('hex') === '9d012a') return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
  }
  throw invalid();
}

export async function normalizeProfilePhoto(value) {
  if (typeof value !== 'string' || value.length > PROFILE_JSON_BYTES) throw invalid('The prepared photo is too large. Choose it again.');
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw invalid();
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES || bytes.toString('base64') !== match[2]) throw invalid();
  const [width, height] = dimensions(bytes, match[1]);
  if (width < 1 || height < 1 || width > 2048 || height > 2048) throw invalid('Resize the photo before saving.');
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const photo = await loadImage(bytes);
    if (photo.width !== width || photo.height !== height) throw invalid();
    const canvas = createCanvas(256, 256);
    const context = canvas.getContext('2d');
    const side = Math.min(width, height);
    context.drawImage(photo, (width - side) / 2, (height - side) / 2, side, side, 0, 0, 256, 256);
    const output = await canvas.encode('webp', 85);
    if (output.length > 64 * 1024) throw invalid('Choose a smaller photo.');
    return { base64: output.toString('base64'), version: createHash('sha256').update(output).digest('hex').slice(0, 24) };
  } catch (error) {
    if (error.status) throw error;
    throw invalid();
  }
}
