// Text fragments are interpreted by the destination browser. If no passage
// matches, the original page (and any existing element anchor) still opens.
function textDirective(passage) {
  const text = passage.trim().replace(/\s+/g, ' ');
  const encode = value => encodeURIComponent(value).replace(/[!'()*-]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const words = text.split(' ');
  // A single textStart cannot cross paragraph boundaries. Range endpoints let
  // longer selections span blocks without including omitted text between quotes.
  return words.length > 12
    ? `${encode(words.slice(0, 6).join(' '))},${encode(words.slice(-6).join(' '))}`
    : encode(text);
}

export function sourceHref(source, start = 0, passages = []) {
  try {
    const url = new URL(source.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '#';
    if ((url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com')) && url.searchParams.get('v')) {
      url.searchParams.set('t', `${Math.floor(Math.max(0, Number(start) || 0))}s`);
    } else if (source.kind === 'article') {
      const quotes = [...new Set(passages.filter(value => typeof value === 'string').map(value => value.trim().replace(/\s+/g, ' ')).filter(Boolean))];
      if (quotes.length) {
        const anchor = url.hash.slice(1).split(':~:')[0];
        url.hash = `${anchor}:~:${quotes.map(quote => `text=${textDirective(quote)}`).join('&')}`;
      }
    }
    return url.href;
  } catch { return '#'; }
}
