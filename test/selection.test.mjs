import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('selected article text survives focus loss, but never follows navigation or private fields', async () => {
  const source = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8');
  let selection = null;
  let receive;
  let privateField = false;
  const events = {};
  const location = { href: 'https://example.test/article-one', hostname: 'example.test' };
  const select = (text, { privateContainer = false } = {}) => {
    selection = {
      isCollapsed: !text, rangeCount: text ? 1 : 0,
      getRangeAt: () => ({
        commonAncestorContainer: { nodeType: 1, closest: () => privateContainer ? {} : null },
        intersectsNode: () => privateField
      }),
      toString: () => text
    };
    events.selectionchange();
  };
  runInNewContext(source, {
    location, Node: { ELEMENT_NODE: 1 }, getSelection: () => selection,
    document: {
      title: 'Source title stays attribution',
      addEventListener(name, callback) { events[name] = callback; },
      querySelector: () => null,
      querySelectorAll: (selector) => selector.startsWith('input,') && privateField ? [{}] : []
    },
    chrome: { runtime: { onMessage: { addListener(callback) { receive = callback; } } } }
  });
  const snapshot = () => new Promise((resolve) => receive({ type: 'ANNOTATED_DISCOVER' }, {}, ({ result }) => resolve(result)));
  assert.equal((await snapshot()).excerpt, '');
  select('The exact sentence the reader highlighted.');
  select(''); // Clicking into the side panel can clear the live DOM selection.
  assert.equal((await snapshot()).excerpt, 'The exact sentence the reader highlighted.');
  assert.equal((await snapshot()).title, 'Source title stays attribution');
  location.href = 'https://example.test/article-two';
  assert.equal((await snapshot()).excerpt, '');
  select('A new public passage.');
  select('Private form data', { privateContainer: true });
  assert.equal((await snapshot()).excerpt, '');
  select('A public passage again.');
  privateField = true; // A selection spanning a form is blocked as well.
  select('Mixed public and private content');
  assert.equal((await snapshot()).excerpt, '');
});
