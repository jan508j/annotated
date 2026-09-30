import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('discovered media reports bounded playback updates and immediate seeks without controlling the player', async () => {
  const code = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8');
  const events = new Map();
  const messages = [];
  let receive;
  let now = 1000;
  let listenerCount = 0;
  let contextValid = true;
  const location = { href: 'https://example.test/video', hostname: 'example.test' };
  const video = {
    dataset: {}, tagName: 'VIDEO', currentTime: 10, duration: 120, paused: true,
    currentSrc: 'https://example.test/clip.mp4', title: 'Test player',
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 640, bottom: 360 }),
    addEventListener(name, listener) { listenerCount++; events.set(name, listener); },
    removeEventListener(name) { events.delete(name); },
    play() { throw new Error('Position reporting must not play the source'); },
    pause() { throw new Error('Position reporting must not pause the source'); }
  };
  runInNewContext(code, {
    location, innerWidth: 800, innerHeight: 600, Date: { now: () => now },
    getSelection: () => null,
    document: {
      title: 'Test video', addEventListener() {}, querySelector: () => null,
      querySelectorAll: selector => selector === 'video, audio' ? [video] : []
    },
    chrome: { runtime: {
      onMessage: { addListener(listener) { receive = listener; } },
      sendMessage(message) { if (!contextValid) throw new Error('Extension context invalidated'); messages.push(message); return Promise.resolve(); }
    } }
  });
  assert.equal(events.size, 0, 'only explicitly discovered players are observed');
  const discover = () => new Promise(resolve => receive({ type: 'ANNOTATED_DISCOVER' }, {}, resolve));
  assert.equal((await discover()).ok, true);
  await discover();
  assert.equal(listenerCount, 3, 'rediscovery must not duplicate subscriptions');
  events.get('timeupdate')({ type: 'timeupdate' });
  assert.equal(messages.length, 1);
  now += 100;
  video.currentTime = 10.1;
  events.get('timeupdate')({ type: 'timeupdate' });
  assert.equal(messages.length, 1, 'normal playback is limited to four updates per second');
  video.currentTime = 90;
  events.get('seeked')({ type: 'seeked' });
  assert.equal(messages.length, 2, 'a paused source seek is immediate, even inside the throttle interval');
  assert.equal(messages[1].currentTime, 90);
  assert.equal(messages[1].mediaId, video.dataset.annotatedMediaId);
  assert.equal(messages[1].url, location.href);
  assert.equal(messages[1].type, 'ANNOTATED_MEDIA_POSITION');
  now += 250;
  events.get('timeupdate')({ type: 'timeupdate' });
  assert.equal(messages.length, 3);
  video.duration = Infinity;
  events.get('durationchange')({ type: 'durationchange' });
  assert.equal(messages.at(-1).duration, null);
  assert.equal(video.currentTime, 90);
  assert.equal(video.paused, true);
  contextValid = false;
  assert.doesNotThrow(() => events.get('seeked')({ type: 'seeked' }));
  assert.equal(events.size, 0, 'an invalidated extension context detaches passive listeners');
});
