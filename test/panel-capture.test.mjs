import test from 'node:test';
import assert from 'node:assert/strict';
import { iconPaths } from '../extension/action-icon.mjs';

const source = () => ({
  tabId: 14,
  url: 'https://www.youtube.com/watch?v=panel-test',
  title: 'Test video',
  kind: 'video',
  media: [{ id: 'player-test', kind: 'video', currentTime: 0, duration: 60, visible: true, native: true }],
  excerpt: ''
});

const capture = (status, details = {}) => ({
  id: 'job-test', tabId: 14, mediaId: 'player-test', mediaKind: 'video',
  sourceUrl: source().url, start: 0, end: 12, duration: 12, elapsed: 12,
  status, ...details
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function panelHarness(run) {
  const original = { chrome: globalThis.chrome, document: globalThis.document, fetch: globalThis.fetch, Option: globalThis.Option, SpeechRecognition: globalThis.SpeechRecognition, addEventListener: globalThis.addEventListener };
  const elements = new Map();
  const icons = [];
  let receive;
  let runtimeReply = async (message) => message.type === 'ANNOTATED_PANEL_BOOTSTRAP'
    ? { ok: true, result: { page: source(), job: null } }
    : { ok: true, result: null };
  const element = (id) => {
    if (!elements.has(id)) {
      const classes = new Set(['preview-wrap', 'video-preview', 'audio-preview', 'media-controls', 'manual-range'].includes(id) ? ['hidden'] : []);
      const attributes = new Map();
      const listeners = new Map();
      elements.set(id, {
        value: '', textContent: '', disabled: false, dataset: {}, style: {},
        classList: {
          add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
          toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
          contains(name) { return classes.has(name); }
        },
        setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name) ?? (name === 'src' ? this.src ?? null : null); },
        removeAttribute(name) { attributes.delete(name); if (name === 'src') this.src = ''; },
        pause() {}, append(...children) { this.children = [...(this.children || []), ...children]; },
        addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) || []), listener]); },
        async dispatch(type, event = {}) { for (const listener of listeners.get(type) || []) await listener({ preventDefault() {}, ...event }); },
        scrollIntoView() {}, replaceChildren(...children) { this.children = children; }
      });
    }
    return elements.get(id);
  };
  try {
    globalThis.document = { addEventListener() {}, getElementById: element, createElement: () => element(Symbol()), querySelectorAll: () => [] };
    globalThis.addEventListener = () => {};
    globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
    globalThis.chrome = { tabs: {}, runtime: {
      onMessage: { addListener(listener) { receive = listener; } },
      sendMessage(message) {
        if (message.type === 'ANNOTATED_SET_DRAFT_ICON') {
          icons.push({ tabId: message.tabId, path: iconPaths(message.hue) });
          return Promise.resolve({ ok: true });
        }
        return runtimeReply(message);
      }
    } };
    globalThis.fetch = async (url) => String(url).includes('/media/')
      ? { ok: false, status: 404 }
      : { ok: true, status: 200, json: async () => ({ annotations: [] }) };
    const { __voiceTestHooks: hooks } = await import(`../extension/panel.js?capture=${Math.random()}`);
    hooks.state.windowId = 2;
    hooks.state.token = 'test-session';
    hooks.state.user = { name: 'Test reader' };
    hooks.state.page = source();
    hooks.state.pageAccessBlocked = false;
    element('media-select').value = 'player-test';
    await run({ hooks, element, icons, emit: (job) => receive({ type: 'ANNOTATED_JOB_UPDATE', job }), position: (currentTime, event = 'timeupdate', message = {}, sender = {}) => receive({ type: 'ANNOTATED_MEDIA_POSITION', url: hooks.state.page.url, mediaId: 'player-test', currentTime, duration: hooks.state.page.media[0].duration, event, ...message }, { tab: { id: 14 }, frameId: 0, url: hooks.state.page.url, ...sender }), setRuntimeReply(fn) { runtimeReply = fn; } });
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
}

