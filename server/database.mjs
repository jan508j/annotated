import { AsyncLocalStorage } from 'node:async_hooks';
import { attachDatabasePool } from '@vercel/functions';
import { PROFILE_SCHEMA } from './profile.mjs';

// The server keeps its small SQLite query vocabulary. This adapter only translates
// positional parameters and the two SQLite conflict forms used by that vocabulary.
export function postgresSql(sql) {
  let index = 0;
  return sql.replace(/\bINSERT OR IGNORE INTO\b/gi, 'INSERT INTO')
    .replace(/\bstart,end\b/g, 'start,"end"')
    .replace(/\?/g, () => `$${++index}`)
    .replace(/;\s*$/, '')
    .replace(/^(INSERT INTO[\s\S]+)$/i, (statement) => /\bON CONFLICT\b/i.test(statement) || !/\bINSERT OR IGNORE\b/i.test(sql)
      ? statement : `${statement} ON CONFLICT DO NOTHING`);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT NOT NULL UNIQUE, color TEXT NOT NULL,
    is_demo INTEGER NOT NULL, is_admin INTEGER NOT NULL, provider_subject TEXT, email TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_provider_subject_unique ON users(provider_subject) WHERE provider_subject IS NOT NULL;
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, url TEXT NOT NULL, title TEXT NOT NULL,
    kind TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, path TEXT NOT NULL,
    content_type TEXT NOT NULL, bytes BIGINT NOT NULL, duration DOUBLE PRECISION NOT NULL,
    width INTEGER, height INTEGER, hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES users(id),
    source_id TEXT NOT NULL REFERENCES sources(id), excerpt TEXT NOT NULL, excerpts_json TEXT,
    start DOUBLE PRECISION, "end" DOUBLE PRECISION, commentary TEXT NOT NULL,
    media_id TEXT REFERENCES media(id), voice_media_id TEXT REFERENCES media(id),
    is_demo INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, UNIQUE(author_id, client_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS annotations_media_unique ON annotations(media_id) WHERE media_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS annotations_voice_media_unique ON annotations(voice_media_id) WHERE voice_media_id IS NOT NULL;
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
`;

export async function createPostgresDatabase(connectionString) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 5000, connectionTimeoutMillis: 10000 });
  pool.on('error', () => { console.error('An idle database connection closed.'); });
  if (process.env.VERCEL) attachDatabasePool(pool);
  const context = new AsyncLocalStorage();
  const query = (sql, values) => {
    const target = context.getStore() || pool;
    const text = postgresSql(sql);
    return values?.length ? target.query(text, values) : target.query(text);
  };
  const db = {
    kind: 'postgres',
    prepare(sql) {
      return {
        async get(...values) { return (await query(sql, values)).rows[0]; },
        async all(...values) { return (await query(sql, values)).rows; },
        async run(...values) { return { changes: (await query(sql, values)).rowCount }; },
      };
    },
    async exec(sql) { await query(sql, []); },
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await context.run(client, () => work(db));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    async close() { await pool.end(); },
  };
  try {
    await db.transaction(async () => {
      await db.exec('SELECT pg_advisory_xact_lock(62819442)');
      for (const statement of (SCHEMA + PROFILE_SCHEMA).split(';').map((part) => part.trim()).filter(Boolean)) await db.exec(statement);
      // Even ALTER ... IF NOT EXISTS takes an exclusive table lock. Avoid
      // taking it on every cold start alongside other instances' user queries.
      const highlights = await db.prepare(`SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'annotations' AND column_name = 'excerpts_json'`).get();
      if (!highlights) await db.exec('ALTER TABLE annotations ADD COLUMN excerpts_json TEXT');
    });
  }
  catch (error) { await db.close(); throw error; }
  return db;
}
