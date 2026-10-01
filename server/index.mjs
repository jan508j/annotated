import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, createReadStream, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { createPostgresDatabase } from './database.mjs';
import { inflateRawSync } from 'node:zlib';
import { OAuth2Client } from 'google-auth-library';
import { createXProvider } from './x-auth.mjs';
import { canonicalSource, sourceKey } from '../shared/source.mjs';
import { cleanPublisher } from '../shared/source-identity.mjs';
import { validateHighlights, joinedHighlights, storedHighlights } from '../shared/highlights.mjs';
import { renderShareCard, ShareCardBusyError, SHARE_CARD_SIZE } from './share-card.mjs';
import { MEDIA_CLEANUP_INTERVAL_MS, sweepAbandonedMedia } from './media-retention.mjs';
import { createCloudMedia, isCloudMedia, cloudLimits } from './cloud-media.mjs';
import { MediaError, processMediaFile } from './media-processing.mjs';
import { fetchSourcePreview } from './source-preview.mjs';
import { PROFILE_SCHEMA, PROFILE_JSON_BYTES, ProfileError, profileBio, normalizeProfilePhoto } from './profile.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATA_DIR = join(ROOT, '.data');
const MAX_JSON_BYTES = 128 * 1024;
const MAX_MEDIA_BYTES = 30 * 1024 * 1024;
const MAX_MEDIA_SECONDS = 90;
// WebM/Opus commonly reports one final encoded packet beyond the requested stop
// time. Accept only that container-scale variance, then publish a strict <=90s file.
const OAUTH_TTL_MS = 10 * 60 * 1000;
const EXTENSION_GRANT_TTL_MS = 2 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCAL_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