test('recorded preview is visible during validation while publishing stays disabled', async () => panelHarness(async ({ hooks, element, emit }) => {
  element('commentary').value = 'A take that must wait for validation.';
  emit(capture('uploading', { capture: { previewUrl: 'blob:test-preview', role: 'source-video', duration: 12, width: 240, height: 136 } }));
  assert.equal(element('preview-wrap').classList.contains('hidden'), false);
  assert.equal(element('video-preview').src, 'blob:test-preview');
  assert.match(element('preview-meta').textContent, /saving clip/i);
  assert.match(element('capture-status').textContent, /saving and checking/i);
  assert.equal(element('publish').disabled, true);
  assert.match(element('publish-hint').textContent, /saving your clip/i);
  assert.equal(element('compose').dataset.stage, 'saving');
  for (const id of ['progress', 'progress-copy', 'clip-timeline', 'time-chips', 'media-setup']) {
    assert.equal(element(id).classList.contains('hidden'), true, `${id} is hidden after recording ends`);
  }
  assert.equal(element('captured-chip').classList.contains('hidden'), false);
  assert.equal(element('rerecord').disabled, true);
  assert.equal(hooks.state.job.capture.id, undefined);
}));

test('validated source clip and a written take enable publishing', async () => panelHarness(async ({ element, emit }) => {
  element('commentary').value = 'This is the finished take.';
  emit(capture('ready', { capture: { id: 'validated-media', previewUrl: 'blob:test-preview', role: 'source-video', duration: 12, width: 240, height: 136 } }));
  assert.equal(element('publish').disabled, false);
  assert.equal(element('publish-hint').textContent, 'Ready');
  assert.equal(element('captured-chip').classList.contains('hidden'), false);
  assert.equal(element('rerecord').disabled, false);
  assert.equal(element('media-setup').classList.contains('hidden'), true);
  assert.equal(element('video-preview').src, 'blob:test-preview');
}));

test('cancelled capture removes its preview and a repeated update cannot restore it', async () => panelHarness(async ({ hooks, element, emit }) => {
  element('commentary').value = 'Keep my written take.';
  const preview = { previewUrl: 'blob:discarded-preview', duration: 12 };
  emit(capture('uploading', { capture: preview }));
  assert.equal(element('video-preview').src, preview.previewUrl);
  const cancelled = capture('cancelled', { capture: preview, error: 'Recording cancelled.' });
  emit(cancelled);
  emit(cancelled);
  assert.equal(element('preview-wrap').classList.contains('hidden'), true);
  assert.equal(element('video-preview').getAttribute('src') || '', '');
  assert.equal(element('audio-preview').getAttribute('src') || '', '');
  assert.equal(element('preview-meta').textContent, '');
  assert.equal(element('media-setup').classList.contains('hidden'), false);
  assert.equal(element('publish').disabled, true);
  assert.equal(element('commentary').value, 'Keep my written take.');
  assert.equal(hooks.state.job.status, 'cancelled');
}));

