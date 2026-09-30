import test from 'node:test';
import assert from 'node:assert/strict';
import { createXProvider } from '../server/x-auth.mjs';

const config = { baseUrl: 'https://annotated.example', xClientId: 'local-test-client', xClientSecret: 'local-test-secret' };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('X protocol requests only documented identity scopes, S256 PKCE, and the exact server callback', async () => {
  const calls = [];
  const provider = createXProvider(config, async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return response({ token_type: 'bearer', access_token: 'local-test-access-token' });
    return response({ data: { id: '1234567890123456789', name: 'Test X Reader', username: 'test_reader' } });
  });
  const url = new URL(provider.authorizationUrl({ state: 'browser-state', codeChallenge: 'test-challenge' }));
  assert.equal(url.origin + url.pathname, 'https://x.com/i/oauth2/authorize');
  assert.equal(url.searchParams.get('scope'), 'tweet.read users.read');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), config.xClientId);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://annotated.example/auth/x/callback');
  assert.equal(url.searchParams.get('state'), 'browser-state');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'test-challenge');
  assert.ok(!url.href.includes(config.xClientSecret));
  const identity = await provider.authenticate({ code: 'one-use-code', codeVerifier: 'test-verifier' });
  assert.deepEqual(identity, { subject: '1234567890123456789', name: 'Test X Reader', username: 'test_reader' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.x.com/2/oauth2/token');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, `Basic ${Buffer.from('local-test-client:local-test-secret').toString('base64')}`);
  assert.equal(calls[0].options.body.get('grant_type'), 'authorization_code');
  assert.equal(calls[0].options.body.get('code_verifier'), 'test-verifier');
  assert.equal(calls[0].options.body.get('redirect_uri'), 'https://annotated.example/auth/x/callback');
  assert.equal(calls[1].url, 'https://api.x.com/2/users/me');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer local-test-access-token');
  for (const call of calls) {
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test('X rejects failed exchanges, missing tokens and invalid identities without leaking upstream details', async () => {
  for (const bad of [response({ detail: 'private-secret' }, 403), response({}), response({ token_type: 'other', access_token: 'token' })]) {
    let calls = 0;
    const provider = createXProvider(config, async () => { calls++; return bad; });
    await assert.rejects(provider.authenticate({ code: 'code', codeVerifier: 'verifier' }), error => !error.message.includes('private-secret'));
    assert.equal(calls, 1);
  }
  for (const data of [null, { id: 12345, name: 'Not a string ID' }, { id: 'x:123', name: 'Invalid' }, { id: '123', name: '' }]) {
    let calls = 0;
    const provider = createXProvider(config, async () => ++calls === 1
      ? response({ token_type: 'bearer', access_token: 'test-token' }) : response({ data }));
    await assert.rejects(provider.authenticate({ code: 'code', codeVerifier: 'verifier' }), /valid account/);
  }
});
