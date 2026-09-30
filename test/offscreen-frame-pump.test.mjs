import test from 'node:test';
import assert from 'node:assert/strict';

test('offscreen capture pumps frames, then source loss and cancellation stop every track', async () => {
  const restore = [];
  const mock = (name, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    restore.push(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  let receive;
  let nextTimer = 0;
  const timers = new Map();
  const sourceTracks = [];
  const canvasTracks = [];
  let draws = 0;
  let requested = 0;
  const messages = [];
  class Track {
    constructor(kind) { this.kind = kind; this.stopped = false; this.listeners = []; }
    addEventListener(type, listener) { if (type === 'ended') this.listeners.push(listener); }
    stop() { this.stopped = true; }
    end() { this.listeners.forEach(listener => listener()); }
    requestFrame() { requested++; }
  }
  class Stream {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    addTrack(track) { this.tracks.push(track); }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  }
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.handlers = new Map(); this.mimeType = 'video/webm'; }
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => this.handlers.get('stop')?.()); }
  }
  try {
    mock('setInterval', (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; });
    mock('clearInterval', id => timers.delete(id));
    mock('MediaStream', Stream);
    mock('MediaRecorder', Recorder);
    mock('navigator', { mediaDevices: { async getUserMedia() {
      const track = new Track('video');
      sourceTracks.push(track);
      return new Stream([track]);
    } } });
    mock('document', { createElement(name) {
      if (name === 'video') return { videoWidth: 320, videoHeight: 180, async play() {}, pause() {} };
      return { width: 0, height: 0,
        getContext() { return { drawImage() { draws++; } }; },
        captureStream() { const track = new Track('video'); canvasTracks.push(track); return new Stream([track]); }
      };
    } });
    mock('chrome', { runtime: {
      onMessage: { addListener(listener) { receive = listener; } },
      async sendMessage(message) { messages.push(message); return { ok: true }; }
    } });
    await import(`../extension/offscreen.js?pump=${Math.random()}`);
    const send = message => new Promise(resolve => receive(message, {}, resolve));
    const start = id => send({ type: 'ANNOTATED_OFFSCREEN_START', streamId: 'fixture', token: 'fixture',
      job: { id, mediaKind: 'video', duration: 4, crop: { rect: { x: 0, y: 0, width: 320, height: 180 }, viewport: { width: 320, height: 180 } } }
    });
    assert.equal((await start('source-loss')).ok, true);
    assert.equal(draws, 1);
    const pump = [...timers.values()].find(timer => timer.delay === 1000 / 30);
    assert.ok(pump);
    pump.callback(); pump.callback();
    assert.equal(draws, 3);
    assert.equal(requested, 3);
    assert.equal((await send({ type: 'ANNOTATED_OFFSCREEN_BEGIN', jobId: 'source-loss' })).ok, true);
    sourceTracks[0].end();
    await Promise.resolve();
    assert.ok(sourceTracks[0].stopped);
    assert.ok(canvasTracks[0].stopped);
    assert.equal(timers.size, 0);
    assert.ok(messages.some(message => message.type === 'ANNOTATED_CAPTURE_FAILED' && message.jobId === 'source-loss'));

    assert.equal((await start('cancel')).ok, true);
    assert.equal((await send({ type: 'ANNOTATED_OFFSCREEN_BEGIN', jobId: 'cancel' })).ok, true);
    assert.equal((await send({ type: 'ANNOTATED_OFFSCREEN_CANCEL' })).ok, true);
    await Promise.resolve();
    assert.ok(sourceTracks[1].stopped);
    assert.ok(canvasTracks[1].stopped);
    assert.equal(timers.size, 0);
  } finally {
    restore.reverse().forEach(fn => fn());
  }
});
