const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const PRIVATE_QUERY_KEY = /^(token|access_token|auth|authorization|key|api_key|password|secret|signature|sig|session|sessionid)$/i;

function splitTrailingPunctuation(value) {
  let end = value.length;
  while (end > 0) {
    const last = value[end - 1];
    if (/[.,!?;:’”]/.test(last)) { end--; continue; }
    const pair = { ')': '(', ']': '[', '}': '{' }[last];
    if (!pair) break;
    const candidate = value.slice(0, end);
    const opens = [...candidate].filter((character) => character === pair).length;
    const closes = [...candidate].filter((character) => character === last).length;
    if (closes <= opens) break;
    end--;
  }
  return [value.slice(0, end), value.slice(end)];
}

function safeHref(value) {
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    if ([...url.searchParams.keys()].some((key) => PRIVATE_QUERY_KEY.test(key))) return null;
    return url.href;
  } catch { return null; }
}

export function commentaryParts(value) {
  const text = String(value || '');
  const parts = [];
  const addText = (value) => {
    if (!value) return;
    if (parts.length && !parts.at(-1).href) parts.at(-1).text += value;
    else parts.push({ text: value });
  };
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    if (start > 0 && /[\w@:/]/.test(text[start - 1])) continue;
    const [visible, trailing] = splitTrailingPunctuation(match[0]);
    const href = safeHref(visible);
    if (!href) continue;
    if (start > cursor) addText(text.slice(cursor, start));
    parts.push({ text: visible, href });
    cursor = start + visible.length;
    if (trailing) addText(trailing);
    cursor += trailing.length;
  }
  addText(text.slice(cursor));
  if (!parts.length) parts.push({ text: '' });
  return parts;
}

// Short presentation only; the full validated destination remains in href/title.
export function supportingLinkLabel(value) {
  const label = String(value).replace(/^https?:\/\/(?:www\.)?/i, '');
  const characters = Array.from(label);
  return characters.length > 44 ? characters.slice(0, 43).join('') + '…' : label;
}
