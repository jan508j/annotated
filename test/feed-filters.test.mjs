import test from 'node:test';
import assert from 'node:assert/strict';
import { readFeedFilters, feedPath, radioStep, filteredEmpty, feedStatus } from '../web/feed-filters.js';

test('feed URLs restore canonical and older links with clean defaults', () => {
  assert.deepEqual(readFeedFilters(''), { audience: 'everyone', format: 'all' });
  assert.deepEqual(readFeedFilters('?following=1&type=video'), { audience: 'following', format: 'video' });
  assert.deepEqual(readFeedFilters('?following=1&type=audio&audience=everyone&format=text'), { audience: 'everyone', format: 'text' });
  assert.equal(feedPath(readFeedFilters('?audience=following&format=video')), '/feed?audience=following&format=video');
  assert.equal(feedPath(readFeedFilters('?audience=everyone&format=all')), '/feed');
  assert.equal(feedPath(readFeedFilters('?audience=other&format=other')), '/feed');
});

test('radio keyboard selection wraps and supports Home/End without consuming Tab', () => {
  const values = ['all', 'text', 'video', 'audio'];
  assert.equal(radioStep(values, 'all', 'ArrowLeft'), 'audio');
  assert.equal(radioStep(values, 'audio', 'ArrowDown'), 'all');
  assert.equal(radioStep(values, 'video', 'ArrowUp'), 'text');
  assert.equal(radioStep(values, 'video', 'Home'), 'all');
  assert.equal(radioStep(values, 'all', 'End'), 'audio');
  assert.equal(radioStep(values, 'video', 'Tab'), null);
});

test('empty recovery keeps audience when resetting format and describes the actual selection', () => {
  const empty = filteredEmpty({ audience: 'following', format: 'audio' });
  assert.equal(empty.text, 'No audio annotations from people you follow.');
  assert.equal(empty.group, 'format'); assert.equal(empty.value, 'all');
  assert.equal(filteredEmpty({ audience: 'everyone', format: 'video' }).text, 'No video annotations yet.');
  assert.equal(filteredEmpty({ audience: 'following', format: 'all' }).action, 'Show everyone');
  assert.equal(filteredEmpty({ audience: 'everyone', format: 'all' }), null);
  assert.equal(feedStatus({ audience: 'following', format: 'video' }), 'Showing video annotations from people you follow');
});
