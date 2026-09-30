import test from 'node:test';
import assert from 'node:assert/strict';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function workerHarness(initialJob = null, overrides = {}) {
  let job = initialJob;
  let receive;
  const broadcasts = [];
  const icons = [];
  const event = (listener) => ({ addListener: listener });
  const storage = {
    async get() { return { captureJob: job }; },
    async set(value) { job = value.captureJob; },
    async remove() { job = null; }
  };
  globalThis.chrome = {
    runtime: {
      onInstalled: event(() => {}), onStartup: event(() => {}),
      onMessage: event((listener) => { receive = listener; }),
      async sendMessage(message) {
        if (message.type === 'ANNOTATED_JOB_UPDATE') broadcasts.push(message.job);
        return { ok: true };
      },
      getURL: (path) => `chrome-extension://test/${path}`,
      async getContexts() { return [{ contextType: 'OFFSCREEN_DOCUMENT' }]; }
    },
    action: { onClicked: event(() => {}), async setIcon(details) { icons.push(details); } },
    sidePanel: { async setPanelBehavior() {}, async open() {} },
    tabs: {
      onRemoved: event(() => {}), onUpdated: event(() => {}),
      async query() { return [{ id: 14, windowId: 2, url: 'https://www.youtube.com/watch?v=test' }]; },
      async sendMessage(_tabId, message) {
        if (message.type === 'ANNOTATED_READ_MEDIA') return { ok: true, result: { currentTime: 0, duration: 100, mediaKind: 'video' } };
        if (message.type === 'ANNOTATED_PREPARE_CAPTURE') return { ok: true, result: { mediaKind: 'video', rect: { x: 0, y: 0, width: 640, height: 360 }, viewport: { width: 640, height: 360 } } };
        return { ok: true, result: {} };
      }
    },
    scripting: { async executeScript() {} },
    tabCapture: { async getMediaStreamId() { return 'test-stream'; } },
    storage: { session: storage, local: { async get() { return { 'annotated-session:http://127.0.0.1:4317': { token: 'test-token' } }; } } },
    ...overrides
  };
  await import(`../extension/service-worker.js?lifecycle=${Math.random()}`);
  const send = (message, sender = {}) => new Promise((resolve) => {
    const handled = receive(message, sender, resolve);
    assert.equal(handled, true);
  });
  return { send, receive, storage, broadcasts, icons, get job() { return job; } };
}

const activeJob = () => ({
  id: 'job-test', tabId: 14, status: 'recording', sourceUrl: 'https://www.youtube.com/watch?v=test',
  mediaId: 'media-test', mediaKind: 'video', start: 0, end: 12, duration: 12, elapsed: 0
});

test('serialized job changes keep a completed capture ready after a delayed progress write', async () => {
  const originalChrome = globalThis.chrome;
  try {
    const harness = await workerHarness(activeJob());
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const normalSet = harness.storage.set;
    harness.storage.set = async (value) => {
      if (value.captureJob.status === 'recording' && value.captureJob.elapsed === 1) {
        writeStarted.resolve();
        await releaseWrite.promise;
      }
      await normalSet(value);
    };
    const progress = harness.send({ type: 'ANNOTATED_CAPTURE_PROGRESS', jobId: 'job-test', elapsed: 1 });
    await writeStarted.promise;
    const complete = harness.send({ type: 'ANNOTATED_CAPTURE_COMPLETE', jobId: 'job-test', duration: 12, capture: { id: 'media-test', previewUrl: 'blob:test' } });
    releaseWrite.resolve();
    await Promise.all([progress, complete]);
    assert.equal(harness.job.status, 'ready');
    assert.equal(harness.job.capture.id, 'media-test');
    await harness.send({ type: 'ANNOTATED_CAPTURE_PROGRESS', jobId: 'job-test', elapsed: 2 });
    await harness.send({ type: 'ANNOTATED_CAPTURE_FAILED', jobId: 'job-test', error: 'late failure' });
    assert.equal(harness.job.status, 'ready');
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
  }
});

test('preview remains uploading without a validated id, then completion makes it ready', async () => {
  const originalChrome = globalThis.chrome;
  try {
    const harness = await workerHarness(activeJob());
    const preview = { previewUrl: 'blob:test-preview', role: 'source-video', duration: 12, width: 240, height: 136 };
    await harness.send({ type: 'ANNOTATED_CAPTURE_PREVIEW', jobId: 'job-test', capture: preview });
    assert.equal(harness.job.status, 'uploading');
    assert.deepEqual(harness.job.capture, preview);
    assert.equal(harness.job.capture.id, undefined);
    await harness.send({ type: 'ANNOTATED_CAPTURE_COMPLETE', jobId: 'job-test', duration: 12, capture: { ...preview, id: 'validated-media' } });
    assert.equal(harness.job.status, 'ready');
    assert.equal(harness.job.capture.id, 'validated-media');
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
  }
});

