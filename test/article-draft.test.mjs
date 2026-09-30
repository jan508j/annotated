import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedArticle, readArticleDraft, saveArticleDraft, clearArticleDraft, emptyArticle, DRAFT_TTL } from '../shared/article-draft.mjs';

function memory() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
test('shared source and quote stay distinct; plain quotes and multiple links do not invent a source', () => {
  assert.deepEqual(sharedArticle(new URLSearchParams({ text: 'A precise passage.\nhttps://example.com/article?utm_source=share', title: 'Original title' })), { url: 'https://example.com/article', title: 'Original title', excerpt: 'A precise passage.', commentary: '' });
  assert.equal(sharedArticle(new URLSearchParams({ text: 'A quote with no source attached.' })).url, '');
  assert.equal(sharedArticle(new URLSearchParams({ text: 'https://one.example/a https://two.example/b' })).url, '');
  assert.equal(sharedArticle(new URLSearchParams({ url: 'https://example.com/', text: 'Page title', title: 'Page title' })).excerpt, '');
  assert.equal(sharedArticle(new URLSearchParams({ text: 'Story title https://example.com/story', title: 'Story title' })).excerpt, '');
  assert.equal(sharedArticle(new URLSearchParams({ text: 'An actual quote. https://example.com/story', title: 'Story title' })).excerpt, 'An actual quote.');
  assert.throws(() => sharedArticle(new URLSearchParams({ url: 'https://example.com/' + 'a'.repeat(2000) })));
  for (const url of ['javascript:alert(1)', 'https://user:password@example.com/', 'https://example.com/?token=private']) assert.throws(() => sharedArticle(new URLSearchParams({ url })));
  assert.throws(() => sharedArticle(new URLSearchParams({ text: 'x'.repeat(12001) })));
});
test('same-tab draft survives sign-in, isolates account identities, expires and clears', () => {
  const storage = memory(), values = { ...emptyArticle(), excerpt: 'My passage', commentary: 'My take' };
  assert.equal(saveArticleDraft(storage, values, null, 'retry-id', 1000), true);
  assert.equal(readArticleDraft(storage, 'google-user', 1100).clientId, 'retry-id');
  saveArticleDraft(storage, values, 'google-user', 'retry-id', 1200);
  assert.deepEqual(readArticleDraft(storage, 'google-user', 1300).values, values);
  assert.equal(readArticleDraft(storage, 'x-user', 1300), null);
  assert.equal(readArticleDraft(storage, null, 1300), null);
  assert.equal(readArticleDraft(storage, 'google-user', 1201 + DRAFT_TTL), null);
  clearArticleDraft(storage);
  assert.equal(readArticleDraft(storage, 'google-user', 1300), null);
  assert.equal(saveArticleDraft(null, values, null, 'retry-id'), false);
  assert.equal(readArticleDraft({ getItem: () => '{bad' }, null), null);
});
