// X OAuth 2.0 is used only to establish identity. No provider token is persisted.
export function createXProvider(config, fetchImpl = fetch) {
  const redirectUri = `${config.baseUrl}/auth/x/callback`;
  const credentials = Buffer.from(`${config.xClientId}:${config.xClientSecret}`).toString('base64');
  async function request(url, options) {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('X authentication request failed.');
    return response.json();
  }
  return {
    authorizationUrl({ state, codeChallenge }) {
      const url = new URL('https://x.com/i/oauth2/authorize');
      url.search = new URLSearchParams({
        response_type: 'code', client_id: config.xClientId, redirect_uri: redirectUri,
        scope: 'tweet.read users.read', state, code_challenge: codeChallenge, code_challenge_method: 'S256',
      }).toString();
      return url.href;
    },
    async authenticate({ code, codeVerifier }) {
      const tokens = await request('https://api.x.com/2/oauth2/token', {
        method: 'POST',
        headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier }),
      });
      if (typeof tokens.access_token !== 'string' || !tokens.access_token || String(tokens.token_type).toLowerCase() !== 'bearer') {
        throw new Error('X did not return a valid access token.');
      }
      const { data } = await request('https://api.x.com/2/users/me', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (typeof data?.id !== 'string' || !/^\d{1,20}$/.test(data.id) || typeof data.name !== 'string' || !data.name.trim()) {
        throw new Error('X did not return a valid account.');
      }
      return { subject: data.id, name: data.name, username: data.username };
    },
  };
}
