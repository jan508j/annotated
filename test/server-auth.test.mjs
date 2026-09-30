import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, loadConfig } from '../server/index.mjs';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const PROD_ORIGIN = 'https://annotated.example';
const LEGACY_ORIGIN = 'https://old.annotated.example';

function challenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function fakeGoogle(overrides = {}) {
  const calls = { starts: [], callbacks: [] };
  return {
    calls,
    authorizationUrl(input) {
      calls.starts.push(input);
      const url = new URL('https://accounts.example.test/authorize');
      url.searchParams.set('state', input.state);
      url.searchParams.set('nonce', input.nonce);
      url.searchParams.set('code_challenge', input.codeChallenge);
      return url.href;
    },
    async authenticate(input) {
      calls.callbacks.push(input);
      if (overrides.error) throw new Error('fake provider detail must stay private');
      return {
        subject: overrides.subject || 'stable-google-subject',
        email: overrides.email || 'admin@example.test',
        emailVerified: overrides.emailVerified ?? true,
        name: overrides.name || 'Avery Reviewer',
        nonce: overrides.badNonce ? 'wrong-nonce' : input.nonce,
      };
    },
  };
}

async function startProduction(t, provider = fakeGoogle(), xProvider = null, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'annotated-production-test-'));
  const server = createServer({
    mode: 'production',
    baseUrl: PROD_ORIGIN,
    host: '127.0.0.1',
    dataDir,
    googleClientId: 'test-client.apps.googleusercontent.com',
    googleClientSecret: 'test-secret',
    extensionIds: [EXTENSION_ID],
    adminEmails: ['admin@example.test'],
    adminDisplayName: 'John Blackmountain',
    googleProvider: provider,
    legacyBaseUrl: options.legacyBaseUrl,
    legacyGoogleProvider: options.legacyGoogleProvider,
    legacyXProvider: options.legacyXProvider,
    xClientId: xProvider ? 'test-x-client' : '',
    xClientSecret: xProvider ? 'test-x-secret' : '',
    xProvider,
    seed: false,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const transport = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { server, transport, provider, dataDir };
}

async function request(transport, path, options = {}) {
  const headers = { host: 'annotated.example', ...(options.headers || {}) };
  let body = options.body;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  }
  const target = new URL(path, transport);
  const result = await new Promise((resolve, reject) => {
    const req = http.request(target, { method: options.method || 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ res, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body != null) req.end(body);
    else req.end();
  });
  const response = {
    status: result.res.statusCode,
    headers: {
      get(name) {
        const value = result.res.headers[name.toLowerCase()];
        return Array.isArray(value) ? value.join(', ') : value ?? null;
      },
      getSetCookie() { return result.res.headers['set-cookie'] || []; },
    },
  };
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? JSON.parse(result.raw || '{}') : result.raw;
  return { response, data };
}

function cookieValue(response, name) {
  const cookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || ''];
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  assert.ok(cookie, `missing ${name} cookie`);
  return cookie.split(';')[0];
}

async function begin(transport, query, provider = 'google', headers = {}) {
  const started = await request(transport, `/auth/${provider}/start?${query}`, { headers });
  assert.equal(started.response.status, 302);
  const authorization = new URL(started.response.headers.get('location'));
  return {
    state: authorization.searchParams.get('state'),
    cookie: cookieValue(started.response, 'annotated_oauth'),
    authorization,
  };
}

test('configuration fails closed for deployment/local mode mistakes', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_MODE: 'local' }), /APP_MODE=production/);
  assert.throws(() => loadConfig({ APP_MODE: 'local', HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => loadConfig({ APP_MODE: 'local', BASE_URL: 'http://demo.example' }), /loopback/);
  assert.throws(() => loadConfig({
    APP_MODE: 'production', BASE_URL: 'https://127.0.0.1', DATA_DIR: '/tmp/data',
    GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', EXTENSION_IDS: EXTENSION_ID,
    ADMIN_EMAILS: 'admin@example.test',
  }), /public hostname/);
  assert.throws(() => loadConfig({ APP_MODE: 'production', BASE_URL: 'https://annotated.example' }), /DATA_DIR/);
  assert.throws(() => loadConfig({
    APP_MODE: 'production', BASE_URL: 'https://annotated.example', DATA_DIR: '/tmp/data',
    GOOGLE_CLIENT_ID: 'super-secret-value',
  }), (error) => !error.message.includes('super-secret-value'));
  for (const legacy of [PROD_ORIGIN, 'http://old.annotated.example', 'https://old.annotated.example/path', 'https://127.0.0.1']) {
    assert.throws(() => loadConfig({ BASE_URL: PROD_ORIGIN, APP_MODE: 'production', LEGACY_BASE_URL: legacy }), /LEGACY_BASE_URL/);
  }
  assert.throws(() => loadConfig({ LEGACY_BASE_URL: LEGACY_ORIGIN }), /LEGACY_BASE_URL/);
});