test('discarding a ready clip also invalidates an unfinished preview fetch', async () => panelHarness(async ({ hooks, element, emit, setRuntimeReply }) => {
  const response = deferred();
  globalThis.fetch = () => response.promise;
  setRuntimeReply(async () => ({ ok: true, result: { discarded: true, jobId: 'job-test' } }));
  emit(capture('ready', { capture: { id: 'validated-media', previewUrl: 'blob:discarded-preview' } }));
  await hooks.rerecord();
  response.resolve({ ok: true, blob: async () => new Blob(['test media']) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hooks.state.job, null);
  assert.equal(element('preview-wrap').classList.contains('hidden'), true);
  assert.equal(element('video-preview').getAttribute('src') || '', '');
}));

test('a cancellation broadcast from another panel preserves published media', async () => panelHarness(async ({ element, emit }) => {
  element('published-video').src = 'https://example.test/published-video';
  element('published-audio').src = 'https://example.test/published-audio';
  emit(capture('cancelled', { tabId: 99, sourceUrl: 'https://example.test/another-source' }));
  assert.equal(element('published-video').src, 'https://example.test/published-video');
  assert.equal(element('published-audio').src, 'https://example.test/published-audio');
}));

test('full-video sliders keep both axes and the untouched thumb stable across invalid and valid edits', async () => panelHarness(async ({ hooks, element }) => {
  hooks.state.page.media[0].duration = 1800;
  hooks.setRangeMode('manual');
  const end = Number(element('range-end-visual').value);
  hooks.updateRangeFromVisual('start', 360);
  assert.equal(Number(element('range-end-visual').value), end);
  assert.equal(element('range-start-visual').min, '0');
  assert.equal(element('range-end-visual').min, '0');
  assert.equal(element('range-start-visual').max, '1800');
  assert.equal(element('range-end-visual').max, '1800');
  assert.equal(element('record').disabled, true);
  hooks.updateRangeFromVisual('end', 390);
  assert.equal(element('range-start-visual').value, '360');
  assert.equal(element('record').disabled, false);
  hooks.updateRangeFromVisual('end', 451);
  assert.equal(element('range-start-visual').value, '360');
  assert.equal(element('record').disabled, true);
  hooks.updateRangeFromVisual('start', 59.99);
  assert.equal(element('start-time').value, '0:59.99');
  hooks.updateRangeFromVisual('start', 0.05);
  assert.equal(element('start-time').value, '0:00.05');
}));

test('capture failure is explained beside the controls and keeps the take', async () => panelHarness(async ({ element, emit }) => {
  element('commentary').value = 'Keep this take after a failed upload.';
  emit(capture('failed', { capture: undefined, error: 'Upload validation rejected the clip.' }));
  assert.match(element('capture-status').textContent, /Upload validation rejected the clip/);
  assert.equal(element('capture-status').classList.contains('error'), true);
  assert.equal(element('media-setup').classList.contains('hidden'), false);
  assert.equal(element('publish').disabled, true);
  assert.equal(element('commentary').value, 'Keep this take after a failed upload.');
}));

test('capture setup failure unlocks range controls without a job update', async () => panelHarness(async ({ hooks, element, setRuntimeReply }) => {
  const start = deferred();
  setRuntimeReply((message) => message.type === 'ANNOTATED_START_CAPTURE' ? start.promise : Promise.resolve({ ok: true, result: null }));
  hooks.setRangeMode('manual');
  element('commentary').value = 'Keep this take when setup fails.';
  const controls = ['clip-start', 'clip-end', 'start-time', 'end-time', 'set-start', 'set-end', 'range-here', 'preset-15', 'preset-30'];
  const recording = hooks.record();
  for (const id of controls) assert.equal(element(id).disabled, true, `${id} locks during setup`);
  start.resolve({ ok: false, error: 'The selected player disappeared.' });
  await recording;
  assert.equal(hooks.state.captureStarting, false);
  assert.equal(hooks.state.job, null);
  for (const id of controls) assert.equal(element(id).disabled, false, `${id} unlocks after setup failure`);
  assert.equal(element('record').disabled, false);
  assert.match(element('capture-status').textContent, /selected player disappeared/);
  assert.equal(element('commentary').value, 'Keep this take when setup fails.');
}));

test('late Record reply cannot replace a newer ready job update', async () => panelHarness(async ({ hooks, element, emit, setRuntimeReply }) => {
  const start = deferred();
  setRuntimeReply((message) => message.type === 'ANNOTATED_START_CAPTURE' ? start.promise : Promise.resolve({ ok: true, result: null }));
  hooks.state.rangeMode = 'manual';
  hooks.state.rangeValid = true;
  element('range-start').value = '0';
  element('range-end').value = '12';
  element('commentary').value = 'A completed take.';
  const recording = hooks.record();
  assert.equal(hooks.state.captureStarting, true);
  assert.equal(element('publish').disabled, true);
  const ready = capture('ready', { capture: { id: 'validated-media', previewUrl: 'blob:test-preview', duration: 12 } });
  emit(ready);
  start.resolve({ ok: true, result: capture('preparing', { elapsed: 0 }) });
  await recording;
  assert.equal(hooks.state.job.status, 'ready');
  assert.equal(hooks.state.job.capture.id, 'validated-media');
  assert.equal(element('publish').disabled, false);
}));

test('late bootstrap snapshot cannot replace a newer ready job update', async () => panelHarness(async ({ hooks, element, emit, setRuntimeReply }) => {
  const bootstrap = deferred();
  setRuntimeReply((message) => message.type === 'ANNOTATED_PANEL_BOOTSTRAP' ? bootstrap.promise : Promise.resolve({ ok: true, result: null }));
  element('commentary').value = 'A completed take.';
  const refreshing = hooks.refresh();
  emit(capture('ready', { capture: { id: 'validated-media', previewUrl: 'blob:test-preview', duration: 12 } }));
  bootstrap.resolve({ ok: true, result: { page: source(), job: null } });
  await refreshing;
  assert.equal(hooks.state.job.status, 'ready');
  assert.equal(hooks.state.job.capture.id, 'validated-media');
  assert.equal(element('publish').disabled, false);
}));


test('mic click starts native dictation in place and permission failure never opens a page automatically', async () => panelHarness(async ({ hooks, element }) => {
  let starts = 0;
  let aborts = 0;
  let instance;
  let tabs = 0;
  globalThis.chrome.tabs = { create() { tabs++; } };
  globalThis.SpeechRecognition = class {
    constructor() { instance = this; }
    start() { starts++; }
    abort() { aborts++; }
    stop() { this.onend?.(); }
  };
  hooks.initDictation();
  // The former Permissions API preflight sent this state to setup on every click.
  hooks.state.microphonePermission = 'prompt';
  await hooks.toggleDictation();
  assert.equal(starts, 1);
  assert.equal(tabs, 0);
  instance.onerror({ error: 'not-allowed' });
  assert.equal(aborts, 1);
  assert.equal(element('microphone-help').classList.contains('hidden'), false);
  assert.equal(tabs, 0);
  hooks.state.microphonePermission = 'denied';
  await hooks.toggleDictation();
  assert.equal(starts, 2, 'a fresh user gesture can retry after permission changes');
  instance.onstart();
  assert.equal(element('dictation-status').textContent, 'Listening…');
  assert.equal(element('microphone-help').classList.contains('hidden'), true);
  await hooks.toggleDictation();
  assert.equal(element('dictation-status').textContent, '');
  await hooks.toggleDictation();
  instance.onerror({ error: 'service-not-allowed' });
  assert.equal(element('microphone-help').classList.contains('hidden'), true, 'unavailable speech service is not fixed by repeating microphone setup');
  assert.equal(tabs, 0);
}));

test('audio note tries the microphone in the panel before offering explicit recovery', async () => panelHarness(async ({ hooks, element }) => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const previousRecorder = globalThis.MediaRecorder;
  let requests = 0;
  let tabs = 0;
  globalThis.chrome.tabs = { create() { tabs++; } };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { async getUserMedia() { requests++; throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } } });
  globalThis.MediaRecorder = class {};
  try {
    hooks.state.microphonePermission = 'prompt';
    await hooks.startVoice();
    assert.equal(requests, 1);
    assert.equal(tabs, 0);
    assert.equal(element('voice-record-label').textContent, 'Record audio note');
    assert.equal(element('microphone-help').classList.contains('hidden'), false);
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'mediaDevices', descriptor); else delete navigator.mediaDevices;
    if (previousRecorder === undefined) delete globalThis.MediaRecorder; else globalThis.MediaRecorder = previousRecorder;
  }
}));

