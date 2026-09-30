import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { canonicalSource } from '../shared/source.mjs';
import { cleanPublisher } from '../shared/source-identity.mjs';

const TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const ERROR_MESSAGE = 'Could not read a title from that URL.';

function unavailable() {
  return new Error(ERROR_MESSAGE);
}

function inRange(value, base, prefix, bits) {
  return (value >> BigInt(bits - prefix)) === (base >> BigInt(bits - prefix));
}

function ipv4Value(address) {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((value, part) => (value << 8n) + BigInt(part), 0n);
}

function ipv6Value(address) {
  const mapped = address.toLowerCase();
  const tail = mapped.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (tail) {
    const value = ipv4Value(tail);
    if (value === null) return null;
    address = `${address.slice(0, -tail.length)}${(value >> 16n).toString(16)}:${(value & 0xffffn).toString(16)}`;
  }
  const sides = address.toLowerCase().split('::');
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides[1] ? sides[1].split(':') : [];
  const fill = 8 - left.length - right.length;
  if (fill < 0 || (sides.length === 1 && fill !== 0)) return null;
  const parts = [...left, ...Array(fill).fill('0'), ...right];
  if (parts.length !== 8 || parts.some(part => !/^[\da-f]{1,4}$/.test(part))) return null;
  return parts.reduce((value, part) => (value << 16n) + BigInt(`0x${part}`), 0n);
}

function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Value(address);
    if (value === null) return false;
    const blocked = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
      ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
      ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4]
    ];
    return !blocked.some(([base, prefix]) => inRange(value, ipv4Value(base), prefix, 32));
  }
  if (family === 6) {
    const value = ipv6Value(address);
    if (value === null) return false;
    // Mapped IPv4 and transition ranges can otherwise hide private IPv4 targets.
    const mapped = value >> 32n;
    if (mapped === 0xffffn) {
      const v4 = value & 0xffffffffn;
      return publicAddress([24n, 16n, 8n, 0n].map(shift => Number((v4 >> shift) & 255n)).join('.'));
    }
    const global = ipv6Value('2000::');
    if (!inRange(value, global, 3, 128)) return false;
    const blocked = [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]];
    return !blocked.some(([base, prefix]) => inRange(value, ipv6Value(base), prefix, 128));
  }
  return false;
}

function parseUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw unavailable();
  let url;
  try {
    canonicalSource(value);
    url = new URL(value);
  } catch { throw unavailable(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw unavailable();
  // canonicalSource normalizes YouTube links before checking their query, so check it here too.
  if ([...url.searchParams.keys()].some(key => /^(token|access_token|auth|authorization|key|api_key|password|secret|signature|sig|session|sessionid)$/i.test(key))) throw unavailable();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (port !== (url.protocol === 'https:' ? '443' : '80')) throw unavailable();
  url.hash = '';
  return url;
}

async function pinAddress(url, resolveHostname) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await resolveHostname(host, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(item =>
    !item || !publicAddress(item.address) || item.family !== isIP(item.address))) throw unavailable();
  return { host, ...addresses[0] };
}