test('legacy host redirects public navigation and serves old API, media and static paths directly', async (t) => {
  const context = await startProduction(t, fakeGoogle(), null, { legacyBaseUrl: LEGACY_ORIGIN });
  const host = { host: new URL(LEGACY_ORIGIN).host };
  for (const method of ['GET', 'HEAD']) {
    const moved = await request(context.transport, '/a/annotation-1?from=old%20share', { method, headers: host });
    assert.equal(moved.response.status, 302);
    assert.equal(moved.response.headers.get('location'), `${PROD_ORIGIN}/a/annotation-1?from=old%20share`);
    assert.equal(moved.response.headers.get('cache-control'), 'no-store');
  }
  const webStart = await request(context.transport, '/auth/google/start?returnTo=%2Fa%2Fold', { headers: host });
  assert.equal(webStart.response.status, 302);
  assert.equal(webStart.response.headers.get('location'), `${PROD_ORIGIN}/auth/google/start?returnTo=%2Fa%2Fold`);
  assert.equal(webStart.response.headers.get('set-cookie'), null);
  for (const path of ['/api/session', '/web/styles.css']) {
    const response = await request(context.transport, path, { headers: host });
    assert.equal(response.response.status, 200, path);
    assert.equal(response.response.headers.get('location'), null, path);
  }
  const media = await request(context.transport, '/media/missing', { headers: host });
  assert.equal(media.response.status, 404);
  assert.equal(media.response.headers.get('location'), null);
  assert.equal((await request(context.transport, '/api/session', { headers: { host: 'unknown.example', origin: PROD_ORIGIN } })).response.status, 403);
});

test('pending legacy web callback can use its cookie and write through the old host', async (t) => {
  const canonical = fakeGoogle({ subject: 'canonical-account' });
  const legacy = fakeGoogle({ subject: 'legacy-account' });
  const context = await startProduction(t, canonical, null, { legacyBaseUrl: LEGACY_ORIGIN, legacyGoogleProvider: legacy });
  const started = await begin(context.transport, 'returnTo=%2Ffeed');
  const callback = await request(context.transport, `/auth/google/callback?state=${started.state}&code=old-in-flight-code`, {
    headers: { host: new URL(LEGACY_ORIGIN).host, cookie: started.cookie },
  });
  assert.equal(callback.response.status, 302);
  assert.equal(callback.response.headers.get('location'), '/feed');
  assert.equal(canonical.calls.callbacks.length, 0);
  assert.equal(legacy.calls.callbacks.length, 1);
  const cookie = cookieValue(callback.response, 'annotated_session');
  const published = await request(context.transport, '/api/annotations', {
    method: 'POST', headers: { host: new URL(LEGACY_ORIGIN).host, origin: LEGACY_ORIGIN, cookie },
    json: { clientId: 'legacy-domain-article', source: { kind: 'article', title: 'Original sample source', url: 'https://source.example/article' }, excerpt: 'A precise source passage.', commentary: 'A human take.' },
  });
  assert.equal(published.response.status, 201);
  const id = published.data.annotation.id;
  for (const host of [new URL(LEGACY_ORIGIN).host, new URL(PROD_ORIGIN).host]) {
    const found = await request(context.transport, `/api/annotations/${id}`, { headers: { host } });
    assert.equal(found.response.status, 200);
    assert.equal(found.data.annotation.id, id);
  }
  const mismatched = await request(context.transport, `/api/annotations/${id}/comments`, {
    method: 'POST', headers: { host: new URL(LEGACY_ORIGIN).host, origin: PROD_ORIGIN, cookie }, json: { text: 'Cross-host cookie mutation' },
  });
  assert.equal(mismatched.response.status, 403);
  assert.equal(mismatched.response.headers.get('access-control-allow-origin'), null);
  assert.equal((await request(context.transport, `/api/annotations/${id}/comments`, {
    method: 'POST', headers: { origin: LEGACY_ORIGIN, cookie }, json: { text: 'Reverse cross-host mutation' },
  })).response.status, 403);
});

