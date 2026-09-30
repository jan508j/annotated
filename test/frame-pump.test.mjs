import test from 'node:test';
import assert from 'node:assert/strict';
import { startFramePump } from '../extension/frame-pump.mjs';

test('hidden offscreen capture paints repeated frames and stops its timer', () => {
  const draws = [];
  const source = { x: 10, y: 20, width: 300, height: 200 };
  const video = { currentFrame: 0 };
  let tick;
  let cleared = false;
  let requested = 0;
  const canvas = {
    width: 240, height: 160,
    getContext: () => ({ drawImage: (...args) => draws.push(args) })
  };
  const timers = {
    setInterval(callback, delay) { assert.equal(delay, 1000 / 30); tick = callback; return 7; },
    clearInterval(id) { assert.equal(id, 7); cleared = true; tick = null; }
  };
  const stop = startFramePump({ canvas, video, source, track: { requestFrame() { requested++; } }, onError: assert.ifError, timers });
  assert.equal(draws.length, 1, 'the first frame is available before recording begins');
  video.currentFrame++;
  tick();
  video.currentFrame++;
  tick();
  assert.equal(draws.length, 3);
  assert.equal(requested, 3);
  assert.deepEqual(draws[2], [video, 10, 20, 300, 200, 0, 0, 240, 160]);
  stop();
  assert.equal(cleared, true);
  assert.equal(tick, null);
});

test('frame pump reports drawing failure and clears the repeating timer', () => {
  let draws = 0;
  let tick;
  let cleared = false;
  let failure;
  const canvas = {
    width: 240, height: 160,
    getContext: () => ({ drawImage() { if (++draws === 2) throw new Error('source lost'); } })
  };
  startFramePump({ canvas, video: {}, source: { x: 0, y: 0, width: 320, height: 180 },
    track: { requestFrame() {} }, onError: (error) => { failure = error; },
    timers: { setInterval(callback) { tick = callback; return 1; }, clearInterval() { cleared = true; } }
  });
  tick();
  assert.match(failure.message, /source lost/);
  assert.equal(cleared, true);
});