test('explicit permission recovery opens one ordinary tab bound to its source', async () => panelHarness(async ({ hooks }) => {
  const opened = [];
  globalThis.chrome.runtime.getURL = path => 'chrome-extension://test/' + path;
  globalThis.chrome.tabs = {
    async create(options) { opened.push(options); return { id: 32 }; },
    async update(id, options) { assert.equal(id, 32); assert.equal(options.active, true); }
  };
  await hooks.openMicrophoneSetup();
  await hooks.openMicrophoneSetup();
  assert.equal(opened.length, 1);
  const url = new URL(opened[0].url);
  assert.equal(url.searchParams.get('sourceTab'), '14');
  assert.equal(url.searchParams.get('returnAfterGrant'), '1');
  assert.equal(opened[0].openerTabId, 14);
  assert.equal(opened[0].windowId, 2);
}));

test('Marker presets and handles reuse existing manual range validation', async () => panelHarness(async ({ hooks, element, setRuntimeReply }) => {
  hooks.state.page.media[0].currentTime = 60;
  setRuntimeReply(async () => ({ ok: true, result: { page: { ...source(), media: [{ ...source().media[0], currentTime: 60 }] } } }));
  await hooks.selectPreset(15);
  assert.deepEqual(hooks.currentRange(), { start: 45, end: 60, duration: 15 });
  assert.equal(hooks.state.rangeMode, 'manual');
  hooks.updateRangeFromVisual('start', 40);
  assert.equal(hooks.state.preset, null, 'an exact-time edit must not be overwritten by the preset when capturing');
  assert.deepEqual(hooks.currentRange(), { start: 40, end: 60, duration: 20 });
  hooks.editTimeline('start', 44);
  assert.deepEqual(hooks.currentRange(), { start: 44, end: 60, duration: 16 });
  assert.equal(hooks.state.preset, null);
  await hooks.selectPreset(60);
  assert.deepEqual(hooks.currentRange(), { start: 0, end: 60, duration: 60 });
  assert.equal(element('clip-start').getAttribute('aria-valuenow'), '0');
  await hooks.selectPreset(30);
  assert.equal(hooks.state.rangeMode, 'previous30');
  assert.deepEqual(hooks.currentRange(), { start: 30, end: 60, duration: 30 });
}));