test('production web OAuth uses state, nonce and PKCE then creates an expiring secure session', async (t) => {
  const context = await startProduction(t);
  const started = await begin(context.transport, 'returnTo=%2Fa%2Fannotation-1');
  assert.match(started.authorization.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(started.authorization.searchParams.get('nonce'));

  const callback = await request(context.transport, `/auth/google/callback?state=${encodeURIComponent(started.state)}&code=one-time-google-code`, {
    headers: { cookie: started.cookie },
  });
  assert.equal(callback.response.status, 302);
  assert.equal(callback.response.headers.get('location'), '/a/annotation-1');
  const sessionCookie = cookieValue(callback.response, 'annotated_session');
  assert.match(callback.response.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(callback.response.headers.get('set-cookie'), /Secure/i);
  assert.match(callback.response.headers.get('set-cookie'), /SameSite=Lax/i);
  assert.equal(challenge(context.provider.calls.callbacks[0].codeVerifier), context.provider.calls.starts[0].codeChallenge);
  assert.equal(context.provider.calls.callbacks[0].nonce, context.provider.calls.starts[0].nonce);

  const session = await request(context.transport, '/api/session', { headers: { cookie: sessionCookie, origin: PROD_ORIGIN } });
  assert.equal(session.response.status, 200);
  assert.equal(session.data.mode, 'production');
  assert.equal(session.data.oauthConfigured, true);
  assert.equal(session.data.extensionAvailable, false);
  assert.equal(session.data.user.isDemo, false);
  assert.equal(session.data.user.isAdmin, true);
  assert.equal(session.data.user.name, 'John Blackmountain');
  assert.doesNotMatch(session.data.user.handle, /admin/);

  const replay = await request(context.transport, `/auth/google/callback?state=${encodeURIComponent(started.state)}&code=replay`, { headers: { cookie: started.cookie } });
  assert.equal(replay.response.status, 400);
  assert.doesNotMatch(JSON.stringify(replay.data), /one-time-google-code|test-secret/);

  context.server.database.prepare('UPDATE sessions SET expires_at=?').run('2000-01-01T00:00:00.000Z');
  const expired = await request(context.transport, '/api/session', { headers: { cookie: sessionCookie, origin: PROD_ORIGIN } });
  assert.equal(expired.data.user, null);
});

test('extension sign-in keeps different Google accounts separate and limits the operator display-name override', async (t) => {
  const identity = { subject: 'operator-subject', email: 'admin@example.test', name: 'Operator Google Name' };
  const context = await startProduction(t, fakeGoogle(identity));
  const verifier = 'account-isolation-verifier-with-at-least-forty-three-characters';
  const origin = `chrome-extension://${EXTENSION_ID}`;
  async function signIn() {
    const started = await begin(context.transport, `extensionId=${EXTENSION_ID}&codeChallenge=${challenge(verifier)}`);
    const callback = await request(context.transport, `/auth/google/callback?state=${encodeURIComponent(started.state)}&code=isolated-test-code`, { headers: { cookie: started.cookie } });
    assert.equal(callback.response.status, 302);
    const code = new URL(callback.response.headers.get('location')).searchParams.get('code');
    const exchanged = await request(context.transport, '/api/auth/extension/exchange', { method: 'POST', headers: { origin }, json: { code, codeVerifier: verifier } });
    assert.equal(exchanged.response.status, 200);
    return exchanged.data;
  }
  const operator = await signIn();
  Object.assign(identity, { subject: 'reader-subject', email: 'reader@example.test', name: 'Casey Reader' });
  const reader = await signIn();
  assert.notEqual(reader.user.id, operator.user.id);
  assert.notEqual(reader.token, operator.token);
  assert.equal(operator.user.name, 'John Blackmountain');
  assert.equal(operator.user.isAdmin, true);
  assert.equal(reader.user.name, 'Casey Reader');
  assert.equal(reader.user.isAdmin, false);
  assert.equal((await signIn()).user.id, reader.user.id, 'returning Google identity keeps its own account');
  const operatorSession = await request(context.transport, '/api/session', { headers: { origin, authorization: `Bearer ${operator.token}` } });
  const readerSession = await request(context.transport, '/api/session', { headers: { origin, authorization: `Bearer ${reader.token}` } });
  assert.equal(operatorSession.data.user.id, operator.user.id);
  assert.equal(readerSession.data.user.id, reader.user.id);
  assert.equal((await request(context.transport, '/api/admin/claims', { headers: { origin, authorization: `Bearer ${reader.token}` } })).response.status, 403);
  assert.equal((await request(context.transport, '/api/session')).data.user, null);
});

test('OAuth rejects unsafe returns, expired/replayed state and sanitized provider failures', async (t) => {
  const context = await startProduction(t, fakeGoogle({ error: true }));
  for (const value of ['%2F%2Fevil.example', '%2F%5Cevil.example', '%2F%250aevil']) {
    const unsafe = await request(context.transport, `/auth/google/start?returnTo=${value}`);
    assert.equal(unsafe.response.status, 400);
  }
  const started = await begin(context.transport, 'returnTo=%2F');
  const missingBrowserCookie = await request(context.transport, `/auth/google/callback?state=${encodeURIComponent(started.state)}&code=provider-code`);
  assert.equal(missingBrowserCookie.response.status, 400);
  const failed = await request(context.transport, `/auth/google/callback?state=${encodeURIComponent(started.state)}&code=provider-code`, { headers: { cookie: started.cookie } });
  assert.equal(failed.response.status, 401);
  assert.deepEqual(failed.data, { error: 'Google sign-in could not be verified.' });
  const replay = await request(context.transport, `/auth/google/callback?state=${encodeURIComponent(started.state)}&code=provider-code`, { headers: { cookie: started.cookie } });
  assert.equal(replay.response.status, 400);

  const expired = await begin(context.transport, 'returnTo=%2F');
  context.server.database.prepare('UPDATE oauth_states SET expires_at=?').run('2000-01-01T00:00:00.000Z');
  const expiryResult = await request(context.transport, `/auth/google/callback?state=${encodeURIComponent(expired.state)}&code=provider-code`, { headers: { cookie: expired.cookie } });
  assert.equal(expiryResult.response.status, 400);
});

test('OAuth rejects an ID token with the wrong nonce', async (t) => {
  const context = await startProduction(t, fakeGoogle({ badNonce: true }));
  const started = await begin(context.transport, 'returnTo=%2F');
  const callback = await request(context.transport, `/auth/google/callback?state=${encodeURIComponent(started.state)}&code=provider-code`, { headers: { cookie: started.cookie } });
  assert.equal(callback.response.status, 401);
  assert.deepEqual(callback.data, { error: 'Google sign-in could not be verified.' });
});

test('OAuth requires a verified Google email and the canonical Host', async (t) => {
  const context = await startProduction(t, fakeGoogle({ emailVerified: false }));
  const wrongHost = await request(context.transport, '/api/session', { headers: { host: 'evil.example', 'x-forwarded-host': 'annotated.example' } });
  assert.equal(wrongHost.response.status, 403);
  const forwardedHostIgnored = await request(context.transport, '/api/session', { headers: { host: 'annotated.example', 'x-forwarded-host': 'evil.example' } });
  assert.equal(forwardedHostIgnored.response.status, 200);
  const started = await begin(context.transport, 'returnTo=%2F');
  const callback = await request(context.transport, `/auth/google/callback?state=${encodeURIComponent(started.state)}&code=provider-code`, { headers: { cookie: started.cookie } });
  assert.equal(callback.response.status, 403);
  assert.deepEqual(callback.data, { error: 'Google must provide a verified email address.' });
});

test('an existing production session loses admin access when the allowlist changes', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'annotated-admin-revoke-test-'));
  const options = {
    mode: 'production', baseUrl: PROD_ORIGIN, host: '127.0.0.1', dataDir,
    googleClientId: 'test-client.apps.googleusercontent.com', googleClientSecret: 'test-secret',
    extensionIds: [EXTENSION_ID], googleProvider: fakeGoogle(), seed: false,
  };
  const first = createServer({ ...options, adminEmails: ['admin@example.test'] });
  await new Promise((resolve, reject) => { first.once('error', reject); first.listen(0, '127.0.0.1', resolve); });
  const firstTransport = `http://127.0.0.1:${first.address().port}`;
  const started = await begin(firstTransport, 'returnTo=%2F');
  const callback = await request(firstTransport, `/auth/google/callback?state=${encodeURIComponent(started.state)}&code=provider-code`, { headers: { cookie: started.cookie } });
  const sessionCookie = cookieValue(callback.response, 'annotated_session');
  await new Promise((resolve, reject) => first.close((error) => error ? reject(error) : resolve()));

  const second = createServer({ ...options, adminEmails: ['another-admin@example.test'] });
  await new Promise((resolve, reject) => { second.once('error', reject); second.listen(0, '127.0.0.1', resolve); });
  const secondTransport = `http://127.0.0.1:${second.address().port}`;
  t.after(async () => {
    await new Promise((resolve, reject) => second.close((error) => error ? reject(error) : resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  });
  const session = await request(secondTransport, '/api/session', { headers: { cookie: sessionCookie, origin: PROD_ORIGIN } });
  assert.equal(session.data.user.isAdmin, false);
  const claims = await request(secondTransport, '/api/admin/claims', { headers: { cookie: sessionCookie, origin: PROD_ORIGIN } });
  assert.equal(claims.response.status, 403);
});

test('extension OAuth binds a one-use short grant to allowlisted origin and S256 verifier', async (t) => {
  const context = await startProduction(t);
  const verifier = 'extension-verifier-with-at-least-forty-three-random-characters';
  const rejectedStart = await begin(context.transport, `extensionId=${EXTENSION_ID}&codeChallenge=${challenge(verifier)}`);
  const rejectedCallback = await request(context.transport, `/auth/google/callback?state=${encodeURIComponent(rejectedStart.state)}&code=google-code`, { headers: { cookie: rejectedStart.cookie } });
  const rejectedGrant = new URL(rejectedCallback.response.headers.get('location')).searchParams.get('code');
  const badVerifier = await request(context.transport, '/api/auth/extension/exchange', {
    method: 'POST', headers: { origin: `chrome-extension://${EXTENSION_ID}` }, json: { code: rejectedGrant, codeVerifier: `${verifier}-wrong` },
  });
  assert.equal(badVerifier.response.status, 401);
  const consumedAfterBadVerifier = await request(context.transport, '/api/auth/extension/exchange', {
    method: 'POST', headers: { origin: `chrome-extension://${EXTENSION_ID}` }, json: { code: rejectedGrant, codeVerifier: verifier },
  });
  assert.equal(consumedAfterBadVerifier.response.status, 401);

  const started = await begin(context.transport, `extensionId=${EXTENSION_ID}&codeChallenge=${challenge(verifier)}`);
  const callback = await request(context.transport, `/auth/google/callback?state=${encodeURIComponent(started.state)}&code=google-code`, { headers: { cookie: started.cookie } });
  assert.equal(callback.response.status, 302);
  const extensionRedirect = new URL(callback.response.headers.get('location'));
  assert.equal(extensionRedirect.origin, `https://${EXTENSION_ID}.chromiumapp.org`);
  assert.equal(extensionRedirect.pathname, '/annotated');
  assert.ok(extensionRedirect.searchParams.get('code'));
  assert.equal(extensionRedirect.searchParams.size, 1);
  const grant = extensionRedirect.searchParams.get('code');

  const hostile = await request(context.transport, '/api/auth/extension/exchange', {
    method: 'POST', headers: { origin: 'chrome-extension://pppppppppppppppppppppppppppppppp' }, json: { code: grant, codeVerifier: verifier },
  });
  assert.equal(hostile.response.status, 403);
  const exchanged = await request(context.transport, '/api/auth/extension/exchange', {
    method: 'POST', headers: { origin: `chrome-extension://${EXTENSION_ID}` }, json: { code: grant, codeVerifier: verifier },
  });
  assert.equal(exchanged.response.status, 200);
  assert.match(exchanged.data.token, /^[A-Za-z0-9_-]+$/);
  assert.equal(exchanged.data.user.isDemo, false);
  const replay = await request(context.transport, '/api/auth/extension/exchange', {
    method: 'POST', headers: { origin: `chrome-extension://${EXTENSION_ID}` }, json: { code: grant, codeVerifier: verifier },
  });
  assert.equal(replay.response.status, 401);

  const expiringStart = await begin(context.transport, `extensionId=${EXTENSION_ID}&codeChallenge=${challenge(verifier)}`);
  const expiringCallback = await request(context.transport, `/auth/google/callback?state=${encodeURIComponent(expiringStart.state)}&code=google-code`, { headers: { cookie: expiringStart.cookie } });
  const expiringGrant = new URL(expiringCallback.response.headers.get('location')).searchParams.get('code');
  context.server.database.prepare('UPDATE extension_grants SET expires_at=?').run('2000-01-01T00:00:00.000Z');
  const expired = await request(context.transport, '/api/auth/extension/exchange', {
    method: 'POST', headers: { origin: `chrome-extension://${EXTENSION_ID}` }, json: { code: expiringGrant, codeVerifier: verifier },
  });
  assert.equal(expired.response.status, 401);
});

test('production disables dev identities/fixtures and refuses a demo-contaminated database', async (t) => {
  const context = await startProduction(t);
  const dev = await request(context.transport, '/api/dev/session', { method: 'POST', headers: { origin: PROD_ORIGIN }, json: { persona: 'mira' } });
  assert.equal(dev.response.status, 404);
  assert.equal((await request(context.transport, '/fixtures/article.html')).response.status, 404);
  assert.equal((await request(context.transport, '/web/fixtures/article.html')).response.status, 404);

  const contaminatedDir = mkdtempSync(join(tmpdir(), 'annotated-contaminated-test-'));
  t.after(() => rmSync(contaminatedDir, { recursive: true, force: true }));
  const local = createServer({ dataDir: contaminatedDir, seed: false });
  local.database.close();
  assert.throws(() => createServer({
    mode: 'production', baseUrl: PROD_ORIGIN, dataDir: contaminatedDir,
    googleClientId: 'client', googleClientSecret: 'secret', extensionIds: [EXTENSION_ID],
    adminEmails: ['admin@example.test'], googleProvider: fakeGoogle(), seed: false,
  }), /contains local demo data/);
});


function fakeX(overrides = {}) {
  const provider = fakeGoogle();
  provider.authenticate = async (input) => {
    provider.calls.callbacks.push(input);
    if (overrides.error) throw new Error('private-x-token-must-not-leak');
    return { subject: '1234567890123456789', name: 'X Reader', username: 'x_reader', ...overrides };
  };
  return provider;
}

for (const provider of ['google', 'x']) {
  test(`legacy ${provider} extension sign-in uses old callback and exchanges on the old API host`, async (t) => {
    const canonical = provider === 'google' ? fakeGoogle({ subject: 'canonical-account' }) : fakeX({ subject: '2222222222222222222' });
    const legacy = provider === 'google' ? fakeGoogle({ subject: 'legacy-account' }) : fakeX({ subject: '1111111111111111111' });
    const context = await startProduction(t, provider === 'google' ? canonical : fakeGoogle(), provider === 'x' ? canonical : null, {
      legacyBaseUrl: LEGACY_ORIGIN,
      legacyGoogleProvider: provider === 'google' ? legacy : undefined,
      legacyXProvider: provider === 'x' ? legacy : undefined,
    });
    const verifier = 'legacy-extension-verifier-with-at-least-forty-three-characters';
    const query = `extensionId=${EXTENSION_ID}&codeChallenge=${challenge(verifier)}`;
    const oldHost = { host: new URL(LEGACY_ORIGIN).host };
    const started = await begin(context.transport, query, provider, oldHost);
    assert.equal(legacy.calls.starts.length, 1);
    assert.equal(canonical.calls.starts.length, 0);
    const callback = await request(context.transport, `/auth/${provider}/callback?state=${started.state}&code=old-extension-code`, {
      headers: { ...oldHost, cookie: started.cookie },
    });
    assert.equal(callback.response.status, 302);
    assert.equal(legacy.calls.callbacks.length, 1);
    assert.equal(canonical.calls.callbacks.length, 0);
    assert.equal(callback.response.headers.getSetCookie().some(value => value.startsWith('annotated_session=')), false);
    const target = new URL(callback.response.headers.get('location'));
    assert.equal(target.origin, `https://${EXTENSION_ID}.chromiumapp.org`);
    const origin = `chrome-extension://${EXTENSION_ID}`;
    const grant = { code: target.searchParams.get('code'), codeVerifier: verifier };
    const exchanged = await request(context.transport, '/api/auth/extension/exchange', {
      method: 'POST', headers: { ...oldHost, origin }, json: grant,
    });
    assert.equal(exchanged.response.status, 200);
    assert.equal((await request(context.transport, '/api/auth/extension/exchange', {
      method: 'POST', headers: { ...oldHost, origin }, json: grant,
    })).response.status, 401);
    for (const host of [oldHost.host, new URL(PROD_ORIGIN).host]) {
      const session = await request(context.transport, '/api/session', {
        headers: { host, origin, authorization: `Bearer ${exchanged.data.token}` },
      });
      assert.equal(session.response.status, 200);
      assert.equal(session.data.user.id, exchanged.data.user.id);
    }
    const fresh = await begin(context.transport, query, provider);
    const freshCallback = await request(context.transport, `/auth/${provider}/callback?state=${fresh.state}&code=new-extension-code`, {
      headers: { cookie: fresh.cookie },
    });
    assert.equal(freshCallback.response.status, 302);
    assert.equal(canonical.calls.starts.length, 1);
    assert.equal(canonical.calls.callbacks.length, 1);
    assert.equal(legacy.calls.callbacks.length, 1);
  });
}

test('X is unavailable until both credentials are configured; web provider choice is served', async (t) => {
  assert.throws(() => loadConfig({ X_CLIENT_ID: 'private-client-value' }), error => /configured together/.test(error.message) && !error.message.includes('private-client-value'));
  const context = await startProduction(t);
  const session = await request(context.transport, '/api/session');
  assert.deepEqual(session.data.authProviders, { google: true, x: false });
  assert.equal((await request(context.transport, '/auth/x/start')).response.status, 503);
  assert.equal((await request(context.transport, '/signin')).response.status, 200);
  const google = await begin(context.transport, 'returnTo=%2Finstall');
  assert.ok(google.state);
});

test('X web sign-in preserves provider identity, supports return paths, and never infers admin or links Google', async (t) => {
  const claims = { name: 'Avery Reviewer', email: 'admin@example.test', emailVerified: true };
  const x = fakeX(claims);
  const context = await startProduction(t, fakeGoogle({ subject: '1234567890123456789' }), x);
  assert.deepEqual((await request(context.transport, '/api/session')).data.authProviders, { google: true, x: true });
  const google = await begin(context.transport, '');
  await request(context.transport, `/auth/google/callback?state=${google.state}&code=google-code`, { headers: { cookie: google.cookie } });
  const started = await begin(context.transport, 'returnTo=%2Fa%2Ftest-receipt', 'x');
  assert.match(started.authorization.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  const callback = await request(context.transport, `/auth/x/callback?state=${started.state}&code=x-code`, { headers: { cookie: started.cookie } });
  assert.equal(callback.response.status, 302);
  assert.equal(callback.response.headers.get('location'), '/a/test-receipt');
  assert.match(callback.response.headers.getSetCookie()[0], /Path=\/auth\/x; Max-Age=0/);
  const cookie = cookieValue(callback.response, 'annotated_session');
  const session = await request(context.transport, '/api/session', { headers: { cookie } });
  assert.match(session.data.user.id, /^x-/);
  assert.equal(session.data.user.name, 'Avery Reviewer');
  assert.equal(session.data.user.isAdmin, false);
  assert.equal((await request(context.transport, '/api/admin/claims', { headers: { cookie } })).response.status, 403);
  const stored = context.server.database.prepare('SELECT * FROM users WHERE id=?').get(session.data.user.id);
  assert.equal(stored.email, null);
  assert.equal(stored.provider_subject, 'x:1234567890123456789');
  assert.equal(context.server.database.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  assert.equal(challenge(x.calls.callbacks[0].codeVerifier), started.authorization.searchParams.get('code_challenge'));
  claims.name = 'Renamed X Reader';
  const again = await begin(context.transport, '', 'x');
  const second = await request(context.transport, `/auth/x/callback?state=${again.state}&code=second-code`, { headers: { cookie: again.cookie } });
  const returned = await request(context.transport, '/api/session', { headers: { cookie: cookieValue(second.response, 'annotated_session') } });
  assert.equal(returned.data.user.id, session.data.user.id);
  assert.equal(returned.data.user.name, 'Renamed X Reader');
  assert.equal(context.server.database.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
});

test('X callbacks bind browser and provider; cancel, expiry and replay cannot authenticate', async (t) => {
  const context = await startProduction(t, fakeGoogle(), fakeX());
  const started = await begin(context.transport, '', 'x');
  const path = `/auth/x/callback?state=${started.state}&code=x-code`;
  assert.equal((await request(context.transport, path)).response.status, 400);
  assert.equal((await request(context.transport, path, { headers: { cookie: 'annotated_oauth=other-browser' } })).response.status, 400);
  assert.equal((await request(context.transport, path.replace('/x/', '/google/'), { headers: { cookie: started.cookie } })).response.status, 400);
  assert.equal((await request(context.transport, path, { headers: { cookie: started.cookie } })).response.status, 302);
  assert.equal((await request(context.transport, path, { headers: { cookie: started.cookie } })).response.status, 400);
  const google = await begin(context.transport, '');
  assert.equal((await request(context.transport, `/auth/x/callback?state=${google.state}&code=x-code`, { headers: { cookie: google.cookie } })).response.status, 400);
  const cancelled = await begin(context.transport, '', 'x');
  const denied = await request(context.transport, `/auth/x/callback?state=${cancelled.state}&error=access_denied`, { headers: { cookie: cancelled.cookie } });
  assert.equal(denied.response.status, 400);
  assert.match(denied.response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request(context.transport, `/auth/x/callback?state=${cancelled.state}&code=x-code`, { headers: { cookie: cancelled.cookie } })).response.status, 400);
  const expired = await begin(context.transport, '', 'x');
  context.server.database.prepare('UPDATE oauth_states SET expires_at=?').run('2000-01-01T00:00:00.000Z');
  assert.equal((await request(context.transport, `/auth/x/callback?state=${expired.state}&code=x-code`, { headers: { cookie: expired.cookie } })).response.status, 400);
  assert.equal((await request(context.transport, '/auth/x/start?returnTo=https://evil.example')).response.status, 400);
});

test('X extension sign-in uses an exact callback and single-use PKCE grant, with no web session or provider token', async (t) => {
  const context = await startProduction(t, fakeGoogle(), fakeX());
  const verifier = 'x'.repeat(64);
  const started = await begin(context.transport, `extensionId=${EXTENSION_ID}&codeChallenge=${challenge(verifier)}`, 'x');
  const callback = await request(context.transport, `/auth/x/callback?state=${started.state}&code=x-code`, { headers: { cookie: started.cookie } });
  assert.equal(callback.response.status, 302);
  assert.doesNotMatch(callback.response.headers.get('set-cookie'), /annotated_session/);
  const target = new URL(callback.response.headers.get('location'));
  assert.equal(target.origin, `https://${EXTENSION_ID}.chromiumapp.org`);
  assert.equal(target.pathname, '/annotated');
  assert.equal([...target.searchParams].length, 1);
  const code = target.searchParams.get('code');
  const origin = `chrome-extension://${EXTENSION_ID}`;
  const body = { code, codeVerifier: verifier };
  const exchanged = await request(context.transport, '/api/auth/extension/exchange', { method: 'POST', headers: { origin }, json: body });
  assert.equal(exchanged.response.status, 200);
  assert.match(exchanged.data.user.id, /^x-/);
  assert.ok(exchanged.data.token);
  assert.equal((await request(context.transport, '/api/auth/extension/exchange', { method: 'POST', headers: { origin }, json: body })).response.status, 401);
  const session = await request(context.transport, '/api/session', { headers: { origin, authorization: `Bearer ${exchanged.data.token}` } });
  assert.equal(session.data.user.id, exchanged.data.user.id);
  assert.equal((await request(context.transport, '/api/session')).data.user, null);
});

test('X provider failures do not leak credentials or establish a session', async (t) => {
  const context = await startProduction(t, fakeGoogle(), fakeX({ error: true }));
  const started = await begin(context.transport, '', 'x');
  const failed = await request(context.transport, `/auth/x/callback?state=${started.state}&code=x-code`, { headers: { cookie: started.cookie } });
  assert.equal(failed.response.status, 401);
  assert.doesNotMatch(JSON.stringify(failed.data), /private-x-token|test-x-secret|x-code/);
  assert.equal(context.server.database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});