test('cancellation is terminal even when progress and completion arrive later', async () => {
  const originalChrome = globalThis.chrome;
  try {
    const harness = await workerHarness(activeJob());
    await harness.send({ type: 'ANNOTATED_CANCEL_CAPTURE' });
    assert.equal(harness.job.status, 'cancelled');
    await harness.send({ type: 'ANNOTATED_CAPTURE_PROGRESS', jobId: 'job-test', elapsed: 11 });
    await harness.send({ type: 'ANNOTATED_CAPTURE_COMPLETE', jobId: 'job-test', duration: 12, capture: { id: 'late-media' } });
    await harness.send({ type: 'ANNOTATED_CAPTURE_FAILED', jobId: 'job-test', error: 'late failure' });
    assert.equal(harness.job.status, 'cancelled');
    assert.equal(harness.job.capture, undefined);
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
  }
});

test('start reply reflects the latest recording state and unknown messages get no response', async () => {
  const originalChrome = globalThis.chrome;
  try {
    const harness = await workerHarness();
    const normalSend = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (message) => {
      if (message.type === 'ANNOTATED_OFFSCREEN_START') {
        const response = await harness.send({ type: 'ANNOTATED_CAPTURE_READY', jobId: message.job.id });
        assert.equal(response.ok, true);
      }
      return normalSend(message);
    };
    const response = await harness.send({ type: 'ANNOTATED_START_CAPTURE', tabId: 14, mediaId: 'media-test', rangeMode: 'manual', start: 0, end: 12, windowId: 2 });
    assert.equal(response.ok, true);
    assert.equal(response.result.status, 'recording');
    assert.equal(response.result.id, harness.job.id);
    let unknownResponse = false;
    assert.equal(harness.receive({ type: 'ANNOTATED_OFFSCREEN_START' }, {}, () => { unknownResponse = true; }), false);
    await Promise.resolve();
    assert.equal(unknownResponse, false);
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
  }
});

test('toolbar follows capture events without a panel, ignores progress, and resets after discard', async () => {
  const originalChrome = globalThis.chrome;
  try {
    const harness = await workerHarness();
    const { markerIndex } = await import('../shared/marker.mjs');
    const { iconPaths } = await import('../extension/action-icon.mjs');
    const draftHue = 'persistent-logo-draft';
    await harness.send({ type: 'ANNOTATED_START_CAPTURE', tabId: 14, mediaId: 'media-test', rangeMode: 'manual', start: 0, end: 12, windowId: 2, draftHue });
    const jobId = harness.job.id;
    assert.equal(harness.job.draftHue, draftHue);
    assert.deepEqual(harness.icons.at(-1), { tabId: 14, path: iconPaths(markerIndex(draftHue)) });
    await harness.send({ type: 'ANNOTATED_CAPTURE_READY', jobId });
    assert.deepEqual(harness.icons.at(-1), { tabId: 14, path: iconPaths('recording') });
    const count = harness.icons.length;
    await harness.send({ type: 'ANNOTATED_CAPTURE_PROGRESS', jobId, elapsed: 2 });
    assert.equal(harness.icons.length, count);
    await harness.send({ type: 'ANNOTATED_RANGE_ENDED', jobId }, { tab: { id: 14 } });
    assert.deepEqual(harness.icons.at(-1).path, iconPaths(markerIndex(draftHue)));
    await harness.send({ type: 'ANNOTATED_CAPTURE_COMPLETE', jobId, duration: 12, capture: { id: 'logo-test-media' } });
    await harness.send({ type: 'ANNOTATED_DISCARD_CAPTURE', jobId });
    assert.equal(harness.job, null);
    assert.deepEqual(harness.icons.at(-1).path, iconPaths('citrus'));
    // A retained take starts a new draft after clip discard. Both event sources
    // must share the worker's cache, so a prior hue cannot suppress this update.
    await harness.send({ type: 'ANNOTATED_SET_DRAFT_ICON', tabId: 14, hue: markerIndex(draftHue) });
    assert.deepEqual(harness.icons.at(-1).path, iconPaths(markerIndex(draftHue)));
    await harness.send({ type: 'ANNOTATED_SET_DRAFT_ICON', tabId: 14, hue: 'citrus' });
    assert.deepEqual(harness.icons.at(-1).path, iconPaths('citrus'));
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
  }
});

test('source loss and capture failure restore the draft icon; an icon error cannot block cleanup', async () => {
  const originalChrome = globalThis.chrome;
  try {
    const { markerIndex } = await import('../shared/marker.mjs');
    const { iconPaths } = await import('../extension/action-icon.mjs');
    for (const type of ['ANNOTATED_SOURCE_LOST', 'ANNOTATED_CAPTURE_FAILED']) {
      const harness = await workerHarness({ ...activeJob(), draftHue: 'logo-interrupted' });
      await harness.send({ type, jobId: 'job-test', error: 'Fixture failure' }, { tab: { id: 14 } });
      assert.equal(harness.job.status, type === 'ANNOTATED_SOURCE_LOST' ? 'cancelled' : 'failed');
      assert.deepEqual(harness.icons.at(-1).path, iconPaths(markerIndex('logo-interrupted')));
    }
    const harness = await workerHarness(activeJob());
    chrome.action.setIcon = async () => { throw new Error('Tab closed'); };
    assert.equal((await harness.send({ type: 'ANNOTATED_CANCEL_CAPTURE' })).ok, true);
    assert.equal(harness.job.status, 'cancelled');
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
  }
});