test('Next 30s selects the live playhead window without starting capture', async () => panelHarness(async ({ hooks, element, setRuntimeReply }) => {
  hooks.state.page.media[0].duration = 120;
  hooks.state.page.media[0].currentTime = 12;
  const messages = [];
  setRuntimeReply(async (message) => {
    messages.push(message.type);
    return { ok: true, result: { page: { ...source(), media: [{ ...source().media[0], duration: 120, currentTime: 42.4 }] } } };
  });
  hooks.bindEvents();
  await element('range-here').dispatch('click');
  await new Promise(setImmediate);
  assert.deepEqual(hooks.currentRange(), { start: 42.4, end: 72.4, duration: 30 });
  assert.equal(hooks.state.rangeMode, 'manual');
  assert.equal(hooks.state.preset, 'next30');
  assert.equal(element('range-here').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(messages, ['ANNOTATED_PANEL_BOOTSTRAP']);
  assert.equal(hooks.state.job, null);
}));

test('typed time chips enter manual mode, retain the opposite endpoint, and validate the cut', async () => panelHarness(async ({ hooks, element }) => {
  hooks.state.page.media[0].duration = 120;
  hooks.state.page.media[0].currentTime = 60;
  hooks.setRangeMode('previous30');
  hooks.bindEvents();
  assert.deepEqual(hooks.currentRange(), { start: 30, end: 60, duration: 30 });
  element('start-time').value = '0:40.25';
  await element('start-time').dispatch('input');
  assert.equal(hooks.state.rangeMode, 'manual');
  assert.deepEqual(hooks.currentRange(), { start: 40.25, end: 60, duration: 19.75 });
  assert.equal(element('record').disabled, false);
  element('end-time').value = '0:40';
  await element('end-time').dispatch('input');
  assert.equal(hooks.state.rangeValid, false);
  assert.equal(element('record').disabled, true);
  element('end-time').value = '0:42.5';
  await element('end-time').dispatch('input');
  assert.deepEqual(hooks.currentRange(), { start: 40.25, end: 42.5, duration: 2.25 });
  assert.equal(hooks.state.rangeValid, true);
}));

test('Dictate transcribes into the visible take without creating an audio recording', async () => panelHarness(async ({ hooks, element }) => {
  let recognition;
  let starts = 0;
  let stops = 0;
  globalThis.SpeechRecognition = class {
    constructor() { recognition = this; }
    start() { starts++; this.onstart(); }
    stop() { stops++; this.onend(); }
    abort() {}
  };
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  let audioRequests = 0;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia() { audioRequests++; throw new Error('Dictation must not record an audio note'); } } });
  try {
    hooks.initDictation();
    hooks.bindEvents();
    element('commentary').value = 'A take in progress.';
    await element('take-dictate').dispatch('click');
    assert.equal(starts, 1);
    assert.equal(hooks.state.takeMode, 'dictate');
    assert.equal(element('write-take').classList.contains('hidden'), false);
    assert.equal(element('take-dictate').getAttribute('aria-pressed'), 'true');
    assert.equal(element('take-dictate').textContent, 'Stop');
    assert.equal(element('publish').disabled, true);
    recognition.onresult({ results: [{ 0: { transcript: 'Spoken words become editable text.' }, isFinal: true }] });
    await element('take-write').dispatch('click');
    assert.equal(stops, 1);
    assert.equal(hooks.state.takeMode, 'write');
    assert.equal(element('commentary').value, 'A take in progress. Spoken words become editable text.');
    assert.equal(element('take-dictate').textContent, 'Dictate');
    assert.equal(hooks.state.voice.status, 'idle');
    assert.equal(hooks.state.voice.blob, null);
    assert.equal(audioRequests, 0);
    assert.equal(Boolean(element('audio-note').open), false);
    await element('take-dictate').dispatch('click');
    await element('take-dictate').dispatch('click');
    assert.equal(starts, 2);
    assert.equal(stops, 2, 'the active Dictate control also stops speech input');
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'mediaDevices', descriptor); else delete navigator.mediaDevices;
  }
}));