function readResponse(url, pinned, { request, signal, maxBytes }) {
  return new Promise((resolve, reject) => {
    const transport = request || (url.protocol === 'https:' ? https.request : http.request);
    const options = {
      protocol: url.protocol,
      hostname: pinned.host,
      port: url.protocol === 'https:' ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { Accept: 'text/html, application/xhtml+xml' },
      agent: false,
      autoSelectFamily: false,
      signal,
      lookup(host, lookupOptions, callback) {
        if (host !== pinned.host) return callback(unavailable());
        if (lookupOptions?.all) return callback(null, [{ address: pinned.address, family: pinned.family }]);
        callback(null, pinned.address, pinned.family);
      }
    };
    let req;
    try { req = transport(options, response => {
      const statusCode = response.statusCode || 0;
      const headers = response.headers || {};
      if (statusCode >= 300 && statusCode < 400) {
        response.destroy();
        resolve({ statusCode, headers, body: '' });
        return;
      }
      if (statusCode !== 200 || !/^\s*(text\/html|application\/xhtml\+xml)\s*(?:;|$)/i.test(headers['content-type'] || '')) {
        response.destroy();
        reject(unavailable());
        return;
      }
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > maxBytes) {
          response.destroy();
          reject(unavailable());
          return;
        }
        chunks.push(chunk);
        const partial = Buffer.concat(chunks).toString('utf8');
        if (/<\/head\s*>|<body(?:\s|>)/i.test(partial)) {
          response.destroy();
          resolve({ statusCode, headers, body: partial });
        }
      });
      response.on('end', () => resolve({ statusCode, headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', () => reject(unavailable()));
    }); } catch { reject(unavailable()); return; }
    req.on('error', () => reject(unavailable()));
    req.end();
  });
}

const ENTITIES = {
  amp: '&', apos: "'", quot: '"', lt: '<', gt: '>', nbsp: ' ',
  copy: '©', reg: '®', trade: '™', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…'
};

function decodeEntities(value) {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (match, entity) => {
    if (entity.startsWith('#')) {
      const hex = entity[1]?.toLowerCase() === 'x';
      const number = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
        ? String.fromCodePoint(number) : '�';
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function titleFromHtml(html) {
  const head = html.split(/<\/head\s*>|<body(?:\s|>)/i, 1)[0]
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const match = head.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i);
  return match ? decodeEntities(match[1]).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, 300) : '';
}

function publisherFromHtml(html) {
  const head = html.split(/<\/head\s*>|<body(?:\s|>)/i, 1)[0].replace(/<!--[\s\S]*?-->/g, '');
  const metadata = head.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  for (const tag of metadata.match(/<meta\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi) || []) {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
      .map(([, name, double, single, bare]) => [name.toLowerCase(), double ?? single ?? bare]));
    if (attributes.property?.toLowerCase() !== 'og:site_name') continue;
    const publisher = cleanPublisher(decodeEntities(attributes.content || ''));
    if (publisher) return publisher;
  }
  for (const match of head.matchAll(/<script\b(?=[^>]*\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json))[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    let data;
    try { data = JSON.parse(match[1]); } catch { continue; }
    const queue = Array.isArray(data) ? [...data] : [data];
    while (queue.length) {
      const item = queue.shift();
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const publisher = item.publisher;
      const names = Array.isArray(publisher) ? publisher : [publisher];
      for (const candidate of names) {
        const name = cleanPublisher(candidate?.name);
        if (name) return name;
      }
      if (Array.isArray(item['@graph'])) queue.push(...item['@graph']);
    }
  }
  return '';
}

/** Fetch bounded title and publisher metadata from a public HTTP(S) HTML page. Throws a safe user-facing Error. */
export async function fetchSourcePreview(value, { resolveHostname = dnsLookup, request, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(unavailable()), { once: true }));
  try {
    const run = async () => {
      let url = parseUrl(value);
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        const pinned = await pinAddress(url, resolveHostname);
        if (controller.signal.aborted) throw unavailable();
        const response = await readResponse(url, pinned, { request, signal: controller.signal, maxBytes });
        if (response.statusCode >= 300 && response.statusCode < 400) {
          if (redirects === MAX_REDIRECTS || typeof response.headers.location !== 'string') throw unavailable();
          try { url = parseUrl(new URL(response.headers.location, url).href); } catch { throw unavailable(); }
          continue;
        }
        const publisher = publisherFromHtml(response.body);
        return { url: url.href, title: titleFromHtml(response.body), ...(publisher ? { publisher } : {}) };
      }
      throw unavailable();
    };
    return await Promise.race([run(), aborted]);
  } catch {
    throw unavailable();
  } finally {
    clearTimeout(timer);
  }
}
