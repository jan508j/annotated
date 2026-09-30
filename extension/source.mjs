export function canonicalSource(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use a public http or https source URL.');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'youtu.be' || hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
    const videoId = hostname === 'youtu.be' ? url.pathname.split('/')[1] : url.searchParams.get('v') || (/^\/(shorts|embed|live)\/([^/]+)/.exec(url.pathname)?.[2]);
    if (videoId && /^[\w-]{11}$/.test(videoId)) return { key: `youtube:${videoId}`, url: `https://www.youtube.com/watch?v=${videoId}` };
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key);
    if (/^(token|access_token|auth|authorization|key|api_key|password|secret|signature|sig|session|sessionid)$/i.test(key)) throw new Error('This source URL contains a private access parameter. Use its public URL.');
  }
  url.searchParams.sort();
  return { key: `web:${url.href}`, url: url.href };
}

export async function sourceKey(raw) {
  const source = canonicalSource(raw);
  if (source.key.startsWith('youtube:')) return source.key;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source.url));
  return `web:v1:${Array.from(new Uint8Array(hash), (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

export function sourceLink(raw, start = 0) {
  const source = canonicalSource(raw);
  if (source.key.startsWith('youtube:')) return `${source.url}&t=${Math.floor(Math.max(0, start))}s`;
  return source.url;
}

export function formatTime(seconds = 0) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return value >= 3600 ? `${Math.floor(value / 3600)}:${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}` : `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}