test('timeline keyboard Shift+Arrow moves one edge by five seconds', async () => panelHarness(async ({ hooks, element }) => {
  hooks.state.page.media[0].duration = 120;
  hooks.state.page.media[0].currentTime = 20;
  hooks.setRangeMode('manual');
  hooks.bindEvents();
  assert.deepEqual(hooks.currentRange(), { start: 20, end: 50, duration: 30 });
  let prevented = false;
  await element('clip-start').dispatch('keydown', { key: 'ArrowRight', shiftKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(hooks.currentRange(), { start: 25, end: 50, duration: 25 });
  assert.equal(element('clip-start').getAttribute('aria-valuenow'), '25');
}));

test('panel restores the captured draft hue and follows source and voice recording icons', async () => panelHarness(async ({ hooks, element, icons, emit, setRuntimeReply }) => {
  const { markerIndex } = await import('../shared/marker.mjs');
  const { iconPaths } = await import('../extension/action-icon.mjs');
  const draftHue = 'logo-panel-reopened';
  setRuntimeReply(async () => ({ ok: true, result: { page: source(), job: capture('recording', { draftHue }) } }));
  await hooks.refresh();
  assert.equal(hooks.state.draftHue, draftHue);
  assert.equal(element('compose').dataset.marker, String(markerIndex(draftHue)));
  assert.equal(element('panel-logo').dataset.marker, element('compose').dataset.marker);
  assert.equal(element('panel-logo').classList.contains('is-recording'), true);
  await new Promise(setImmediate);
  assert.deepEqual(icons.at(-1), { tabId: 14, path: iconPaths('recording') });
  emit(capture('uploading', { draftHue }));
  await new Promise(setImmediate);
  assert.equal(element('panel-logo').classList.contains('is-recording'), false);
  assert.deepEqual(icons.at(-1).path, iconPaths(markerIndex(draftHue)));
  hooks.state.voice.status = 'recording';
  hooks.renderVoice();
  await new Promise(setImmediate);
  assert.deepEqual(icons.at(-1).path, iconPaths('recording'));
  hooks.state.voice.status = 'ready';
  hooks.renderVoice();
  await new Promise(setImmediate);
  assert.deepEqual(icons.at(-1).path, iconPaths(markerIndex(draftHue)));
  hooks.state.voice.status = 'recording';
  hooks.renderVoice();
  hooks.disposeVoice();
  await new Promise(setImmediate);
  assert.deepEqual(icons.at(-1).path, iconPaths(markerIndex(draftHue)));
}));

test('article publication and paused-draft discard return the toolbar to citrus', async () => panelHarness(async ({ hooks, element, icons, setRuntimeReply }) => {
  const { iconPaths } = await import('../extension/action-icon.mjs');
  const page = { ...source(), kind: 'article', media: [], excerpt: 'Exact evidence.', excerpts: ['Exact evidence.'] };
  setRuntimeReply(async () => ({ ok: true, result: { page, job: null } }));
  await hooks.refresh();
  element('commentary').value = 'Local logo test take.';
  globalThis.fetch = async (url, options) => ({ ok: true, status: 200, json: async () => options?.method === 'POST'
    ? { annotation: { id: 'logo-test-annotation', source: page, excerpt: page.excerpt, commentary: 'Local logo test take.' } }
    : { annotations: [] } });
  await hooks.publish();
  await new Promise(setImmediate);
  assert.equal(hooks.state.publishedResult.id, 'logo-test-annotation');
  assert.deepEqual(icons.at(-1).path, iconPaths('citrus'));
  hooks.state.publishedResult = null;
  hooks.state.draftIconActive = true;
  hooks.renderComposerStage();
  await new Promise(setImmediate);
  // Discard succeeds even if the newly selected page is inaccessible.
  setRuntimeReply(async () => ({ ok: false, error: 'New tab is not connected.' }));
  await hooks.discardPausedDraft();
  await new Promise(setImmediate);
  assert.deepEqual(icons.at(-1).path, iconPaths('citrus'));
  assert.equal(element('panel-logo').dataset.marker, '1');
}));

test('an empty source panel stays citrus until a draft begins', async () => panelHarness(async ({ hooks, element, icons }) => {
  await hooks.refresh();
  assert.equal(hooks.state.draftIconActive, false);
  assert.equal(element('panel-logo').dataset.marker, '1');
  assert.deepEqual(icons.at(-1).path, iconPaths('citrus'));
  hooks.state.rangeMode = 'manual';
  element('range-start').value = '0';
  element('range-end').value = '12';
  await hooks.record();
  assert.equal(hooks.state.draftIconActive, true);
  assert.equal(element('panel-logo').dataset.marker, element('compose').dataset.marker);
}));


test('source playback and seeks move live presets and recenter their timeline', async () => panelHarness(async ({ hooks, element, position, setRuntimeReply }) => {
  hooks.state.page.media[0].duration = 1800;
  hooks.state.page.media[0].currentTime = 60;
  hooks.setRangeMode('previous30');
  position(300, 'seeked');
  assert.deepEqual(hooks.currentRange(), { start: 270, end: 300, duration: 30 });
  assert.equal(element('clip-now').textContent, '▲ now 5:00');
  assert.ok(hooks.state.timelineWindow.start <= 270 && hooks.state.timelineWindow.end >= 300);
  setRuntimeReply(async () => ({ ok: true, result: { page: structuredClone(hooks.state.page) } }));
  await hooks.selectPreset(15);
  position(420, 'seeked');
  assert.deepEqual(hooks.currentRange(), { start: 405, end: 420, duration: 15 });
  position(421);
  assert.deepEqual(hooks.currentRange(), { start: 406, end: 421, duration: 15 });
  await hooks.choosePlayhead('window');
  position(600, 'seeked');
  assert.deepEqual(hooks.currentRange(), { start: 600, end: 630, duration: 30 });
  position(1795, 'seeked');
  assert.deepEqual(hooks.currentRange(), { start: 1795, end: 1800, duration: 5 });
  assert.equal(hooks.state.job, null, 'following a player never starts capture');
}));

test('custom cuts stay fixed during playback and follow seeks with their length and offset intact', async () => panelHarness(async ({ hooks, position }) => {
  hooks.state.page.media[0].duration = 1800;
  hooks.state.page.media[0].currentTime = 60;
  hooks.setRangeMode('previous30');
  hooks.editTimeline('start', 40);
  position(70);
  assert.deepEqual(hooks.currentRange(), { start: 40, end: 60, duration: 20 });
  position(300, 'seeked');
  assert.deepEqual(hooks.currentRange(), { start: 280, end: 300, duration: 20 });
  position(310);
  position(500, 'seeked');
  assert.deepEqual(hooks.currentRange(), { start: 480, end: 500, duration: 20 });
  position(5, 'seeked');
  assert.deepEqual(hooks.currentRange(), { start: 0, end: 20, duration: 20 });
  position(300, 'seeked');
  assert.deepEqual(hooks.currentRange(), { start: 280, end: 300, duration: 20 }, 'clamping must not change the original custom offset');
}));

test('position events cannot move an unrelated source/player, a trim in progress or a captured interval', async () => panelHarness(async ({ hooks, element, position }) => {
  hooks.state.page.media[0].duration = 1800;
  hooks.state.page.media[0].currentTime = 60;
  hooks.setRangeMode('previous30');
  const unchanged = () => assert.deepEqual(hooks.currentRange(), { start: 30, end: 60, duration: 30 });
  for (const sender of [{ tab: { id: 99 } }, { frameId: 1 }]) { position(300, 'seeked', {}, sender); unchanged(); }
  for (const message of [{ mediaId: 'another-player' }, { url: 'https://example.test/other' }, { currentTime: NaN }]) { position(300, 'seeked', message); unchanged(); }
  for (const key of ['captureStarting', 'publishing', 'publishedResult', 'pageAccessBlocked']) { hooks.state[key] = true; position(300, 'seeked'); unchanged(); hooks.state[key] = false; }
  for (const status of ['preparing', 'recording', 'uploading', 'ready']) { hooks.state.job = capture(status); position(300, 'seeked'); unchanged(); }
  hooks.state.job = null;
  hooks.state.draggingBoundary = 'start'; position(300, 'seeked'); unchanged(); hooks.state.draggingBoundary = null;
  document.activeElement = element('start-time'); position(300, 'seeked'); unchanged(); document.activeElement = null;
  position(300, 'seeked');
  assert.deepEqual(hooks.currentRange(), { start: 270, end: 300, duration: 30 });
}));

test('playback does not erase an incomplete typed time or re-enable capture', async () => panelHarness(async ({ hooks, element, position }) => {
  hooks.state.page.media[0].duration = 1800;
  hooks.state.page.media[0].currentTime = 60;
  hooks.setRangeMode('previous30');
  hooks.bindEvents();
  element('start-time').value = '1:';
  await element('start-time').dispatch('input');
  assert.equal(hooks.state.rangeValid, false);
  position(300, 'seeked');
  assert.equal(element('start-time').value, '1:');
  assert.equal(element('record').disabled, true);
  element('start-time').value = '0:40';
  await element('start-time').dispatch('input');
  assert.equal(element('record').disabled, false);
}));


test('source focus resumes updates after a time edit and anchors the cut to the latest clock', async () => panelHarness(async ({ hooks, element, position }) => {
  hooks.state.page.media[0].duration = 1800;
  hooks.state.page.media[0].currentTime = 60;
  hooks.setRangeMode('previous30');
  hooks.bindEvents();
  document.hasFocus = () => true;
  document.activeElement = element('start-time');
  element('start-time').value = '0:40';
  await element('start-time').dispatch('input');
  position(70);
  assert.deepEqual(hooks.currentRange(), { start: 40, end: 60, duration: 20 }, 'visible range is frozen while editing');
  document.activeElement = element('end-time');
  element('end-time').value = '1:00';
  await element('end-time').dispatch('input');
  document.hasFocus = () => false; // Chrome can retain the sidebar activeElement after focus leaves it.
  position(300, 'seeked');
  assert.deepEqual(hooks.currentRange(), { start: 270, end: 290, duration: 20 });
  assert.equal(element('start-time').value, '4:30.0');
  assert.equal(element('end-time').value, '4:50.0');
}));

test('temporary media metadata loss recovers and reclamps custom cuts without refresh', async () => panelHarness(async ({ hooks, element, position }) => {
  hooks.state.page.media[0].duration = 1800;
  hooks.state.page.media[0].currentTime = 60;
  hooks.setRangeMode('previous30');
  hooks.editTimeline('start', 40);
  position(60, 'durationchange', { duration: null });
  assert.equal(hooks.state.rangeValid, false);
  assert.equal(element('record').disabled, true);
  position(60, 'durationchange', { duration: 1800 });
  assert.deepEqual(hooks.currentRange(), { start: 40, end: 60, duration: 20 });
  assert.equal(element('record').disabled, false);
  position(5, 'durationchange', { duration: 10 });
  assert.deepEqual(hooks.currentRange(), { start: 0, end: 10, duration: 10 });
  position(300, 'seeked', { duration: 1800 });
  assert.deepEqual(hooks.currentRange(), { start: 280, end: 300, duration: 20 });
}));

test('a finished capture on another source does not freeze a new sidebar timeline', async () => panelHarness(async ({ hooks, position }) => {
  hooks.state.page.media[0].duration = 1800;
  hooks.state.page.media[0].currentTime = 60;
  hooks.setRangeMode('previous30');
  hooks.state.job = capture('ready', { tabId: 99, sourceUrl: 'https://example.test/other' });
  position(300, 'seeked');
  assert.deepEqual(hooks.currentRange(), { start: 270, end: 300, duration: 30 });
}));


test('following uses the current content-script URL after same-document navigation', async () => panelHarness(async ({ hooks, position }) => {
  const originalUrl = hooks.state.page.url;
  hooks.state.page.url = 'https://www.youtube.com/watch?v=next-video';
  hooks.state.page.media[0].duration = 1800;
  hooks.state.page.media[0].currentTime = 60;
  hooks.setRangeMode('previous30');
  position(300, 'seeked', {}, { url: originalUrl });
  assert.deepEqual(hooks.currentRange(), { start: 270, end: 300, duration: 30 });
  position(500, 'seeked', { url: originalUrl }, { url: originalUrl });
  assert.deepEqual(hooks.currentRange(), { start: 270, end: 300, duration: 30 }, 'an old source message is still ignored');
}));

test('explicit refresh restores following when it replaces an incomplete time chip', async () => panelHarness(async ({ hooks, element, position, setRuntimeReply }) => {
  hooks.state.page.media[0].duration = 1800;
  hooks.state.page.media[0].currentTime = 60;
  hooks.setRangeMode('previous30');
  hooks.bindEvents();
  element('start-time').value = '1:';
  await element('start-time').dispatch('input');
  setRuntimeReply(async () => ({ ok: true, result: { page: structuredClone(hooks.state.page), job: null } }));
  await hooks.refresh();
  assert.equal(hooks.state.rangeInputInvalid, false);
  assert.equal(element('record').disabled, false);
  position(300, 'seeked');
  assert.deepEqual(hooks.currentRange(), { start: 270, end: 300, duration: 30 });
}));
