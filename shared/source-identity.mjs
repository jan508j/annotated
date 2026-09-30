function clean(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

export function cleanPublisher(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/gu, ' ').replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim().slice(0, 100).trim();
}

export function sourceExcerpts(annotation = {}) {
  const items = Array.isArray(annotation.excerpts)
    ? annotation.excerpts : [annotation.excerpt];
  return items.map(clean).filter(Boolean);
}

export function sourceIdentity(source = {}) {
  let host = '';
  let path = '';
  try {
    const url = new URL(source.url);
    host = url.hostname.toLowerCase().replace(/^www\./u, '');
    path = url.pathname;
  } catch { /* Older records may have no usable URL. */ }
  const isX = (host === 'x.com' || host === 'twitter.com' || host === 'mobile.twitter.com') && /^\/[A-Za-z0-9_]+\/status\/\d+/u.test(path);
  const isYouTube = host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
  const handle = isX ? `@${path.split('/')[1]}` : '';
  const titleAuthor = isX ? /^\s*(?:\(\d+\)\s*)?(.{1,80}?)\s+on\s+(?:X|Twitter)\s*:/iu.exec(clean(source.title))?.[1] : '';
  const author = clean(source.author) || clean(titleAuthor) || handle;
  const publisher = isX ? 'X' : isYouTube ? 'YouTube'
    : cleanPublisher(source.publisher) || (host === 'reuters.com' || host.endsWith('.reuters.com') ? 'Reuters' : host || 'Source');
  const badge = isYouTube ? '▶' : isX ? 'X' : publisher === 'Reuters' ? 'R' : publisher.slice(0, 1).toUpperCase();
  return { platform: isX ? 'x' : isYouTube ? 'youtube' : 'web', publisher, badge, author, handle };
}

export function displaySourceTitle(source = {}) {
  const identity = sourceIdentity(source);
  let title = clean(source.title);
  if (identity.platform === 'x') {
    title = title.replace(/^\s*(?:\(\d+\)\s*)?.{1,80}?\s+on\s+(?:X|Twitter)\s*:\s*/iu, '')
      .replace(/\s+[\/|·–—-]\s*(?:X|Twitter)\s*$/iu, '')
      .replace(/^['“"]|['”"]$/gu, '');
  } else if (identity.publisher !== 'Source') {
    const escaped = identity.publisher.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    title = title.replace(new RegExp(`\\s+[|·–—-]\\s*${escaped}\\s*$`, 'iu'), '');
  }
  title = title.replace(/^\(\d+\)\s*/u, '').trim();
  return title || (identity.platform === 'x' ? `Post by ${identity.author || identity.handle || 'an X user'}` : 'Untitled source');
}

// Conservatively budget non-ASCII text and possible links for X's 280-character
// limit. Keep graphemes and links intact; emoji sequences can leave spare room.
function shareExcerpt(value, budget) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const weight = text => Array.from(text).reduce((sum, char) => sum + (char.codePointAt(0) < 128 ? 1 : 2), 0);
  const units = clean(value).normalize('NFC').split(/(\s+)/u).flatMap(word => {
    const possibleLink = /https?:\/\/|[\p{L}\p{N}]\.[\p{L}\p{N}]/iu.test(word);
    return possibleLink ? [{ text: word, weight: Math.max(23, weight(word)) }]
      : Array.from(segmenter.segment(word), ({ segment }) => ({ text: segment, weight: weight(segment) }));
  });
  const total = units.reduce((sum, unit) => sum + unit.weight, 0);
  if (total <= budget) return { text: units.map(unit => unit.text).join(''), weight: total };
  let text = '';
  let used = 0;
  for (const unit of units) {
    if (used + unit.weight > budget - 2) break;
    text += unit.text;
    used += unit.weight;
  }
  return { text: `${text.trimEnd()}…`, weight: used + 2 };
}

export function xShareIntent(annotation = {}, permalink) {
  const source = annotation.source || {};
  const context = shareExcerpt(`On ${sourceIdentity(source).publisher}: ${displaySourceTitle(source)}`, 72);
  // The annotation URL consumes 23 characters on X, plus four line breaks.
  const take = shareExcerpt(clean(annotation.commentary) || (annotation.voiceUrl ? 'A voice take.' : 'A source annotation.'), 280 - 23 - 4 - context.weight);
  const intent = new URL('https://x.com/intent/post');
  intent.searchParams.set('text', `${take.text}\n\n${context.text}\n\n${permalink}`);
  return intent.href;
}
