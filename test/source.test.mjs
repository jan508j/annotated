import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalSource,sourceKey,sourceLink,formatTime} from '../shared/source.mjs';
test('YouTube aliases share one source and retain an exact original jump', async () => {
  const one='https://youtu.be/abcdefghijk?t=42';
  const two='https://www.youtube.com/watch?v=abcdefghijk&utm_source=x';
  assert.equal(await sourceKey(one),await sourceKey(two));
  assert.equal(sourceLink(one,43.8),'https://www.youtube.com/watch?v=abcdefghijk&t=43s');
  assert.notEqual(await sourceKey(one),await sourceKey('https://youtu.be/abcdefghijl'));
});
test('Generic lookup keys hash public URL and preserve semantic queries', async () => {
  assert.equal(await sourceKey('https://example.com/article?utm_source=test&chapter=2#p'),await sourceKey('https://example.com/article?chapter=2'));
  const key=await sourceKey('https://example.com/article?chapter=2');
  assert.match(key,/^web:v1:[a-f0-9]{64}$/);
  assert.notEqual(key,await sourceKey('https://example.com/article?chapter=3'));
});
test('Private access URLs and unsafe source schemes are rejected', () => {
  for(const url of ['javascript:alert(1)','file:///tmp/secret','https://me:secret@example.com','https://example.com/?access_token=private']) assert.throws(()=>canonicalSource(url));
});
test('Source times remain readable across hour boundaries',()=>{
  assert.equal(formatTime(42.9),'0:42');assert.equal(formatTime(3605),'1:00:05');assert.equal(formatTime(-5),'0:00');
});
