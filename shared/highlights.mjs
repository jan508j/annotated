export const MAX_HIGHLIGHTS = 5;

export function validateHighlights(values) {
  if (!Array.isArray(values) || values.length > MAX_HIGHLIGHTS) throw new Error('Attach up to 5 highlights from this source.');
  const excerpts = values.map(value => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Each highlight must contain text.');
    return value.trim().replace(/\s+/g, ' ');
  });
  if (new Set(excerpts).size !== excerpts.length) throw new Error('That highlight is already attached.');
  if (excerpts.reduce((count, text) => count + text.split(/\s+/).length, 0) > 100) throw new Error('Keep all highlights together within 100 words.');
  if (joinedHighlights(excerpts).length > 2000) throw new Error('Keep all highlights together within 2000 characters.');
  return excerpts;
}

// The legacy field remains readable and marks omitted text explicitly.
export function joinedHighlights(excerpts) { return excerpts.join('\n\n[…]\n\n'); }

export function storedHighlights(row) {
  if (row.excerpts_json != null) return JSON.parse(row.excerpts_json);
  return row.excerpt ? [row.excerpt] : [];
}
