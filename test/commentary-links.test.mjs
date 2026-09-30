import test from 'node:test';
import assert from 'node:assert/strict';
import { commentaryParts, supportingLinkLabel } from '../web/commentary-links.js';

test('supporting URLs keep surrounding prose and punctuation readable', () => {
  assert.deepEqual(commentaryParts('Read (https://example.test/a_(b)). Then https://example.test/next?x=1!'), [
    { text: 'Read (' },
    { text: 'https://example.test/a_(b)', href: 'https://example.test/a_(b)' },
    { text: '). Then ' },
    { text: 'https://example.test/next?x=1', href: 'https://example.test/next?x=1' },
    { text: '!' }
  ]);
});

test('unsafe or private URLs remain plain text', () => {
  const text = 'javascript:https://evil.test https://user:pass@example.test/ https://example.test/?token=private ftp://example.test';
  assert.deepEqual(commentaryParts(text), [{ text }]);
});

test('commentary text is passed through without HTML interpretation', () => {
  assert.deepEqual(commentaryParts('<img src=x> https://example.test/&x=1'), [
    { text: '<img src=x> ' },
    { text: 'https://example.test/&x=1', href: 'https://example.test/&x=1' }
  ]);
});

test('supporting link labels shorten display only and count code points', () => {
  assert.equal(supportingLinkLabel('https://www.example.test/report'), 'example.test/report');
  const original = 'https://www.example.test/' + '😀'.repeat(50);
  const label = supportingLinkLabel(original);
  assert.equal(Array.from(label).length, 44);
  assert.ok(label.endsWith('…'));
  assert.equal(commentaryParts(original)[0].text, original);
  assert.equal(commentaryParts(original)[0].href, new URL(original).href);
});
