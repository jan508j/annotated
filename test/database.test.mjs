import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresSql } from '../server/database.mjs';
import { loadConfig } from '../server/index.mjs';

test('Postgres query translation preserves conflict and positional parameter behavior', () => {
  assert.equal(
    postgresSql('INSERT OR IGNORE INTO sources VALUES (?, ?, ?)'),
    'INSERT INTO sources VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
  );
  assert.equal(
    postgresSql('INSERT INTO annotations (start,end) VALUES (?, ?) ON CONFLICT (author_id,client_id) DO NOTHING'),
    'INSERT INTO annotations (start,"end") VALUES ($1, $2) ON CONFLICT (author_id,client_id) DO NOTHING',
  );
  assert.equal(
    postgresSql('DELETE FROM oauth_states WHERE state_hash=? AND browser_hash=? RETURNING *'),
    'DELETE FROM oauth_states WHERE state_hash=$1 AND browser_hash=$2 RETURNING *',
  );
});

test('database URL validation and operator display name do not echo connection secrets', () => {
  const config = loadConfig({ DATABASE_URL: 'postgresql://user:secret@localhost/annotated', ADMIN_DISPLAY_NAME: 'John Blackmountain' });
  assert.equal(config.adminDisplayName, 'John Blackmountain');
  assert.throws(() => loadConfig({ DATABASE_URL: 'sqlite://secret-bad-url' }),
    (error) => !error.message.includes('secret-bad-url'));
  assert.throws(() => loadConfig({ ADMIN_DISPLAY_NAME: 'bad\nname' }), /ADMIN_DISPLAY_NAME/);
});
