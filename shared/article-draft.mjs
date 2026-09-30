import { canonicalSource } from './source.mjs';

export const ARTICLE_DRAFT_KEY = 'annotated:article-draft:v1';
export const DRAFT_TTL = 24 * 60 * 60 * 1000;
export const emptyArticle = () => ({ url: '', title: '', excerpt: '', commentary: '' });
export const hasArticle = values => Object.values(values).some(value => typeof value === 'string' && value.trim());

export function publicArticleUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) throw new Error('Use a public page link within 2,000 characters.');
  return canonicalSource(value.trim()).url;
}

// Plain clipboard text has no trustworthy originating-page metadata. Only use a
// URL that was explicitly included, and leave ambiguous multiple links for review.
export function sharedArticle(params) {
  const read = (key, max) => {
    const value = params.get(key) || '';
    if (value.length > max) throw new Error('That shared text is too long. Paste a shorter passage into the editor.');
    return value.trim();
  };
  let url = read('url', 2000);
  let text = read('excerpt', 12000) || read('text', 12000);
  const title = read('title', 300).replace(/\s+/g, ' ');
  const candidates = [...new Set((text.match(/https?:\/\/[^\s<>"']+/gi) || []).map(value => value.replace(/[.,;!?]+$/, '')))];
  if (!url && candidates.length === 1) url = candidates[0];
  if (url) {
    const original = url;
    url = publicArticleUrl(url);
    // Remove a shared URL on its own line, without changing quoted prose.
    text = text.split('\n').filter(line => line.trim() !== original).join('\n').trim();
    if (text.endsWith(` ${original}`)) text = text.slice(0, -original.length).trim();
    if (text === original || text === url || text === title) text = '';
  }
  return { url, title, excerpt: text, commentary: '' };
}

export function readArticleDraft(storage, userId, time = Date.now()) {
  try {
    const draft = JSON.parse(storage.getItem(ARTICLE_DRAFT_KEY));
    if (!draft || draft.version !== 1 || !Number.isFinite(draft.updatedAt) || time - draft.updatedAt > DRAFT_TTL || draft.updatedAt > time + 60000) return null;
    if (draft.ownerId && draft.ownerId !== userId) return null;
    for (const [key, max] of [['url', 2000], ['title', 300], ['excerpt', 12000], ['commentary', 2000]]) {
      if (typeof draft.values?.[key] !== 'string' || draft.values[key].length > max) return null;
    }
    if (typeof draft.clientId !== 'string' || draft.clientId.length > 100) return null;
    return draft;
  } catch { return null; }
}

export function saveArticleDraft(storage, values, userId, clientId, time = Date.now()) {
  try {
    if (!hasArticle(values)) storage.removeItem(ARTICLE_DRAFT_KEY);
    else storage.setItem(ARTICLE_DRAFT_KEY, JSON.stringify({ version: 1, updatedAt: time, ownerId: userId || null, values, clientId }));
    return true;
  } catch { return false; }
}

export function clearArticleDraft(storage) {
  try { storage.removeItem(ARTICLE_DRAFT_KEY); } catch { /* Storage may be unavailable. */ }
}