const USERS = Object.freeze({
  mira: { id: 'demo-mira', name: 'Mira (local demo)', handle: 'mira-local', color: '#7357ff', isDemo: true, isAdmin: true },
  leo: { id: 'demo-leo', name: 'Leo (local demo)', handle: 'leo-local', color: '#ef7258', isDemo: true, isAdmin: false },
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function now() { return new Date().toISOString(); }
function future(milliseconds) { return new Date(Date.now() + milliseconds).toISOString(); }
function id(prefix) { return `${prefix}_${randomUUID().replaceAll('-', '')}`; }
function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
function pkceChallenge(verifier) { return createHash('sha256').update(verifier).digest('base64url'); }
function randomToken(bytes = 32) { return randomBytes(bytes).toString('base64url'); }
function equalText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function listSetting(value, label, validate) {
  if (value == null || value.trim() === '') return [];
  const values = [...new Set(value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (values.some((item) => !validate(item))) throw new Error(`${label} contains an invalid entry.`);
  return values;
}
function isLoopbackName(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}
function isPrivateHostname(hostname) {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isLoopbackName(hostname) || value === '0.0.0.0' || value.endsWith('.localhost') || value.endsWith('.local')) return true;
  if (/^10\./.test(value) || /^192\.168\./.test(value) || /^169\.254\./.test(value)) return true;
  const private172 = /^172\.(\d+)\./.exec(value);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return true;
  return value === '::' || value === '::1' || /^(?:fc|fd|fe8|fe9|fea|feb)/.test(value);
}

export function loadConfig(env = process.env, overrides = {}) {
  const requestedMode = overrides.mode ?? env.APP_MODE;
  if (requestedMode != null && !['local', 'production'].includes(requestedMode)) throw new Error('APP_MODE must be local or production.');
  if (env.NODE_ENV === 'production' && requestedMode !== 'production') throw new Error('APP_MODE=production is required when NODE_ENV=production.');
  const mode = requestedMode || 'local';
  const defaultBaseUrl = 'http://127.0.0.1:4317';
  let baseUrl;
  try { baseUrl = new URL(overrides.baseUrl ?? env.BASE_URL ?? defaultBaseUrl); }
  catch { throw new Error('BASE_URL must be a valid absolute URL.'); }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== '/') throw new Error('BASE_URL must be an origin without credentials, path, query, or fragment.');
  if (mode === 'production' && baseUrl.protocol !== 'https:') throw new Error('BASE_URL must use HTTPS in production.');
  if (mode === 'local' && !['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('BASE_URL must use HTTP or HTTPS.');
  if (mode === 'production' && (isPrivateHostname(baseUrl.hostname) || !baseUrl.hostname.includes('.'))) throw new Error('BASE_URL must use a public hostname in production.');
  if (mode === 'local' && !isLoopbackName(baseUrl.hostname)) throw new Error('BASE_URL must use a loopback hostname in local mode.');
  const legacyValue = overrides.legacyBaseUrl ?? env.LEGACY_BASE_URL ?? '';
  let legacyBaseUrl = null;
  if (legacyValue) {
    try { legacyBaseUrl = new URL(legacyValue); }
    catch { throw new Error('LEGACY_BASE_URL must be a public HTTPS origin.'); }
    if (mode !== 'production' || legacyBaseUrl.protocol !== 'https:' || legacyBaseUrl.username || legacyBaseUrl.password || legacyBaseUrl.pathname !== '/' || legacyBaseUrl.search || legacyBaseUrl.hash || isPrivateHostname(legacyBaseUrl.hostname) || !legacyBaseUrl.hostname.includes('.') || legacyBaseUrl.origin === baseUrl.origin) {
      throw new Error('LEGACY_BASE_URL must be a distinct public HTTPS origin in production.');
    }
  }
  const portText = String(overrides.port ?? env.PORT ?? '4317');
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  const host = overrides.host ?? env.HOST ?? '127.0.0.1';
  if (typeof host !== 'string' || !host || /[\s/]/.test(host)) throw new Error('HOST must be a valid listen address.');
  if (mode === 'local' && !isLoopbackName(host)) throw new Error('HOST must use a loopback address in local mode.');
  const googleClientId = overrides.googleClientId ?? env.GOOGLE_CLIENT_ID ?? '';
  const googleClientSecret = overrides.googleClientSecret ?? env.GOOGLE_CLIENT_SECRET ?? '';
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together.');
  const xClientId = overrides.xClientId ?? env.X_CLIENT_ID ?? '';
  const xClientSecret = overrides.xClientSecret ?? env.X_CLIENT_SECRET ?? '';
  if (Boolean(xClientId) !== Boolean(xClientSecret)) throw new Error('X_CLIENT_ID and X_CLIENT_SECRET must be configured together.');
  const extensionIds = overrides.extensionIds ?? listSetting(env.EXTENSION_IDS || '', 'EXTENSION_IDS', (value) => EXTENSION_ID_PATTERN.test(value));
  const adminEmails = overrides.adminEmails ?? listSetting(env.ADMIN_EMAILS || '', 'ADMIN_EMAILS', (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  const adminDisplayName = overrides.adminDisplayName ?? env.ADMIN_DISPLAY_NAME ?? '';
  if (typeof adminDisplayName !== 'string' || adminDisplayName.length > 200 || /[\r\n]/.test(adminDisplayName)) throw new Error('ADMIN_DISPLAY_NAME must be a single line of at most 200 characters.');
  const databaseUrl = overrides.databaseUrl ?? env.DATABASE_URL ?? '';
  const mediaStorage = overrides.mediaStorage ?? env.MEDIA_STORAGE ?? 'disk';
  if (!['disk', 'blob'].includes(mediaStorage)) throw new Error('MEDIA_STORAGE must be disk or blob.');
  const blobToken = overrides.blobToken ?? env.BLOB_READ_WRITE_TOKEN ?? '';
  const cronSecret = overrides.cronSecret ?? env.CRON_SECRET ?? '';
  const supportEmail = overrides.supportEmail ?? env.SUPPORT_EMAIL ?? '';
  if (supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) throw new Error('SUPPORT_EMAIL must be an email address.');
  if (mediaStorage === 'blob' && !blobToken) throw new Error('Private Blob storage credentials are required.');
  if (mediaStorage === 'blob' && mode === 'production' && cronSecret.length < 32) throw new Error('CRON_SECRET must contain at least 32 characters.');
  if (env.VERCEL && (mode !== 'production' || !databaseUrl || mediaStorage !== 'blob')) throw new Error('Vercel requires production mode, Postgres and private Blob storage.');
  if (typeof databaseUrl !== 'string') throw new Error('DATABASE_URL must be a PostgreSQL URL.');
  if (databaseUrl) {
    try {
      const parsed = new URL(databaseUrl);
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.hash) throw new Error();
    } catch { throw new Error('DATABASE_URL must be a PostgreSQL URL.'); }
  }
  if (!Array.isArray(extensionIds) || extensionIds.some((value) => !EXTENSION_ID_PATTERN.test(value))) throw new Error('EXTENSION_IDS contains an invalid entry.');
  if (!Array.isArray(adminEmails) || adminEmails.some((value) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) throw new Error('ADMIN_EMAILS contains an invalid entry.');
  const dataDirValue = overrides.dataDir ?? env.DATA_DIR;
  if (mode === 'production' && !dataDirValue) throw new Error('DATA_DIR is required in production.');
  if (mode === 'production' && (!googleClientId || !googleClientSecret)) throw new Error('Google OAuth credentials are required in production.');
  if (mode === 'production' && extensionIds.length === 0) throw new Error('EXTENSION_IDS must contain at least one extension ID in production.');
  if (mode === 'production' && adminEmails.length === 0) throw new Error('ADMIN_EMAILS must contain at least one verified administrator email in production.');
  return Object.freeze({
    mode,
    baseUrl: baseUrl.origin,
    legacyBaseUrl: legacyBaseUrl?.origin || null,
    host,
    port,
    dataDir: resolve(dataDirValue || DEFAULT_DATA_DIR),
    googleClientId,
    googleClientSecret,
    xClientId, xClientSecret,
    extensionIds: Object.freeze(extensionIds.map((value) => value.toLowerCase())),
    adminEmails: Object.freeze(adminEmails.map((value) => value.toLowerCase())),
    adminDisplayName: adminDisplayName.trim(),
    databaseUrl,
    mediaStorage, blobToken, cronSecret, supportEmail,
    mediaLimits: cloudLimits(env),
  });
}
function oneLine(value, max) {
  if (typeof value !== 'string') throw new HttpError(400, 'A required text field is missing.');
  const text = value.trim();
  if (!text || text.length > max || /[\r\n]/.test(text)) throw new HttpError(400, `Use 1–${max} characters without line breaks.`);
  return text;
}
function textValue(value, max, { required = false } = {}) {
  if (value == null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, 'Text fields must be strings.');
  const text = value.trim();
  if ((required && !text) || text.length > max) throw new HttpError(400, `Use ${required ? '1–' : 'at most '}${max} characters.`);
  return text;
}
function isLoopbackHost(hostHeader = '') {
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch { return false; }
}
function trustedOrigin(req, { required = false } = {}) {
  const origin = req.headers.origin;
  if (!origin) return !required;
  const config = req.annotatedConfig;
  const extensionMatch = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  if (extensionMatch) return config?.mode === 'production'
    ? config.extensionIds.includes(extensionMatch[1])
    : isLoopbackHost(req.headers.host);
  try {
    const parsed = new URL(origin);
    if (config?.mode === 'production') return [config.baseUrl, config.legacyBaseUrl].includes(parsed.origin) && parsed.host === req.headers.host;
    return ['http:', 'https:'].includes(parsed.protocol) && isLoopbackHost(parsed.host) && parsed.host === req.headers.host;
  } catch { return false; }
}
function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && trustedOrigin(req)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Media-Role');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  }
}
function json(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}
async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'Request body is too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readJson(req, limit = MAX_JSON_BYTES) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (type !== 'application/json') throw new HttpError(415, 'Use application/json.');
  const raw = await readBody(req, limit);
  try { return JSON.parse(raw.toString('utf8') || '{}'); }
  catch { throw new HttpError(400, 'Request body is not valid JSON.'); }
}
function cookieToken(req) {
  const match = String(req.headers.cookie || '').match(/(?:^|;\s*)annotated_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
function bearerToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}
function wordCount(text) { return (text.match(/\S+/g) || []).length; }
function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new HttpError(400, 'Times must be finite numbers.');
  return parsed;
}
function mediaType(role) {
  if (role === 'source-video') return { extension: '.mp4', contentType: 'video/mp4', kind: 'video' };
  if (role === 'source-audio' || role === 'voice') return { extension: '.m4a', contentType: 'audio/mp4', kind: 'audio' };
  throw new HttpError(400, 'X-Media-Role must be source-video, source-audio, or voice.');
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function initialize(db, config) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT NOT NULL UNIQUE, color TEXT NOT NULL,
      is_demo INTEGER NOT NULL, is_admin INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, url TEXT NOT NULL, title TEXT NOT NULL,
      kind TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, path TEXT NOT NULL,
      content_type TEXT NOT NULL, bytes INTEGER NOT NULL, duration REAL NOT NULL, width INTEGER, height INTEGER,
      hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES users(id),
      source_id TEXT NOT NULL REFERENCES sources(id), excerpt TEXT NOT NULL, start REAL, end REAL,
      commentary TEXT NOT NULL, media_id TEXT REFERENCES media(id), voice_media_id TEXT REFERENCES media(id),
      is_demo INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, UNIQUE(author_id, client_id)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY, annotation_id TEXT NOT NULL REFERENCES annotations(id), author_id TEXT NOT NULL REFERENCES users(id),
      text TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL REFERENCES users(id), followed_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL, PRIMARY KEY(follower_id, followed_id)
    );
    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY, annotation_id TEXT NOT NULL REFERENCES annotations(id), name TEXT NOT NULL,
      email TEXT NOT NULL, reason TEXT NOT NULL, details TEXT NOT NULL, status TEXT NOT NULL,
      scope TEXT, operator_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, nonce TEXT NOT NULL,
      code_verifier TEXT NOT NULL, flow TEXT NOT NULL, return_to TEXT,
      extension_id TEXT, extension_challenge TEXT, expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS extension_grants (
      code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      extension_id TEXT NOT NULL, code_challenge TEXT NOT NULL, expires_at TEXT NOT NULL
    );
  `);
  db.exec(PROFILE_SCHEMA);
  if (!hasColumn(db, 'users', 'provider_subject')) db.exec('ALTER TABLE users ADD COLUMN provider_subject TEXT');
  if (!hasColumn(db, 'users', 'email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  if (!hasColumn(db, 'sessions', 'expires_at')) db.exec('ALTER TABLE sessions ADD COLUMN expires_at TEXT');
  if (!hasColumn(db, 'annotations', 'excerpts_json')) db.exec('ALTER TABLE annotations ADD COLUMN excerpts_json TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_provider_subject_unique ON users(provider_subject) WHERE provider_subject IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS annotations_media_unique ON annotations(media_id) WHERE media_id IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS annotations_voice_media_unique ON annotations(voice_media_id) WHERE voice_media_id IS NOT NULL');
  db.prepare('UPDATE sessions SET expires_at=? WHERE expires_at IS NULL').run(future(config.mode === 'production' ? SESSION_TTL_MS : LOCAL_SESSION_TTL_MS));
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
  db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(now());
  db.prepare('DELETE FROM extension_grants WHERE expires_at <= ?').run(now());
  if (config.mode === 'local') {
    const insert = db.prepare('INSERT OR IGNORE INTO users (id,name,handle,color,is_demo,is_admin) VALUES (?, ?, ?, ?, ?, ?)');
    for (const user of Object.values(USERS)) insert.run(user.id, user.name, user.handle, user.color, Number(user.isDemo), Number(user.isAdmin));
  } else {
    const contaminated = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE is_demo != 0 OR id IN ('demo-mira','demo-leo')) +
        (SELECT COUNT(*) FROM annotations WHERE is_demo != 0) +
        (SELECT COUNT(*) FROM sources WHERE id LIKE 'source_local_fixture_%' OR url LIKE '%/fixtures/%') AS count
    `).get().count;
    if (contaminated) throw new Error('Production database contains local demo data. Use a clean production DATA_DIR.');
    db.prepare('UPDATE users SET is_admin=0').run();
    const grantAdmin = db.prepare('UPDATE users SET is_admin=1 WHERE lower(email)=? AND is_demo=0');
    for (const email of config.adminEmails) grantAdmin.run(email);
  }
}

async function initializePostgres(db, config) {
  await db.transaction(async () => {
    await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
    await db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(now());
    await db.prepare('DELETE FROM extension_grants WHERE expires_at <= ?').run(now());
    if (config.mode === 'local') {
      const insert = db.prepare('INSERT OR IGNORE INTO users (id,name,handle,color,is_demo,is_admin) VALUES (?, ?, ?, ?, ?, ?)');
      for (const user of Object.values(USERS)) await insert.run(user.id, user.name, user.handle, user.color, Number(user.isDemo), Number(user.isAdmin));
    } else {
      const contaminated = await db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM users WHERE is_demo != 0 OR id IN ('demo-mira','demo-leo')) +
          (SELECT COUNT(*) FROM annotations WHERE is_demo != 0) +
          (SELECT COUNT(*) FROM sources WHERE id LIKE 'source_local_fixture_%' OR url LIKE '%/fixtures/%') AS count
      `).get();
      if (Number(contaminated.count)) throw new Error('Production database contains local demo data. Use a clean production database.');
      await db.prepare('UPDATE users SET is_admin=0').run();
      const grantAdmin = db.prepare('UPDATE users SET is_admin=1 WHERE lower(email)=? AND is_demo=0');
      for (const email of config.adminEmails) await grantAdmin.run(email);
    }
  });
}

function userObject(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, handle: row.handle, color: row.color, isDemo: Boolean(row.is_demo), isAdmin: Boolean(row.is_admin),
    bio: row.bio || '', avatarUrl: row.avatar_version ? `/api/users/${encodeURIComponent(row.id)}/avatar?v=${row.avatar_version}` : null };
}
function sourceObject(row) {
  return { id: row.source_id ?? row.id, key: row.source_key, url: row.url, title: row.title, kind: row.kind, author: row.source_author ?? row.author, publisher: row.publisher || '' };
}
function annotationObject(row) {
  return {
    id: row.id,
    source: sourceObject(row),
    author: userObject({ id: row.author_id, name: row.user_name, handle: row.handle, color: row.color, is_demo: row.user_is_demo, is_admin: row.is_admin, bio: row.bio, avatar_version: row.avatar_version }),
    excerpt: row.excerpt,
    excerpts: storedHighlights(row),
    start: row.start,
    end: row.end,
    commentary: row.commentary,
    mediaUrl: row.media_id ? `/media/${row.media_id}` : null,
    voiceUrl: row.voice_media_id ? `/media/${row.voice_media_id}` : null,
    createdAt: row.created_at,
    commentCount: Number(row.comment_count || 0),
    isDemo: Boolean(row.is_demo),
  };
}
const ANNOTATION_SELECT = `
  SELECT a.*, s.id AS source_id, s.source_key, s.url, s.title, s.kind, s.author AS source_author,
    u.name AS user_name, u.handle, u.color, u.is_demo AS user_is_demo, u.is_admin, p.bio, p.avatar_version, sm.publisher,
    (SELECT COUNT(*) FROM comments c WHERE c.annotation_id = a.id AND c.deleted = 0) AS comment_count
  FROM annotations a JOIN sources s ON s.id = a.source_id JOIN users u ON u.id = a.author_id
  LEFT JOIN user_profiles p ON p.user_id = u.id LEFT JOIN source_metadata sm ON sm.source_id = s.id
`;

function safeLimit(url) {
  const value = Number(url.searchParams.get('limit') || 50);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 100) : 50;
}
function feedCursor(value) {
  if (value === null) return null;
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof cursor?.createdAt !== 'string' || new Date(cursor.createdAt).toISOString() !== cursor.createdAt
      || typeof cursor.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(cursor.id)) throw new Error();
    return cursor;
  } catch { throw new HttpError(400, 'Invalid feed cursor. Reload the feed and try again.'); }
}
async function getAnnotation(db, annotationId, { includeHidden = false } = {}) {
  return (await db.prepare(`${ANNOTATION_SELECT} WHERE a.id = ? ${includeHidden ? '' : 'AND a.hidden = 0 AND a.deleted = 0'}`).get(annotationId));
}
async function authenticate(db, req, { required = true } = {}) {
  const bearer = bearerToken(req);
  const cookie = cookieToken(req);
  const token = bearer || cookie;
  if (!token) {
    if (required) throw new HttpError(401, req.annotatedConfig?.mode === 'production' ? 'Sign in to continue.' : 'Sign in with a local demo session first.');
    return null;
  }
  const cookieMutation = cookie && !bearer && !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (cookie && !bearer && !trustedOrigin(req, { required: cookieMutation })) throw new HttpError(403, 'This request origin is not allowed.');
  const hash = tokenHash(token);
  const row = (await db.prepare(`SELECT u.*, p.bio, p.avatar_version FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN user_profiles p ON p.user_id=u.id WHERE s.token_hash = ? AND s.expires_at > ?`).get(hash, now()));
  if (!row) {
    (await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash));
    if (required) throw new HttpError(401, 'The session is invalid or expired.');
    return null;
  }
  if (req.annotatedConfig?.mode === 'production') {
    const isAdmin = Number(Boolean(row.email) && req.annotatedConfig.adminEmails.includes(String(row.email).toLowerCase()));
    if (row.is_admin !== isAdmin) (await db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(isAdmin, row.id));
    row.is_admin = isAdmin;
  }
  return userObject(row);
}
async function requireAdmin(db, req) {
  const user = await authenticate(db, req);
  if (!user.isAdmin) throw new HttpError(403, 'Operator access is required.');
  return user;
}
function assertMutationOrigin(db, req) {
  if (cookieToken(req) && !bearerToken(req) && !trustedOrigin(req, { required: true })) throw new HttpError(403, 'This request origin is not allowed.');
}

async function seedDatabase(db, baseUrl) {
  const count = (await db.prepare('SELECT COUNT(*) AS count FROM annotations').get()).count;
  if (count) return;
  const rawUrl = `${baseUrl.replace(/\/$/, '')}/fixtures/article.html`;
  const canonical = canonicalSource(rawUrl);
  const key = await sourceKey(rawUrl);
  const created = now();
  const sourceId = 'source_local_fixture_article';
  (await db.prepare('INSERT OR IGNORE INTO sources VALUES (?, ?, ?, ?, ?, ?, ?)').run(sourceId, key, canonical.url, 'The smaller team is only half the story.', 'article', 'Annotated fixture', created));
  const insert = db.prepare(`INSERT OR IGNORE INTO annotations
    (id,client_id,author_id,source_id,excerpt,start,end,commentary,media_id,voice_media_id,is_demo,hidden,deleted,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  await insert.run('annotation_demo_context', 'seed-context', USERS.mira.id, sourceId,
    'A smaller team can build the product. It still has to build the trust.', null, null,
    'The source and the response stay distinct, so a reader can inspect the evidence before judging this demo take.', null, null, 1, 0, 0, created);
  await insert.run('annotation_demo_reply', 'seed-reply', USERS.leo.id, sourceId,
    'A smaller team can build the product. It still has to build the trust.', null, null,
    'I also want the source link close at hand. That makes disagreement easier to resolve.', null, null, 1, 0, 0, new Date(Date.now() + 1000).toISOString());
  (await db.prepare('INSERT OR IGNORE INTO comments VALUES (?, ?, ?, ?, ?, ?)').run('comment_demo_response', 'annotation_demo_context', USERS.leo.id, 'This is a local demo response, included to exercise the conversation UI.', 0, new Date(Date.now() + 2000).toISOString()));
}

function mime(path) {
  if (extname(path).toLowerCase() === '.ttf') return 'font/ttf';
  if (extname(path).toLowerCase() === '.webmanifest') return 'application/manifest+json';
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webm': 'video/webm', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.zip': 'application/zip' })[extname(path).toLowerCase()] || 'application/octet-stream';
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function previewText(value, max = 240) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join('').trimEnd()}…`;
}
function shellHtml(indexPath, baseUrl, metadata) {
  const imageUrl = escapeHtml(new URL('/web/logo/logo-512.png', baseUrl).href);
  return readFileSync(indexPath, 'utf8').replace('<!-- social-preview -->', metadata ?? [
    '<meta property="og:title" content="Annotated">',
    `<meta property="og:image" content="${imageUrl}">`,
    '<meta property="og:image:type" content="image/png">',
    '<meta property="og:image:width" content="512">',
    '<meta property="og:image:height" content="512">',
    '<meta property="og:image:alt" content="Annotated — The point logo">',
    '<meta name="twitter:card" content="summary">',
    `<meta name="twitter:image" content="${imageUrl}">`,
  ].join('\n  '));
}
function receiptHtml(indexPath, annotation, baseUrl) {
  const sourceLabel = annotation.source_author ? `${annotation.title} by ${annotation.source_author}` : annotation.title;
  const title = previewText(`${annotation.title} — Annotated`, 120);
  const description = previewText(annotation.commentary
    ? `${annotation.commentary} — Annotation on ${sourceLabel}.`
    : `Voice commentary by ${annotation.user_name} on ${sourceLabel}.`);
  const canonicalUrl = new URL(`/a/${encodeURIComponent(annotation.id)}`, baseUrl).href;
  const imageUrl = new URL(`/api/annotations/${encodeURIComponent(annotation.id)}/share-card.png`, baseUrl).href;
  const imageAlt = previewText(`Annotation by ${annotation.user_name} on ${annotation.title}.`, 180);
  const metadata = [
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}">`,
    `<meta property="og:image" content="${escapeHtml(imageUrl)}">`,
    '<meta property="og:image:type" content="image/png">',
    `<meta property="og:image:width" content="${SHARE_CARD_SIZE.width}">`,
    `<meta property="og:image:height" content="${SHARE_CARD_SIZE.height}">`,
    `<meta property="og:image:alt" content="${escapeHtml(imageAlt)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:image" content="${escapeHtml(imageUrl)}">`,
    `<meta name="twitter:image:alt" content="${escapeHtml(imageAlt)}">`,
  ].join('\n  ');
  return shellHtml(indexPath, baseUrl, metadata)
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`)
    .replace(/<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i, `<meta name="description" content="${escapeHtml(description)}">`);
}
function sendHtml(req, res, html, status = 200) {
  const data = Buffer.from(html);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') return res.end();
  res.end(data);
}
function serveFile(req, res, path, { cache = false } = {}) {
  if (!existsSync(path) || !statSync(path).isFile()) return false;
  const stat = statSync(path);
  res.writeHead(200, { 'Content-Type': mime(path), 'Content-Length': stat.size, 'Cache-Control': cache ? 'public, max-age=3600' : 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(path).pipe(res);
  return true;
}
function safeStatic(root, pathname) {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
  const target = resolve(root, relative);
  return target === root || target.startsWith(`${root}/`) ? target : null;
}

function readZipEntry(path, wantedName) {
  const zip = readFileSync(path);
  let eocd = -1;
  for (let offset = Math.max(0, zip.length - 65_557); offset <= zip.length - 22; offset += 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) eocd = offset;
  }
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const fileNameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const fileName = zip.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    if (fileName === wantedName) {
      if (zip.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return null;
}

function matchingProductionExtension(config) {
  if (config.mode !== 'production') return null;
  const path = join(ROOT, 'artifacts', 'production-extension.zip');
  if (!existsSync(path)) return null;
  try {
    const source = readZipEntry(path, 'config.mjs')?.toString('utf8') || '';
    const manifest = JSON.parse(readZipEntry(path, 'manifest.json')?.toString('utf8') || 'null');
    const configJson = /Object\.freeze\(\s*(\{[\s\S]*?\})\s*\)/.exec(source)?.[1];
    const packaged = configJson ? JSON.parse(configJson) : null;
    const hostPermissions = Array.isArray(manifest?.host_permissions) ? manifest.host_permissions : [];
    const keyBytes = typeof manifest?.key === 'string' ? Buffer.from(manifest.key, 'base64') : Buffer.alloc(0);
    const extensionId = keyBytes.length
      ? createHash('sha256').update(keyBytes).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
      : null;
    const expectedHosts = [`${config.baseUrl}/*`, ...(config.mediaStorage === 'blob' ? ['https://vercel.com/*'] : [])];
    if (packaged?.mode !== 'production' || packaged?.apiOrigin !== config.baseUrl || (packaged.mediaStorage || 'disk') !== config.mediaStorage || hostPermissions.length !== expectedHosts.length || expectedHosts.some(host => !hostPermissions.includes(host)) || !manifest.permissions?.includes('identity') || !extensionId || !config.extensionIds.includes(extensionId)) return null;
    return path;
  } catch { return null; }
}

function sessionCookie(token, config, maxAgeSeconds) {
  const secure = config.mode === 'production' ? '; Secure' : '';
  return `annotated_session=${encodeURIComponent(token)}; HttpOnly; SameSite=${config.mode === 'production' ? 'Lax' : 'Strict'}; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}
function oauthCookie(token, config, maxAgeSeconds, provider = 'google') {
  const secure = config.mode === 'production' ? '; Secure' : '';
  return `annotated_oauth=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/auth/${provider}; Max-Age=${maxAgeSeconds}${secure}`;
}
function oauthCookieToken(req) {
  const match = String(req.headers.cookie || '').match(/(?:^|;\s*)annotated_oauth=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
function safeReturnTo(value, config) {
  if (value == null || value === '') return '/';
  if (typeof value !== 'string' || value.length > 2000 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) throw new HttpError(400, 'returnTo must be a local path.');
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw new HttpError(400, 'returnTo must be a local path.'); }
  if (/[\\\u0000-\u001f\u007f]/.test(decoded)) throw new HttpError(400, 'returnTo must be a local path.');
  const target = new URL(value, config.baseUrl);
  if (target.origin !== config.baseUrl) throw new HttpError(400, 'returnTo must be a local path.');
  return `${target.pathname}${target.search}${target.hash}`;
}

function createGoogleProvider(config) {
  const redirectUri = `${config.baseUrl}/auth/google/callback`;
  const client = new OAuth2Client(config.googleClientId, config.googleClientSecret, redirectUri);
  return {
    authorizationUrl({ state, nonce, codeChallenge }) {
      return client.generateAuthUrl({
        access_type: 'online',
        scope: ['openid', 'email', 'profile'],
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
    },
    async authenticate({ code, codeVerifier, nonce }) {
      const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
      if (!tokens.id_token) throw new Error('Google did not return an ID token.');
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.googleClientId });
      const payload = ticket.getPayload();
      if (!payload || !equalText(payload.nonce || '', nonce)) throw new Error('Google ID token nonce did not match.');
      return { subject: payload.sub, email: payload.email, emailVerified: payload.email_verified === true, name: payload.name || 'Member', nonce: payload.nonce };
    },
  };
}

async function oauthUser(db, claims, config) {
  if (typeof claims?.subject !== 'string' || !claims.subject || typeof claims.email !== 'string' || !claims.email || claims.emailVerified !== true) {
    throw new HttpError(403, 'Google must provide a verified email address.');
  }
  const email = claims.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(403, 'Google must provide a verified email address.');
  const subject = claims.subject;
  const existing = (await db.prepare('SELECT * FROM users WHERE provider_subject=?').get(subject));
  const isAdmin = Number(config.adminEmails.includes(email));
  const suppliedName = String(claims.name || '').trim().slice(0, 200);
  const displayName = isAdmin && config.adminDisplayName
    ? config.adminDisplayName
    : (!suppliedName || suppliedName.toLowerCase() === email ? 'Member' : suppliedName);
  if (existing) {
    (await db.prepare('UPDATE users SET name=?, email=?, is_admin=? WHERE id=?').run(displayName, email, isAdmin, existing.id));
    return userObject((await db.prepare('SELECT u.*,p.bio,p.avatar_version FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id=?').get(existing.id)));
  }
  const digest = tokenHash(`google:${subject}`);
  const userId = `google-${digest.slice(0, 32)}`;
  const handleBase = (displayName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'member');
  const handle = `${handleBase}-${digest.slice(0, 8)}`;
  const color = `#${digest.slice(0, 6)}`;
  (await db.prepare(`INSERT INTO users (id,name,handle,color,is_demo,is_admin,provider_subject,email)
    VALUES (?,?,?,?,0,?,?,?) ON CONFLICT (id) DO UPDATE SET name=excluded.name, email=excluded.email, is_admin=excluded.is_admin`).run(userId, displayName, handle, color, isAdmin, subject, email));
  return userObject((await db.prepare('SELECT u.*,p.bio,p.avatar_version FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id=?').get(userId)));
}

async function xOauthUser(db, claims) {
  if (typeof claims?.subject !== 'string' || !/^\d{1,20}$/.test(claims.subject)) throw new HttpError(403, 'X must provide a valid account identifier.');
  const digest = tokenHash(`x:${claims.subject}`);
  const userId = `x-${digest.slice(0, 32)}`;
  const name = String(claims.name || 'Member').trim().slice(0, 200) || 'Member';
  const handleBase = String(claims.username || 'member').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32) || 'member';
  // Never match email or display name to a Google account or operator identity.
  await db.prepare(`INSERT INTO users (id,name,handle,color,is_demo,is_admin,provider_subject,email)
    VALUES (?,?,?,?,0,0,?,NULL) ON CONFLICT (id) DO UPDATE SET name=excluded.name`)
    .run(userId, name, `${handleBase}-${digest.slice(0, 8)}`, `#${digest.slice(0, 6)}`, `x:${claims.subject}`);
  return userObject(await db.prepare('SELECT u.*,p.bio,p.avatar_version FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id=?').get(userId));
}

function oauthStateHash(provider, state) {
  // Keep existing in-flight Google requests compatible, while isolating X state.
  return tokenHash(provider === 'google' ? state : `x:${state}`);
}

async function createSession(db, userId, config) {
  const token = randomToken();
  const ttl = config.mode === 'production' ? SESSION_TTL_MS : LOCAL_SESSION_TTL_MS;
  (await db.prepare('INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(tokenHash(token), userId, now(), future(ttl)));
  return { token, maxAge: Math.floor(ttl / 1000) };
}

export function createServer(options = {}) {
  const config = options.config || loadConfig(options.env || process.env, {
    mode: options.mode,
    baseUrl: options.baseUrl,
    legacyBaseUrl: options.legacyBaseUrl,
    host: options.host,
    port: options.port,
    dataDir: options.dataDir,
    googleClientId: options.googleClientId,
    googleClientSecret: options.googleClientSecret,
    xClientId: options.xClientId,
    xClientSecret: options.xClientSecret,
    extensionIds: options.extensionIds,
    adminEmails: options.adminEmails,
    adminDisplayName: options.adminDisplayName,
    databaseUrl: options.databaseUrl,
    mediaStorage: options.mediaStorage,
    blobToken: options.blobToken,
    cronSecret: options.cronSecret,
    supportEmail: options.supportEmail,
  });
  if (config.mode === 'production' && options.seed === true) throw new Error('Demo seeding is disabled in production.');
  const dataDir = config.dataDir;
  const mediaDir = join(dataDir, 'media');
  const tempDir = join(dataDir, 'tmp');
  mkdirSync(mediaDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  let db;
  if (!config.databaseUrl) {
    const databasePath = options.databasePath || join(dataDir, 'annotated.sqlite');
    db = new DatabaseSync(databasePath);
    try { initialize(db, config); }
    catch (error) { db.close(); throw error; }
    let transactionQueue = Promise.resolve();
    db.transaction = (work) => {
      const task = transactionQueue.then(async () => {
      const tx = new DatabaseSync(databasePath);
      tx.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
      db.transactionActive = true;
      try {
        const result = await work(tx);
        tx.exec('COMMIT');
        return result;
      } catch (error) {
        tx.exec('ROLLBACK');
        throw error;
      } finally { tx.close(); db.transactionActive = false; }
      });
      transactionQueue = task.catch(() => {});
      return task;
    };
  }
  const baseUrl = config.baseUrl;
  const oauthConfigured = Boolean(config.googleClientId && config.googleClientSecret);
  const googleProvider = options.googleProvider || (oauthConfigured ? createGoogleProvider(config) : null);
  const xConfigured = Boolean(config.xClientId && config.xClientSecret);
  const xProvider = options.xProvider || (xConfigured ? createXProvider(config) : null);
  // Old extension clients and OAuth callbacks already in flight keep their
  // original redirect URI. Never derive a provider origin from an arbitrary Host.
  const legacyConfig = config.legacyBaseUrl ? { ...config, baseUrl: config.legacyBaseUrl } : null;
  const legacyGoogleProvider = legacyConfig && oauthConfigured ? options.legacyGoogleProvider || createGoogleProvider(legacyConfig) : null;
  const legacyXProvider = legacyConfig && xConfigured ? options.legacyXProvider || createXProvider(legacyConfig) : null;
  const authProviders = { google: oauthConfigured, x: xConfigured };
  let cloudMedia;
  const databaseReady = config.databaseUrl
    ? (async () => {
      db = await createPostgresDatabase(config.databaseUrl);
      try {
        await initializePostgres(db, config);
        if (config.mode === 'local' && options.seed !== false) await seedDatabase(db, baseUrl);
      } catch (error) {
        await db.close();
        db = null;
        throw error;
      }
    })()
    : (config.mode === 'production' || options.seed === false ? Promise.resolve() : seedDatabase(db, baseUrl));
  const ready = databaseReady.then(async () => {
    if (config.mediaStorage === 'blob') cloudMedia = await createCloudMedia(db, { token: config.blobToken, limits: config.mediaLimits, ...options.cloudMediaOptions });
  });
  void ready.catch(() => {});
  let activeSourcePreviews = 0;
  let activeProfilePhotos = 0;

  const requestHandler = async (req, res) => {
    req.annotatedConfig = config;
    setCors(req, res);
    try {
      await ready;
      const legacyHost = config.legacyBaseUrl && req.headers.host === new URL(config.legacyBaseUrl).host;
      if (config.mode === 'production') {
        if (req.headers.host !== new URL(config.baseUrl).host && !legacyHost) throw new HttpError(403, 'The request host is not accepted.');
      } else if (!isLoopbackHost(req.headers.host)) throw new HttpError(403, 'Only loopback hosts are accepted.');
      const url = new URL(req.url, baseUrl);
      const path = url.pathname;
      if (legacyHost && ['GET', 'HEAD'].includes(req.method)) {
        const webSignIn = /^\/auth\/(google|x)\/start$/.test(path) && !url.searchParams.has('extensionId') && !url.searchParams.has('codeChallenge');
        const pageNavigation = !/^\/(?:api|media|auth|web|shared)(?:\/|$)/.test(path);
        if (webSignIn || pageNavigation) {
          // Temporary, uncached and path-preserving so rollback stays possible.
          // Setting pathname explicitly prevents //host or backslash open redirects.
          const target = new URL(config.baseUrl);
          target.pathname = path;
          target.search = url.search;
          return redirect(res, target.href);
        }
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, mode: config.mode, oauthConfigured });
      if (req.method === 'GET' && path === '/api/session') return json(res, 200, { user: await authenticate(db, req, { required: false }), mode: config.mode, oauthConfigured, authProviders, mediaStorage: config.mediaStorage, supportEmail: config.supportEmail, extensionAvailable: Boolean(config.mode === 'local' ? existsSync(join(ROOT, 'artifacts', 'annotated-extension.zip')) : matchingProductionExtension(config)) });

      if (req.method === 'POST' && path === '/api/source-preview') {
        if (!trustedOrigin(req, { required: true })) throw new HttpError(403, 'Open the editor on Annotated to read a source title.');
        const body = await readJson(req);
        const sourceUrl = oneLine(body.url, 2000);
        if (activeSourcePreviews >= 3) throw new HttpError(429, 'Please try again in a moment, or enter the title yourself.');
        activeSourcePreviews++;
        try {
          return json(res, 200, await (options.sourcePreviewFetcher || fetchSourcePreview)(sourceUrl));
        } catch { throw new HttpError(422, 'Couldn’t read this page’s title. You can enter it yourself.'); }
        finally { activeSourcePreviews--; }
      }

      // OS share delivery only opens an editable draft; it never writes an annotation.
      if (req.method === 'POST' && path === '/share') {
        if (String(req.headers['content-type'] || '').split(';')[0].trim() !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'Share a page link or text.');
        const fields = new URLSearchParams((await readBody(req, 24 * 1024)).toString('utf8'));
        const incoming = new URLSearchParams();
        for (const [key, limit] of [['url', 2000], ['title', 300], ['text', 12000]]) {
          const value = fields.get(key) || '';
          if (value.length > limit) throw new HttpError(413, 'Share a shorter passage or paste it into the editor.');
          if (value) incoming.set(key, value);
        }
        const target = `/write#${incoming}`;
        if (target.length > 16000) throw new HttpError(413, 'Share a shorter passage or paste it into the editor.');
        res.writeHead(303, { Location: target, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        return res.end();
      }

      const oauthRoute = /^\/auth\/(google|x)\/(start|callback)$/.exec(path);
      const provider = oauthRoute?.[1];
      const providerClient = provider === 'x' ? (legacyHost ? legacyXProvider : xProvider) : (legacyHost ? legacyGoogleProvider : googleProvider);
      const providerName = provider === 'x' ? 'X' : 'Google';
      if (req.method === 'GET' && oauthRoute?.[2] === 'start') {
        if (!authProviders[provider] || !providerClient) throw new HttpError(503, `${providerName} sign-in is not configured.`);
        const extensionId = url.searchParams.get('extensionId');
        const suppliedChallenge = url.searchParams.get('codeChallenge');
        const hasExtensionInput = extensionId != null || suppliedChallenge != null;
        let flow;
        let returnTo = null;
        if (hasExtensionInput) {
          if (!extensionId || !EXTENSION_ID_PATTERN.test(extensionId) || !config.extensionIds.includes(extensionId)) throw new HttpError(400, 'This extension is not allowed.');
          if (!suppliedChallenge || !PKCE_CHALLENGE_PATTERN.test(suppliedChallenge)) throw new HttpError(400, 'A valid S256 code challenge is required.');
          if (url.searchParams.has('returnTo')) throw new HttpError(400, 'Extension sign-in cannot include returnTo.');
          flow = 'extension';
        } else {
          flow = 'web';
          returnTo = safeReturnTo(url.searchParams.get('returnTo'), config);
        }
        const state = randomToken();
        const browserToken = randomToken();
        const nonce = randomToken();
        const verifier = randomToken(48);
        (await db.prepare(`INSERT INTO oauth_states
          (state_hash,browser_hash,nonce,code_verifier,flow,return_to,extension_id,extension_challenge,expires_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(oauthStateHash(provider, state), tokenHash(browserToken), nonce, verifier, flow, returnTo, extensionId, suppliedChallenge, future(OAUTH_TTL_MS)));
        const authorizationUrl = providerClient.authorizationUrl({ state, nonce, codeChallenge: pkceChallenge(verifier) });
        return redirect(res, authorizationUrl, { 'Set-Cookie': oauthCookie(browserToken, config, Math.floor(OAUTH_TTL_MS / 1000), provider) });
      }

      if (req.method === 'GET' && oauthRoute?.[2] === 'callback') {
        if (!authProviders[provider] || !providerClient) throw new HttpError(503, `${providerName} sign-in is not configured.`);
        const state = url.searchParams.get('state') || '';
        const browserToken = oauthCookieToken(req) || '';
        if (!state || !browserToken) throw new HttpError(400, 'The sign-in request is invalid or expired.');
        const pending = await db.prepare('DELETE FROM oauth_states WHERE state_hash=? AND browser_hash=? RETURNING *')
          .get(oauthStateHash(provider, state), tokenHash(browserToken));
        if (!pending || pending.expires_at <= now()) throw new HttpError(400, 'The sign-in request is invalid or expired.');
        const clearOauthCookie = oauthCookie('', config, 0, provider);
        res.setHeader('Set-Cookie', clearOauthCookie);
        if (url.searchParams.get('error')) throw new HttpError(400, `${providerName} sign-in was canceled or failed.`);
        const code = url.searchParams.get('code');
        if (!code) throw new HttpError(400, `${providerName} did not return an authorization code.`);
        let claims;
        try { claims = await providerClient.authenticate({ code, codeVerifier: pending.code_verifier, nonce: pending.nonce }); }
        catch { throw new HttpError(401, `${providerName} sign-in could not be verified.`); }
        if (provider === 'google' && !equalText(claims?.nonce || '', pending.nonce)) throw new HttpError(401, 'Google sign-in could not be verified.');
        const user = provider === 'x' ? await xOauthUser(db, claims) : await oauthUser(db, claims, config);
        if (pending.flow === 'extension') {
          const grant = randomToken();
          await db.prepare('INSERT INTO extension_grants (code_hash,user_id,extension_id,code_challenge,expires_at) VALUES (?,?,?,?,?)')
            .run(tokenHash(grant), user.id, pending.extension_id, pending.extension_challenge, future(EXTENSION_GRANT_TTL_MS));
          const target = new URL(`https://${pending.extension_id}.chromiumapp.org/annotated`);
          target.searchParams.set('code', grant);
          return redirect(res, target.href, { 'Set-Cookie': clearOauthCookie });
        }
        const session = await createSession(db, user.id, config);
        return redirect(res, pending.return_to || '/', { 'Set-Cookie': [clearOauthCookie, sessionCookie(session.token, config, session.maxAge)] });
      }

      if (req.method === 'POST' && path === '/api/auth/extension/exchange') {
        const originMatch = /^chrome-extension:\/\/([a-p]{32})$/.exec(String(req.headers.origin || ''));
        if (!originMatch || !config.extensionIds.includes(originMatch[1])) throw new HttpError(403, 'This extension is not allowed.');
        const body = await readJson(req);
        const code = oneLine(body.code, 200);
        const verifier = oneLine(body.codeVerifier, 200);
        if (!PKCE_VERIFIER_PATTERN.test(verifier)) throw new HttpError(400, 'A valid PKCE code verifier is required.');
        const grant = await db.prepare('DELETE FROM extension_grants WHERE code_hash=? RETURNING *').get(tokenHash(code));
        if (!grant) throw new HttpError(401, 'The extension sign-in grant is invalid or expired.');
        if (grant.expires_at <= now() || grant.extension_id !== originMatch[1] || !equalText(pkceChallenge(verifier), grant.code_challenge)) throw new HttpError(401, 'The extension sign-in grant is invalid or expired.');
        const user = userObject((await db.prepare('SELECT u.*,p.bio,p.avatar_version FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id=?').get(grant.user_id)));
        if (!user) throw new HttpError(401, 'The extension sign-in grant is invalid or expired.');
        const session = await createSession(db, user.id, config);
        return json(res, 200, { token: session.token, user });
      }

      if (req.method === 'POST' && path === '/api/dev/session') {
        if (config.mode !== 'local') throw new HttpError(404, 'API route not found.');
        if (!trustedOrigin(req, { required: true })) throw new HttpError(403, 'Local sign-in requires this exact loopback origin or a local development extension.');
        const body = await readJson(req);
        const user = USERS[body.persona];
        if (!user) throw new HttpError(400, 'Choose the mira or leo local demo persona.');
        const session = await createSession(db, user.id, config);
        return json(res, 200, { user, token: session.token }, { 'Set-Cookie': sessionCookie(session.token, config, session.maxAge) });
      }
      if (req.method === 'POST' && path === '/api/logout') {
        assertMutationOrigin(db, req);
        const token = bearerToken(req) || cookieToken(req);
        if (token) (await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token)));
        return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', config, 0) });
      }

      if (req.method === 'GET' && path === '/api/feed') {
        const limit = safeLimit(url);
        const type = url.searchParams.has('format') ? url.searchParams.get('format') : url.searchParams.get('type') || 'all';
        const audience = url.searchParams.has('audience') ? url.searchParams.get('audience')
          : url.searchParams.get('following') === '1' ? 'following' : 'everyone';
        const kinds = { text: 'article', video: 'video', audio: 'audio' };
        if (!['all', 'text', 'video', 'audio'].includes(type)) throw new HttpError(400, 'Source format must be all, text, video or audio.');
        if (!['everyone', 'following'].includes(audience)) throw new HttpError(400, 'Feed audience must be everyone or following.');
        const formatClause = type === 'all' ? '' : ' AND s.kind = ?';
        const parameters = type === 'all' ? [] : [kinds[type]];
        const cursor = feedCursor(url.searchParams.get('cursor'));
        const cursorClause = cursor ? ' AND (a.created_at < ? OR (a.created_at = ? AND a.id < ?))' : '';
        if (cursor) parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
        const user = await authenticate(db, req, { required: audience === 'following' });
        let rows;
        if (audience === 'following') {
          rows = (await db.prepare(`${ANNOTATION_SELECT} JOIN follows f ON f.followed_id = a.author_id AND f.follower_id = ? WHERE a.hidden = 0 AND a.deleted = 0${formatClause}${cursorClause} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`).all(user.id, ...parameters, limit + 1));
        } else {
          rows = (await db.prepare(`${ANNOTATION_SELECT} WHERE a.hidden = 0 AND a.deleted = 0${formatClause}${cursorClause} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`).all(...parameters, limit + 1));
        }
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        const nextCursor = rows.length > limit ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString('base64url') : null;
        // Cards only need Follow/Following, not a separate full profile and its annotations.
        const authorIds = [...new Set(page.map(row => row.author_id))];
        const followed = new Set(user && authorIds.length ? (await db.prepare(`SELECT followed_id FROM follows WHERE follower_id = ? AND followed_id IN (${authorIds.map(() => '?').join(',')})`).all(user.id, ...authorIds)).map(row => row.followed_id) : []);
        return json(res, 200, { annotations: page.map(row => ({ ...annotationObject(row), isFollowing: followed.has(row.author_id) })), nextCursor });
      }

      if (req.method === 'POST' && path === '/api/sources/lookup') {
        const body = await readJson(req);
        const key = oneLine(body.key, 200);
        const source = (await db.prepare('SELECT s.*,sm.publisher FROM sources s LEFT JOIN source_metadata sm ON sm.source_id=s.id WHERE s.source_key = ?').get(key));
        if (!source) return json(res, 200, { source: null, annotations: [] });
        const rows = (await db.prepare(`${ANNOTATION_SELECT} WHERE a.source_id = ? AND a.hidden = 0 AND a.deleted = 0 ORDER BY a.created_at DESC`).all(source.id));
        return json(res, 200, { source: sourceObject(source), annotations: rows.map(annotationObject) });
      }

      let match = path.match(/^\/api\/sources\/([^/]+)$/);
      if (req.method === 'GET' && match) {
        const source = (await db.prepare('SELECT s.*,sm.publisher FROM sources s LEFT JOIN source_metadata sm ON sm.source_id=s.id WHERE s.id = ?').get(decodeURIComponent(match[1])));
        if (!source) throw new HttpError(404, 'Source not found.');
        const rows = (await db.prepare(`${ANNOTATION_SELECT} WHERE a.source_id = ? AND a.hidden = 0 AND a.deleted = 0 ORDER BY a.created_at DESC`).all(source.id));
        return json(res, 200, { source: sourceObject(source), annotations: rows.map(annotationObject) });
      }

      if (req.method === 'GET' && path === '/api/cron/media-cleanup') {
        if (!cloudMedia || !config.cronSecret || !equalText(req.headers.authorization || '', `Bearer ${config.cronSecret}`)) throw new HttpError(404, 'Not found.');
        return json(res, 200, await cloudMedia.cleanup());
      }
      if (req.method === 'POST' && path === '/api/media/uploads') {
        if (!cloudMedia) throw new HttpError(404, 'API route not found.');
        const user = await authenticate(db, req);
        return json(res, 201, await cloudMedia.reserve(user, await readJson(req)));
      }
      const uploadMatch = path.match(/^\/api\/media\/uploads\/(media_[a-f0-9]{32})\/complete$/);
      if (req.method === 'POST' && uploadMatch) {
        if (!cloudMedia) throw new HttpError(404, 'API route not found.');
        const user = await authenticate(db, req);
        return json(res, 201, await cloudMedia.complete(user, uploadMatch[1]));
      }
      if (req.method === 'POST' && path === '/api/media') {
        if (cloudMedia) throw new HttpError(400, 'Use a direct recording upload.');
        const user = await authenticate(db, req);
        const role = String(req.headers['x-media-role'] || '');
        const target = mediaType(role);
        const inputType = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
        if (!(target.kind === 'video' ? inputType.startsWith('video/') : inputType.startsWith('audio/'))) throw new HttpError(415, `Upload ${target.kind} content for this media role.`);
        const raw = await readBody(req, MAX_MEDIA_BYTES);
        if (!raw.length) throw new HttpError(400, 'Upload media in the request body.');
        const mediaId = id('media');
        const inputPath = join(tempDir, `${mediaId}.upload`);
        const outputPath = join(tempDir, `${mediaId}${target.extension}`);
        writeFileSync(inputPath, raw, { flag: 'wx', mode: 0o600 });
        try {
          const after = await processMediaFile(role, inputPath, outputPath);
          const finalPath = join(mediaDir, `${mediaId}${target.extension}`);
          renameSync(outputPath, finalPath);
          const bytes = statSync(finalPath).size;
          try {
            (await db.prepare('INSERT INTO media VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)').run(mediaId, user.id, role, finalPath, target.contentType, bytes, after.duration, after.width, after.height, now()));
          } catch (error) {
            rmSync(finalPath, { force: true });
            throw error;
          }
          return json(res, 201, { id: mediaId, url: `/media/${mediaId}`, duration: after.duration, width: after.width, height: after.height });
        } finally {
          rmSync(inputPath, { force: true });
          rmSync(outputPath, { force: true });
        }
      }

      if (req.method === 'POST' && path === '/api/annotations') {
        const user = await authenticate(db, req);
        const body = await readJson(req);
        const clientId = oneLine(body.clientId, 200);
        const existing = (await db.prepare(`${ANNOTATION_SELECT} WHERE a.author_id = ? AND a.client_id = ?`).get(user.id, clientId));
        if (existing) return json(res, 200, { annotation: annotationObject(existing) });
        const supplied = body.source;
        if (!supplied || typeof supplied !== 'object') throw new HttpError(400, 'Source details are required.');
        const kind = supplied.kind;
        if (!['article', 'video', 'audio'].includes(kind)) throw new HttpError(400, 'Source kind must be article, video, or audio.');
        const title = oneLine(supplied.title, 300);
        const sourceAuthor = textValue(supplied.author, 200);
        const sourcePublisher = cleanPublisher(textValue(supplied.publisher, 100));
        let canonical;
        try { canonical = canonicalSource(oneLine(supplied.url, 2000)); }
        catch (error) { throw new HttpError(400, error.message || 'Use a valid public source URL.'); }
        const key = await sourceKey(canonical.url);
        let excerpts;
        try {
          const legacy = textValue(body.excerpt, 2000);
          excerpts = validateHighlights(body.excerpts === undefined ? (legacy ? [legacy] : []) : body.excerpts);
        } catch (error) { throw new HttpError(400, error.message); }
        if (kind === 'article' && !excerpts.length) throw new HttpError(400, 'Attach at least one highlighted passage.');
        if (kind !== 'article' && excerpts.length > 1) throw new HttpError(400, 'Multiple text highlights need an article source.');
        const excerpt = joinedHighlights(excerpts);
        const commentary = textValue(body.commentary, 2000);
        const start = numberOrNull(body.start);
        const end = numberOrNull(body.end);
        if (kind === 'article') {
          if (start != null || end != null) throw new HttpError(400, 'Article annotations do not use media times.');
          if (body.mediaId) throw new HttpError(400, 'Article annotations cannot attach a source media clip.');
        } else if (start == null || end == null || start < 0 || end <= start || end - start > MAX_MEDIA_SECONDS) {
          throw new HttpError(400, 'Audio and video annotations need a valid start and end time.');
        }
        const mediaId = body.mediaId || null;
        const voiceMediaId = body.voiceMediaId || null;
        if (!commentary && !voiceMediaId) throw new HttpError(400, 'Add written or voice commentary.');
        if ((kind === 'video' || kind === 'audio') && !mediaId) throw new HttpError(400, `A validated source-${kind} clip is required.`);
        if (mediaId && mediaId === voiceMediaId) throw new HttpError(400, 'Use different files for the source clip and voice commentary.');
        let published;
        try {
          published = await db.transaction(async (tx) => {
            const mediaRows = new Map();
            for (const mediaIdValue of [mediaId, voiceMediaId].filter(Boolean)) {
              const lock = tx.kind === 'postgres' ? ' FOR UPDATE' : '';
              const media = await tx.prepare(`SELECT * FROM media WHERE id = ? AND hidden = 0${lock}`).get(mediaIdValue);
              if (!media) throw new HttpError(410, 'An attached clip is no longer available. Record it again; your written take is kept.');
              if (media.owner_id !== user.id) throw new HttpError(403, 'Attached media must belong to the signed-in user.');
              if (await tx.prepare('SELECT 1 FROM annotations WHERE media_id=? OR voice_media_id=?').get(mediaIdValue, mediaIdValue)) throw new HttpError(409, 'Uploaded media is already linked to an annotation.');
              mediaRows.set(mediaIdValue, media);
            }
            if (mediaId && mediaRows.get(mediaId).role !== `source-${kind}`) throw new HttpError(400, `Attach a source-${kind} upload to this source.`);
            if (voiceMediaId && mediaRows.get(voiceMediaId).role !== 'voice') throw new HttpError(400, 'Voice commentary must use a voice upload.');
            if (mediaId && Math.abs(mediaRows.get(mediaId).duration - (end - start)) > 0.35) throw new HttpError(400, 'The selected time range must match the uploaded source clip duration.');
            await tx.prepare('INSERT OR IGNORE INTO sources VALUES (?, ?, ?, ?, ?, ?, ?)')
              .run(id('source'), key, canonical.url, title, kind, sourceAuthor, now());
            const source = await tx.prepare('SELECT * FROM sources WHERE source_key = ?').get(key);
            if (source.url !== canonical.url || source.kind !== kind) throw new HttpError(409, 'This canonical source already exists with different source details.');
            // Metadata accompanies this explicit capture. Older sources are not
            // silently overwritten, and older clients need not supply a publisher.
            if (sourcePublisher) await tx.prepare('INSERT INTO source_metadata (source_id,publisher) VALUES (?,?) ON CONFLICT(source_id) DO NOTHING').run(source.id, sourcePublisher);
            const annotationId = id('annotation');
            const result = await tx.prepare(`INSERT INTO annotations
              (id,client_id,author_id,source_id,excerpt,start,end,commentary,media_id,voice_media_id,is_demo,hidden,deleted,created_at,excerpts_json)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (author_id,client_id) DO NOTHING`)
              .run(annotationId, clientId, user.id, source.id, excerpt, start, end, commentary, mediaId, voiceMediaId, Number(config.mode === 'local'), 0, 0, now(), JSON.stringify(excerpts));
            const actualId = result.changes ? annotationId
              : (await tx.prepare('SELECT id FROM annotations WHERE author_id=? AND client_id=?').get(user.id, clientId)).id;
            return { created: Boolean(result.changes), annotation: await getAnnotation(tx, actualId) };
          });
        } catch (error) {
          if (error.code === '23505' || /UNIQUE constraint failed: annotations\.(?:media_id|voice_media_id)/.test(error.message || '')) {
            const retry = await db.prepare(`${ANNOTATION_SELECT} WHERE a.author_id = ? AND a.client_id = ?`).get(user.id, clientId);
            if (retry) return json(res, 200, { annotation: annotationObject(retry) });
            throw new HttpError(409, 'Uploaded media is already linked to an annotation.');
          }
          throw error;
        }
        return json(res, published.created ? 201 : 200, { annotation: annotationObject(published.annotation) });
      }

      match = path.match(/^\/api\/annotations\/([^/]+)\/share-card\.png$/);
      if ((req.method === 'GET' || req.method === 'HEAD') && match) {
        const format = url.searchParams.get('format') || 'wide';
        if (format !== 'wide' && format !== 'tall') throw new HttpError(400, 'Unsupported share-card format.');
        // Resolve public visibility before consulting the renderer's cache. A hidden or
        // deleted annotation must stop resolving immediately, even when a card was cached.
        const annotation = await getAnnotation(db, decodeURIComponent(match[1]));
        if (!annotation) throw new HttpError(404, 'Annotation not found.');
        let videoPath = null;
        let videoVersion = null;
        if (annotation.kind === 'video' && annotation.media_id) {
          const media = (await db.prepare("SELECT * FROM media WHERE id=? AND role='source-video' AND hidden=0").get(annotation.media_id));
          if (media && cloudMedia && isCloudMedia(media.path)) {
            videoPath = media.path;
            videoVersion = `${media.id}:${media.bytes}`;
          } else if (media && existsSync(media.path)) {
            try {
              const details = statSync(media.path);
              if (details.isFile()) {
                videoPath = media.path;
                videoVersion = `${media.id}:${details.size}:${details.mtimeMs}`;
              }
            } catch { /* A concurrently removed file degrades to a labeled video excerpt. */ }
          }
        }
        const card = {
          id: annotation.id,
          creatorName: annotation.user_name,
          commentary: annotation.commentary,
          sourceKind: annotation.kind,
          sourceTitle: annotation.title,
          sourceAuthor: annotation.source_author,
          sourcePublisher: annotation.publisher || '',
          sourceUrl: annotation.url,
          excerpt: annotation.excerpt,
          excerpts: storedHighlights(annotation),
          start: annotation.start,
          end: annotation.end,
          isDemo: Boolean(annotation.is_demo),
          siteDomain: new URL(baseUrl).host,
          voiceDuration: annotation.voice_media_id
            ? (await db.prepare("SELECT duration FROM media WHERE id=? AND role='voice' AND hidden=0").get(annotation.voice_media_id))?.duration ?? null
            : null,
          videoPath,
          videoVersion,
        };
        let png;
        try {
          png = cloudMedia && isCloudMedia(videoPath)
            ? await renderShareCard(card, { format, withVideoPath: render => cloudMedia.localFile(videoPath, render) })
            : await renderShareCard(card, { format });
          // Rendering can await FFmpeg and encoding. Re-check moderation state after
          // that work so a concurrent hide/delete cannot return an obsolete card.
          if (!await getAnnotation(db, annotation.id)) throw new HttpError(404, 'Annotation not found.');
          if (videoPath) {
            const mediaStillPublic = (await db.prepare("SELECT 1 FROM media WHERE id=? AND role='source-video' AND hidden=0").get(annotation.media_id));
            if (!mediaStillPublic) {
              png = await renderShareCard({ ...card, videoPath: null, videoVersion: 'hidden' }, { format });
              if (!await getAnnotation(db, annotation.id)) throw new HttpError(404, 'Annotation not found.');
            }
          }
        } catch (error) {
          if (error instanceof ShareCardBusyError) throw new HttpError(503, 'Share-card rendering is busy. Try again shortly.');
          throw error;
        }
        const headers = {
          'Content-Type': 'image/png',
          'Content-Length': png.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        };
        if (url.searchParams.get('download') === '1') {
          const author = String(annotation.user_name || 'author').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'author';
          const shortId = String(annotation.id).replace(/^annotation[_-]/, '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'card';
          headers['Content-Disposition'] = `attachment; filename="annotated-${author}-${shortId}.png"`;
        }
        res.writeHead(200, headers);
        if (req.method === 'HEAD') return res.end();
        return res.end(png);
      }

      match = path.match(/^\/api\/annotations\/([^/]+)$/);
      if (req.method === 'GET' && match) {
        const annotation = await getAnnotation(db, decodeURIComponent(match[1]));
        if (!annotation) throw new HttpError(404, 'Annotation not found.');
        const comments = (await db.prepare(`SELECT c.id AS comment_id, c.text, c.created_at AS comment_created_at,
          u.id, u.name, u.handle, u.color, u.is_demo, u.is_admin, p.bio, p.avatar_version
          FROM comments c JOIN users u ON u.id=c.author_id LEFT JOIN user_profiles p ON p.user_id=u.id WHERE c.annotation_id=? AND c.deleted=0 ORDER BY c.created_at`).all(annotation.id))
          .map((row) => ({ id: row.comment_id, author: userObject(row), text: row.text, createdAt: row.comment_created_at }));
        return json(res, 200, { annotation: annotationObject(annotation), comments });
      }
      if (req.method === 'DELETE' && match) {
        const user = await authenticate(db, req);
        const annotation = await getAnnotation(db, decodeURIComponent(match[1]), { includeHidden: true });
        if (!annotation) throw new HttpError(404, 'Annotation not found.');
        if (annotation.author_id !== user.id) throw new HttpError(403, 'Only the annotation owner can delete it.');
        await db.transaction(async (tx) => {
          await tx.prepare('UPDATE annotations SET deleted=1, hidden=1 WHERE id=?').run(annotation.id);
          for (const mediaId of [annotation.media_id, annotation.voice_media_id].filter(Boolean)) await tx.prepare('UPDATE media SET hidden=1 WHERE id=?').run(mediaId);
        });
        return json(res, 200, { ok: true });
      }

      match = path.match(/^\/api\/annotations\/([^/]+)\/comments$/);
      if (req.method === 'POST' && match) {
        const user = await authenticate(db, req);
        const annotation = await getAnnotation(db, decodeURIComponent(match[1]));
        if (!annotation) throw new HttpError(404, 'Annotation not found.');
        const body = await readJson(req);
        const commentText = textValue(body.text, 1000, { required: true });
        const commentId = id('comment');
        const createdAt = now();
        (await db.prepare('INSERT INTO comments VALUES (?, ?, ?, ?, 0, ?)').run(commentId, annotation.id, user.id, commentText, createdAt));
        return json(res, 201, { comment: { id: commentId, author: user, text: commentText, createdAt } });
      }

      match = path.match(/^\/api\/comments\/([^/]+)$/);
      if (req.method === 'DELETE' && match) {
        const user = await authenticate(db, req);
        const comment = (await db.prepare('SELECT * FROM comments WHERE id=? AND deleted=0').get(decodeURIComponent(match[1])));
        if (!comment) throw new HttpError(404, 'Comment not found.');
        if (comment.author_id !== user.id && !user.isAdmin) throw new HttpError(403, 'Only the comment owner or local operator can delete it.');
        (await db.prepare('UPDATE comments SET deleted=1 WHERE id=?').run(comment.id));
        return json(res, 200, { ok: true });
      }

      match = path.match(/^\/api\/users\/([^/]+)\/avatar$/);
      if (['GET', 'HEAD'].includes(req.method) && match) {
        const photo = await db.prepare('SELECT avatar_base64,avatar_version FROM user_profiles WHERE user_id=?').get(decodeURIComponent(match[1]));
        if (!photo?.avatar_base64 || (url.searchParams.has('v') && url.searchParams.get('v') !== photo.avatar_version)) throw new HttpError(404, 'Profile photo not found.');
        const bytes = Buffer.from(photo.avatar_base64, 'base64');
        const etag = `"${photo.avatar_version}"`;
        const headers = { 'Content-Type': 'image/webp', 'Cache-Control': 'public, no-cache', 'X-Content-Type-Options': 'nosniff', ETag: etag };
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
        res.writeHead(200, { ...headers, 'Content-Length': bytes.length });
        return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
      match = path.match(/^\/api\/users\/([^/]+)\/profile$/);
      if (req.method === 'POST' && match) {
        const user = await authenticate(db, req);
        if (user.id !== decodeURIComponent(match[1])) throw new HttpError(403, 'Only the profile owner can edit it.');
        const body = await readJson(req, PROFILE_JSON_BYTES);
        if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(key => !['bio', 'photo'].includes(key))) throw new HttpError(400, 'Only bio and photo can be edited.');
        const bio = body.bio === undefined ? undefined : profileBio(body.bio);
        let photo;
        if (body.photo === null) photo = { base64: null, version: null };
        else if (body.photo !== undefined) {
          if (activeProfilePhotos >= 2) throw new HttpError(503, 'Photo processing is busy. Please save again shortly.');
          activeProfilePhotos++;
          try { photo = await normalizeProfilePhoto(body.photo); }
          finally { activeProfilePhotos--; }
        }
        await db.transaction(async tx => {
          // Serialize saves for this owner while preserving omitted fields.
          if (db.kind === 'postgres') await tx.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(user.id);
          const current = await tx.prepare('SELECT * FROM user_profiles WHERE user_id=?').get(user.id);
          await tx.prepare(`INSERT INTO user_profiles (user_id,bio,avatar_base64,avatar_version,updated_at) VALUES (?,?,?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET bio=excluded.bio,avatar_base64=excluded.avatar_base64,avatar_version=excluded.avatar_version,updated_at=excluded.updated_at`)
            .run(user.id, bio ?? current?.bio ?? '', photo ? photo.base64 : current?.avatar_base64 ?? null, photo ? photo.version : current?.avatar_version ?? null, now());
        });
        return json(res, 200, { user: userObject(await db.prepare('SELECT u.*,p.bio,p.avatar_version FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id=?').get(user.id)) });
      }
      match = path.match(/^\/api\/users\/([^/]+)$/);
      if (req.method === 'GET' && match) {
        const target = (await db.prepare('SELECT u.*,p.bio,p.avatar_version FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id=?').get(decodeURIComponent(match[1])));
        if (!target) throw new HttpError(404, 'User not found.');
        const viewer = await authenticate(db, req, { required: false });
        const rows = (await db.prepare(`${ANNOTATION_SELECT} WHERE a.author_id=? AND a.hidden=0 AND a.deleted=0 ORDER BY a.created_at DESC`).all(target.id));
        const isFollowing = viewer ? Boolean((await db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?').get(viewer.id, target.id))) : false;
        const followerCount = Number((await db.prepare('SELECT COUNT(*) AS count FROM follows WHERE followed_id=?').get(target.id)).count);
        const followingCount = Number((await db.prepare('SELECT COUNT(*) AS count FROM follows WHERE follower_id=?').get(target.id)).count);
        return json(res, 200, { user: userObject(target), annotations: rows.map(annotationObject), isFollowing, followerCount, followingCount, annotationCount: rows.length });
      }

      match = path.match(/^\/api\/users\/([^/]+)\/(followers|following)$/);
      if (req.method === 'GET' && match) {
        const targetId = decodeURIComponent(match[1]);
        if (!(await db.prepare('SELECT 1 FROM users WHERE id=?').get(targetId))) throw new HttpError(404, 'User not found.');
        const rawOffset = url.searchParams.get('offset') ?? '0';
        const offset = Number(rawOffset);
        if (!/^\d+$/.test(rawOffset) || !Number.isSafeInteger(offset)) throw new HttpError(400, 'Invalid list offset.');
        // Only these fixed column names enter SQL; all request values are bound.
        const followers = match[2] === 'followers';
        const person = followers ? 'follower_id' : 'followed_id';
        const owner = followers ? 'followed_id' : 'follower_id';
        const rows = await db.prepare(`SELECT u.id,u.name,u.handle,u.color,p.avatar_version
          FROM follows f JOIN users u ON u.id=f.${person}
          LEFT JOIN user_profiles p ON p.user_id=u.id WHERE f.${owner}=?
          ORDER BY f.created_at DESC,u.id ASC LIMIT 51 OFFSET ?`).all(targetId, offset);
        const users = rows.slice(0, 50).map(row => {
          const { id, name, handle, color, avatarUrl } = userObject(row);
          return { id, name, handle, color, avatarUrl };
        });
        return json(res, 200, { users, nextOffset: rows.length > 50 ? offset + 50 : null });
      }

      match = path.match(/^\/api\/users\/([^/]+)\/follow$/);
      if (req.method === 'POST' && match) {
        const user = await authenticate(db, req);
        const targetId = decodeURIComponent(match[1]);
        if (!(await db.prepare('SELECT 1 FROM users WHERE id=?').get(targetId))) throw new HttpError(404, 'User not found.');
        if (targetId === user.id) throw new HttpError(400, 'A user cannot follow their own local profile.');
        const body = await readJson(req);
        if (typeof body.following !== 'boolean') throw new HttpError(400, 'following must be true or false.');
        if (body.following) (await db.prepare('INSERT OR IGNORE INTO follows VALUES (?, ?, ?)').run(user.id, targetId, now()));
        else (await db.prepare('DELETE FROM follows WHERE follower_id=? AND followed_id=?').run(user.id, targetId));
        return json(res, 200, { following: body.following });
      }

      if (req.method === 'POST' && path === '/api/claims') {
        if (!trustedOrigin(req)) throw new HttpError(403, 'This request origin is not allowed.');
        const body = await readJson(req);
        const annotation = await getAnnotation(db, oneLine(body.annotationId, 200));
        if (!annotation) throw new HttpError(404, 'Annotation not found.');
        const claimId = id('claim');
        const name = oneLine(body.name, 200);
        const email = oneLine(body.email, 320).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Use a valid contact email.');
        const reason = oneLine(body.reason, 300);
        const details = textValue(body.details, 4000, { required: true });
        const createdAt = now();
        (await db.prepare('INSERT INTO claims VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)').run(claimId, annotation.id, name, email, reason, details, 'open', createdAt, createdAt));
        return json(res, 201, { reference: claimId });
      }

      if (req.method === 'GET' && path === '/api/admin/claims') {
        await requireAdmin(db, req);
        const claims = (await db.prepare(`SELECT c.*, a.excerpt, a.hidden AS annotation_hidden FROM claims c JOIN annotations a ON a.id=c.annotation_id ORDER BY c.created_at DESC`).all())
          .map((row) => ({ id: row.id, reference: row.id, annotationId: row.annotation_id, name: row.name, email: row.email, reason: row.reason, details: row.details, status: row.status, scope: row.scope, note: row.operator_note || '', createdAt: row.created_at, updatedAt: row.updated_at }));
        return json(res, 200, { claims });
      }

      match = path.match(/^\/api\/admin\/claims\/([^/]+)$/);
      if (req.method === 'POST' && match) {
        await requireAdmin(db, req);
        const claim = (await db.prepare('SELECT * FROM claims WHERE id=?').get(decodeURIComponent(match[1])));
        if (!claim) throw new HttpError(404, 'Claim not found.');
        const body = await readJson(req);
        if (!['hide', 'reject', 'restore'].includes(body.action)) throw new HttpError(400, 'Action must be hide, reject, or restore.');
        if (!['annotation', 'media'].includes(body.scope)) throw new HttpError(400, 'Scope must be annotation or media.');
        const note = textValue(body.note, 2000);
        const annotation = await getAnnotation(db, claim.annotation_id, { includeHidden: true });
        if (!annotation) throw new HttpError(404, 'Claimed annotation not found.');
        if (body.action === 'hide') {
          if (body.scope === 'annotation') (await db.prepare('UPDATE annotations SET hidden=1 WHERE id=?').run(annotation.id));
          else for (const mediaId of [annotation.media_id, annotation.voice_media_id].filter(Boolean)) (await db.prepare('UPDATE media SET hidden=1 WHERE id=?').run(mediaId));
        } else if (body.action === 'restore') {
          if (annotation.deleted) throw new HttpError(409, 'Deleted annotations cannot be restored by claim moderation.');
          if (body.scope === 'annotation') (await db.prepare('UPDATE annotations SET hidden=0 WHERE id=?').run(annotation.id));
          else for (const mediaId of [annotation.media_id, annotation.voice_media_id].filter(Boolean)) (await db.prepare('UPDATE media SET hidden=0 WHERE id=?').run(mediaId));
        }
        (await db.prepare('UPDATE claims SET status=?, scope=?, operator_note=?, updated_at=? WHERE id=?').run(body.action === 'reject' ? 'rejected' : body.action === 'hide' ? 'actioned' : 'restored', body.scope, note, now(), claim.id));
        return json(res, 200, { ok: true });
      }

      match = path.match(/^\/media\/([^/]+)$/);
      if ((req.method === 'GET' || req.method === 'HEAD') && match) {
        const mediaId = decodeURIComponent(match[1]);
        const accessibleMedia = async () => {
          const item = await db.prepare('SELECT * FROM media WHERE id=?').get(mediaId);
          if (!item || item.hidden) throw new HttpError(404, 'Media not found.');
          const linked = await db.prepare('SELECT 1 FROM annotations WHERE hidden=0 AND deleted=0 AND (media_id=? OR voice_media_id=?)').get(item.id, item.id);
          if (!linked) {
            const user = await authenticate(db, req, { required: false });
            if (!user || user.id !== item.owner_id) throw new HttpError(404, 'Media not found.');
          }
          return item;
        };
        const media = await accessibleMedia();
        const remote = isCloudMedia(media.path);
        if (remote ? !cloudMedia : !existsSync(media.path)) throw new HttpError(404, 'Media file not found.');
        const size = remote ? Number(media.bytes) : statSync(media.path).size;
        let start = 0;
        let end = size - 1;
        const range = req.headers.range;
        if (range) {
          const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!parsed || (!parsed[1] && !parsed[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
          start = parsed[1] ? Number(parsed[1]) : null;
          end = parsed[2] ? Number(parsed[2]) : null;
          if (start == null) { const suffix = Math.min(Number(end), size); start = size - suffix; end = size - 1; }
          else end = end == null ? size - 1 : Math.min(end, size - 1);
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        }
        let stream;
        if (req.method !== 'HEAD') {
          if (remote) {
            const opened = await cloudMedia.open(media.path, range ? `bytes=${start}-${end}` : undefined);
            try {
              await accessibleMedia();
              if (Number(opened.headers.get('content-length')) !== end - start + 1 || (range && opened.headers.get('content-range') !== `bytes ${start}-${end}/${size}`)) throw new HttpError(502, 'The recording could not be loaded.');
            } catch (error) { await opened.stream.cancel(); throw error; }
            stream = Readable.fromWeb(opened.stream);
          } else stream = createReadStream(media.path, { start, end });
        }
        res.writeHead(range ? 206 : 200, {
          'Content-Type': media.content_type, 'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
        });
        if (req.method === 'HEAD') return res.end();
        await pipeline(stream, res);
        return;
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && ['/shared/source.mjs', '/shared/source-identity.mjs', '/shared/marker.mjs', '/shared/share-sheet.mjs', '/shared/share-sheet.css', '/shared/article-draft.mjs'].includes(path)) {
        if (serveFile(req, res, join(ROOT, path))) return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && ['/shared/fonts.css', '/shared/marker-tokens.css'].includes(path)) {
        if (serveFile(req, res, join(ROOT, 'extension', path.split('/').at(-1)))) return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/shared/fonts/')) {
        const target = safeStatic(join(ROOT, 'extension', 'fonts'), path.slice('/shared/fonts/'.length));
        if (target && serveFile(req, res, target, { cache: true })) return;
        throw new HttpError(404, 'Font not found.');
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && path === '/extension.zip') {
        const extensionPath = config.mode === 'production' ? matchingProductionExtension(config) : join(ROOT, 'artifacts', 'annotated-extension.zip');
        if (extensionPath && serveFile(req, res, extensionPath)) return;
        throw new HttpError(404, 'The extension package has not been built yet.');
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/fixtures/')) {
        if (config.mode === 'production') throw new HttpError(404, 'Not found.');
        const target = safeStatic(join(ROOT, 'web', 'fixtures'), path.slice('/fixtures/'.length));
        if (target && serveFile(req, res, target)) return;
        throw new HttpError(404, 'Fixture not found.');
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/web/')) {
        if (config.mode === 'production' && path.startsWith('/web/fixtures/')) throw new HttpError(404, 'Not found.');
        const target = safeStatic(join(ROOT, 'web'), path.slice('/web/'.length));
        if (target && serveFile(req, res, target)) return;
      }
      match = path.match(/^\/a\/([^/]+)$/);
      if ((req.method === 'GET' || req.method === 'HEAD') && match) {
        const annotation = await getAnnotation(db, decodeURIComponent(match[1]));
        const indexPath = join(ROOT, 'web', 'index.html');
        if (!existsSync(indexPath)) throw new HttpError(503, 'The web interface has not been built yet.');
        if (!annotation) return sendHtml(req, res, shellHtml(indexPath, baseUrl), 404);
        return sendHtml(req, res, receiptHtml(indexPath, annotation, baseUrl));
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/' || /^\/(?:a|s|u)\/[^/]+$/.test(path) || ['/feed', '/write', '/phone', '/install', '/signin', '/privacy', '/terms', '/admin/claims'].includes(path))) {
        const indexPath = join(ROOT, 'web', 'index.html');
        if (existsSync(indexPath)) return sendHtml(req, res, shellHtml(indexPath, baseUrl));
        throw new HttpError(503, 'The web interface has not been built yet.');
      }
      if (path.startsWith('/api/')) throw new HttpError(404, 'API route not found.');
      if ((req.method === 'GET' || req.method === 'HEAD') && req.headers.accept?.includes('text/html')
        && !path.startsWith('/web/') && !path.startsWith('/shared/')) {
        return sendHtml(req, res, shellHtml(join(ROOT, 'web', 'index.html'), baseUrl), 404);
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      const expected = error instanceof HttpError || error instanceof MediaError || error instanceof ProfileError;
      if (!res.headersSent) json(res, expected ? error.status : 500, { error: expected ? error.message : 'Internal server error.' });
      else res.destroy();
      if (!expected) console.error('Request failed.');
    }
  };
  const server = http.createServer(requestHandler);
  server.requestHandler = requestHandler;
  server.ready = ready;
  let cleanupTimer;
  const cleanupMedia = () => {
    // Local sweeps are synchronous. Defer a pass if publication currently owns
    // the SQLite write transaction, so its not-yet-committed files stay intact.
    if (db.transactionActive) return;
    try {
      const result = sweepAbandonedMedia(db, dataDir);
      if (result.failures) console.error(`Media cleanup: ${result.failures} items could not be removed; will retry.`);
    } catch { console.error('Media cleanup failed; will retry.'); }
  };
  server.once('listening', () => {
    if (config.mediaStorage !== 'disk' || config.databaseUrl) return;
    cleanupMedia();
    cleanupTimer = setInterval(cleanupMedia, MEDIA_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
  });
  server.on('close', () => {
    clearInterval(cleanupTimer);
    if (db) void db.close();
  });
  Object.defineProperty(server, 'database', { get: () => db });
  server.dataDir = dataDir;
  server.appMode = config.mode;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const server = createServer({ config });
  server.listen(config.port, config.host, () => console.log(`Annotated ${config.mode} service listening on ${config.host}:${config.port}`));
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const forced = setTimeout(() => process.exit(1), 10_000);
    forced.unref();
    server.close((error) => process.exit(error ? 1 : 0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
