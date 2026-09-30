import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceHref } from '../web/source-link.js';
import { sourceExcerpts } from '../shared/source-identity.mjs';

test('article source links encode exact passages without changing the source path or query', () => {
  const source = { kind: 'article', url: 'https://example.com/story?chapter=2#section' };
  const text = 'Říká: „well-being, A&B“ — 50%.';
  const link = new URL(sourceHref(source, null, [text]));
  assert.equal(link.origin + link.pathname + link.search, 'https://example.com/story?chapter=2');
  assert.equal(link.hash, '#section:~:text=%C5%98%C3%ADk%C3%A1%3A%20%E2%80%9Ewell%2Dbeing%2C%20A%26B%E2%80%9C%20%E2%80%94%2050%25.');
  assert.deepEqual(source, { kind: 'article', url: 'https://example.com/story?chapter=2#section' });
});

test('one link carries separate highlights and replaces an old text directive', () => {
  const source = { kind: 'article', url: 'https://example.com/story#section:~:text=old' };
  const annotation = { excerpts: ['The first passage.', 'Another\n quoted passage.', 'The first passage.'], excerpt: 'Do not match the omission marker […]' };
  assert.equal(new URL(sourceHref(source, null, sourceExcerpts(annotation))).hash, '#section:~:text=The%20first%20passage.&text=Another%20quoted%20passage.');
  assert.equal(new URL(sourceHref(source, null, sourceExcerpts({ excerpt: 'Legacy quote' }))).hash, '#section:~:text=Legacy%20quote');
});

test('long selections use range endpoints so a passage can cross paragraph boundaries', () => {
  const passage = 'These are the first six words.\nThe selection continues into another paragraph.\nThese are the final six words.';
  assert.equal(new URL(sourceHref({ kind: 'article', url: 'https://example.com/' }, null, [passage])).hash, '#:~:text=These%20are%20the%20first%20six%20words.,These%20are%20the%20final%20six%20words.');
});

test('video timestamps and unquoted source links retain their behavior', () => {
  assert.equal(sourceHref({ kind: 'video', url: 'https://www.youtube.com/watch?v=abcdefghijk' }, 43.8, ['not a quote']), 'https://www.youtube.com/watch?v=abcdefghijk&t=43s');
  assert.equal(sourceHref({ kind: 'video', url: 'https://example.com/video#player' }, 10, ['ignore']), 'https://example.com/video#player');
  assert.equal(sourceHref({ kind: 'article', url: 'https://example.com/story#section' }), 'https://example.com/story#section');
  for (const url of ['javascript:alert(1)', 'file:///secret', 'https://me:secret@example.com/', 'broken']) assert.equal(sourceHref({ kind: 'article', url }, null, ['text']), '#');
});
