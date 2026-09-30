import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sessionStorageKey } from '../extension/config.mjs';
import { adjustVisualRange, boundedExcerpt, captureSize, isCurrentCapture, MAX_VOICE_RECORDING_MS, normalizeRange, oauthCallbackCode, offscreenStartMessage, pkceChallenge, publicationIdentity, randomPkceVerifier } from '../extension/helpers.mjs';

test('previous 30 second range clamps at the beginning', () => {
  assert.deepEqual(normalizeRange({ mode: 'previous30', currentTime: 12.5, duration: 200 }), { start: 0, end: 12.5, duration: 12.5 });
});

test('manual range rejects clips over 90 seconds', () => {
  assert.throws(() => normalizeRange({ mode: 'manual', start: 1, end: 92 }), /at most 90 seconds/);
});

test('full-duration range editing never moves the other endpoint, including temporarily invalid pairs', () => {
  const movedStart = adjustVisualRange({ boundary: 'start', value: 360, start: 20, end: 40, duration: 1800 });
  assert.deepEqual(movedStart, { start: 360, end: 40 });
  assert.throws(() => normalizeRange({ mode: 'manual', ...movedStart, duration: 1800 }), /after the start/);
  const valid = adjustVisualRange({ boundary: 'end', value: 389, ...movedStart, duration: 1800 });
  assert.deepEqual(normalizeRange({ mode: 'manual', ...valid, duration: 1800 }), { start: 360, end: 389, duration: 29 });
  const tooLong = adjustVisualRange({ boundary: 'end', value: 600, ...valid, duration: 1800 });
  assert.equal(tooLong.start, 360);
  assert.equal(tooLong.end, 600);
  assert.throws(() => normalizeRange({ mode: 'manual', ...tooLong, duration: 1800 }), /at most 90/);
  assert.deepEqual(adjustVisualRange({ boundary: 'start', value: -5, start: 20, end: 40, duration: 200 }), { start: 0, end: 40 });
  assert.deepEqual(adjustVisualRange({ boundary: 'end', value: 300, start: 20, end: 40, duration: 200 }), { start: 20, end: 200 });
  assert.throws(() => adjustVisualRange({ boundary: 'end', value: 5, start: 0, end: 1, duration: Infinity }), /finite media duration/);
});

test('capture size crops in stream coordinates and caps output at 240p', () => {
  assert.deepEqual(captureSize({ x: 10, y: 20, width: 640, height: 360 }, 1600, 900, 800, 450), {
    source: { x: 20, y: 40, width: 1280, height: 720 },
    output: { width: 426, height: 240 }
  });
});

test('article excerpt is normalized and limited to 100 words', () => {
  const value = Array.from({ length: 110 }, (_, index) => `word${index}`).join(' ');
  assert.equal(boundedExcerpt(`  ${value}\n` ).split(' ').length, 100);
});

test('capture events only match the current job, source tab and allowed state', () => {
  const job = { id: 'new-job', tabId: 14, status: 'recording' };
  assert.equal(isCurrentCapture(job, 'new-job', 14, ['recording']), true);
  assert.equal(isCurrentCapture(job, 'old-job', 14, ['recording']), false);
  assert.equal(isCurrentCapture(job, 'new-job', 15, ['recording']), false);
  assert.equal(isCurrentCapture(job, 'new-job', 14, ['preparing']), false);
});

test('worker handoff carries a session without storing it in the offscreen document', async () => {
  assert.deepEqual(offscreenStartMessage('stream-1', { id: 'job-1' }, 'local-token'), {
    type: 'ANNOTATED_OFFSCREEN_START', streamId: 'stream-1', job: { id: 'job-1' }, token: 'local-token'
  });
  assert.throws(() => offscreenStartMessage('stream-1', { id: 'job-1' }, ''), /local session/);
  const offscreenSource = await readFile(new URL('../extension/offscreen.js', import.meta.url), 'utf8');
  assert.doesNotMatch(offscreenSource, /chrome\.storage/);
});

test('voice capture stays below the server limit without a standing microphone permission', async () => {
  assert.ok(MAX_VOICE_RECORDING_MS > 0 && MAX_VOICE_RECORDING_MS < 90_000);
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.permissions.includes('audioCapture'), false);
});

test('publication identity is stable for a retry and changes with the draft', () => {
  let next = 0;
  const createId = () => `client-${++next}`;
  const first = publicationIdentity(null, { commentary: 'First', mediaId: null }, createId);
  const retry = publicationIdentity(first, { commentary: 'First', mediaId: null }, createId);
  const edited = publicationIdentity(retry, { commentary: 'Edited', mediaId: null }, createId);
  assert.equal(retry.clientId, first.clientId);
  assert.equal(edited.clientId, 'client-2');
});

test('PKCE verifier and S256 challenge are URL-safe', async () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
  const verifier = randomPkceVerifier((target) => { target.set(bytes); return target; });
  assert.equal(verifier, 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8');
  assert.equal(await pkceChallenge(verifier), '6oZqdX5MOLq_qBJ8vppAnT4fk6AP8UiP9zX8-Rev_9A');
});

test('OAuth callback accepts only the exact extension origin and path', () => {
  const expected = 'https://abcdefghijklmnop.chromiumapp.org/annotated';
  assert.equal(oauthCallbackCode(`${expected}?code=one-time-code`, expected), 'one-time-code');
  assert.throws(() => oauthCallbackCode('https://attacker.test/annotated?code=stolen', expected), /did not match/);
  assert.throws(() => oauthCallbackCode('https://abcdefghijklmnop.chromiumapp.org/other?code=stolen', expected), /did not match/);
  assert.throws(() => oauthCallbackCode(`${expected}?code=one&code=two`, expected), /valid code/);
});

test('session storage is scoped to the configured API origin', () => {
  assert.equal(sessionStorageKey({ apiOrigin: 'http://127.0.0.1:4317' }), 'annotated-session:http://127.0.0.1:4317');
  assert.equal(sessionStorageKey({ apiOrigin: 'https://annotated.example.test' }), 'annotated-session:https://annotated.example.test');
});

test('panel rejects stale microphone requests and keeps take drafts through re-recording', async () => {
  const original = {
    document: globalThis.document,
    chrome: globalThis.chrome,
    navigator: globalThis.navigator,
    MediaRecorder: globalThis.MediaRecorder
  };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', disabled: false, src: '', dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, removeAttribute() {}, setAttribute() {}, append() {}, replaceChildren(...children) { this.children = children; }, pause() {}
    });
    return elements.get(id);
  };
  class RecorderStub {
    static isTypeSupported() { return true; }
    constructor(stream, options = {}) { this.stream = stream; this.mimeType = options.mimeType || 'audio/webm'; this.state = 'inactive'; this.listeners = new Map(); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
  }
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const stream = (name) => {
    const track = { name, stopped: false, stop() { this.stopped = true; }, addEventListener() {} };
    return { track, getTracks: () => [track], getAudioTracks: () => [track] };
  };
  const microphoneRequests = [];
  try {
    globalThis.document = { addEventListener() {}, getElementById: element, createElement: () => element(Symbol()) };
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async (message) => message.type === 'ANNOTATED_DISCARD_CAPTURE'
          ? { ok: true, result: { discarded: true, jobId: message.jobId } }
          : { ok: false, error: 'Unexpected test message.' }
      }
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { mediaDevices: { getUserMedia: () => microphoneRequests.shift().promise } }
    });
    globalThis.MediaRecorder = RecorderStub;
    const { __voiceTestHooks: hooks } = await import(`../extension/panel.js?voice-race=${Date.now()}`);
    hooks.state.token = 'local-test-token';
    hooks.state.job = null;
    hooks.state.page = null;

    const requestA = deferred();
    const requestB = deferred();
    microphoneRequests.push(requestA, requestB);
    const pendingA = hooks.startVoice();
    hooks.deleteVoice();
    const pendingB = hooks.startVoice();
    const streamA = stream('A');
    const streamB = stream('B');
    requestA.resolve(streamA);
    await pendingA;
    assert.equal(streamA.track.stopped, true);
    assert.equal(hooks.state.voice.status, 'requesting');
    requestB.resolve(streamB);
    await pendingB;
    assert.equal(hooks.state.voice.status, 'recording');
    assert.equal(streamB.track.stopped, false);

    hooks.disposeVoice();
    hooks.deleteVoice();
    const requestC = deferred();
    const requestD = deferred();
    microphoneRequests.push(requestC, requestD);
    const pendingC = hooks.startVoice();
    hooks.deleteVoice();
    const pendingD = hooks.startVoice();
    requestC.reject(new Error('stale denial'));
    await pendingC;
    assert.equal(hooks.state.voice.status, 'requesting');
    const streamD = stream('D');
    requestD.resolve(streamD);
    await pendingD;
    assert.equal(hooks.state.voice.status, 'recording');
    assert.equal(elements.get('notice').textContent, '');
    hooks.disposeVoice();
    assert.equal(streamD.track.stopped, true);

    hooks.deleteVoice();
    hooks.state.page = { kind: 'video', tabId: 14, url: 'https://example.test/watch', media: [{ id: 'media-1' }] };
    hooks.state.job = { id: 'job-1', status: 'ready', tabId: 14, sourceUrl: 'https://example.test/watch', mediaId: 'media-1', capture: { id: 'clip-1' } };
    element('media-select').value = 'media-1';
    hooks.state.voice.status = 'ready';
    hooks.state.voice.blob = new Blob(['voice']);
    hooks.renderPublishAvailability();
    assert.equal(elements.get('publish').disabled, false);
    hooks.state.voice.status = 'idle';
    hooks.state.voice.blob = null;
    element('commentary').value = 'Keep this draft through another capture.';
    hooks.renderPublishAvailability();
    assert.equal(elements.get('publish').disabled, false);
    hooks.state.publishing = true;
    hooks.renderVoice();
    assert.equal(elements.get('compose').dataset.stage, 'publishing');
    hooks.state.publishing = false;
    const publishedTake = 'Published take '.repeat(30).trim();
    hooks.state.publishedResult = {
      id: 'annotation-1', commentary: publishedTake, excerpt: 'Exact selected source.',
      start: null, end: null, author: { name: 'Mira' },
      source: { kind: 'article', title: 'Fixture article', author: 'Fixture author' }
    };
    hooks.renderVoice();
    assert.equal(elements.get('compose').dataset.stage, 'published');
    assert.equal(elements.get('published-take').textContent, publishedTake);
    assert.equal(elements.get('published-excerpt').children[0].children[0].textContent, 'Exact selected source.');
    assert.match(await readFile(new URL('../extension/panel.html', import.meta.url), 'utf8'), /id="share-image"[^>]*>Share as image<\/button>/);
    const xDraft = new URL(elements.get('post-x').href);
    assert.equal(xDraft.origin + xDraft.pathname, 'https://x.com/intent/post');
    assert.match(xDraft.searchParams.get('text'), /^Published take .*…\n\nOn Source: Fixture article\n\nhttp:\/\/127\.0\.0\.1:4317\/a\/annotation-1$/);
    hooks.state.page = { kind: 'article', tabId: 99, url: 'https://example.test/different-source', excerpt: 'A different selection.' };
    hooks.renderVoice();
    assert.equal(elements.get('published-excerpt').children[0].children[0].textContent, 'Exact selected source.');
    hooks.state.page = { kind: 'video', tabId: 14, url: 'https://example.test/watch', media: [{ id: 'media-1' }] };
    hooks.state.publishedResult = null;
    hooks.renderVoice();
    assert.equal(elements.get('compose').dataset.stage, 'compose');
    await hooks.rerecord();
    assert.equal(hooks.state.job, null);
    assert.equal(elements.get('commentary').value, 'Keep this draft through another capture.');
    assert.equal(elements.get('compose').dataset.stage, 'compose');
    assert.equal(elements.get('publish').disabled, true);
  } finally {
    if (original.document === undefined) delete globalThis.document; else globalThis.document = original.document;
    if (original.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = original.chrome;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: original.navigator });
    if (original.MediaRecorder === undefined) delete globalThis.MediaRecorder; else globalThis.MediaRecorder = original.MediaRecorder;
  }
});

test('worker discards only the exact ready capture', async () => {
  const originalChrome = globalThis.chrome;
  let captureJob = { id: 'ready-1', status: 'ready' };
  const broadcasts = [];
  const listener = { addListener() {} };
  try {
    globalThis.chrome = {
      runtime: {
        onInstalled: listener,
        onStartup: listener,
        onMessage: listener,
        sendMessage: async (message) => { broadcasts.push(message); return { ok: true }; }
      },
      sidePanel: { setPanelBehavior: async () => {} },
      action: { onClicked: listener },
      tabs: { onRemoved: listener, onUpdated: listener },
      storage: {
        session: {
          get: async () => ({ captureJob }),
          set: async (value) => { captureJob = value.captureJob; },
          remove: async (key) => { assert.equal(key, 'captureJob'); captureJob = null; }
        }
      }
    };
    const { discardCapture } = await import(`../extension/service-worker.js?discard=${Date.now()}`);

    assert.deepEqual(await discardCapture('ready-1'), { discarded: true, jobId: 'ready-1' });
    assert.equal(captureJob, null);
    assert.deepEqual(broadcasts.at(-1), { type: 'ANNOTATED_JOB_UPDATE', job: null });

    captureJob = { id: 'newer-ready', status: 'ready' };
    await assert.rejects(discardCapture('ready-1'), /newer captured excerpt/);
    assert.equal(captureJob.id, 'newer-ready');

    captureJob = { id: 'active-1', status: 'recording' };
    await assert.rejects(discardCapture('active-1'), /active capture cannot be discarded/);
    assert.equal(captureJob.status, 'recording');
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
  }
});

test('logout stops and clears account-owned drafts before clearing the scoped session', async () => {
  const original = { document: globalThis.document, chrome: globalThis.chrome, fetch: globalThis.fetch };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', disabled: false, src: '', href: '', dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, removeAttribute() {}, setAttribute() {}, append() {}, replaceChildren(...children) { this.children = children; }, pause() {}
    });
    return elements.get(id);
  };
  const calls = [];
  const track = { stopped: false, stop() { this.stopped = true; } };
  try {
    globalThis.document = { addEventListener() {}, getElementById: element, createElement: () => element(Symbol()) };
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async (message) => { calls.push(message); return { ok: true, result: { cancelled: true } }; }
      },
      storage: { local: { set: async () => {}, remove: async (keys) => { calls.push({ remove: keys }); } } }
    };
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    const { __voiceTestHooks: hooks } = await import(`../extension/panel.js?logout=${Date.now()}`);
    hooks.state.token = 'account-token';
    hooks.state.user = { name: 'Account A' };
    hooks.state.page = null;
    hooks.state.job = { id: 'active-capture', status: 'recording' };
    hooks.state.voice.status = 'recording';
    hooks.state.voice.stream = { getTracks: () => [track] };
    hooks.state.voice.recorder = { state: 'inactive' };
    hooks.state.voice.mediaId = 'owned-voice-media';
    hooks.state.pendingPublication = { fingerprint: 'account-a-draft', clientId: 'account-a-publication' };
    element('commentary').value = 'Keep this typed draft.';

    await hooks.logout();

    assert.equal(track.stopped, true);
    assert.equal(hooks.state.voice.mediaId, null);
    assert.equal(hooks.state.job, null);
    assert.equal(hooks.state.token, null);
    assert.equal(element('commentary').value, '');
    assert.equal(hooks.state.pendingPublication, null);
    assert.equal(calls[0].type, 'ANNOTATED_CANCEL_CAPTURE');
    assert.match(calls.find((call) => call.url)?.options.headers.Authorization, /^Bearer /);
    assert.ok(calls.some((call) => Array.isArray(call.remove) && call.remove.some((key) => key.startsWith('annotated-session:'))));
  } finally {
    if (original.document === undefined) delete globalThis.document; else globalThis.document = original.document;
    if (original.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = original.chrome;
    if (original.fetch === undefined) delete globalThis.fetch; else globalThis.fetch = original.fetch;
  }
});

test('401 transition aborts uploads and cannot leave another account a ready draft', async () => {
  const original = { document: globalThis.document, chrome: globalThis.chrome };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', disabled: false, src: '', dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, removeAttribute() {}, setAttribute() {}, append() {}, replaceChildren(...children) { this.children = children; }, pause() {}
    });
    return elements.get(id);
  };
  let uploadAborted = false;
  try {
    globalThis.document = { addEventListener() {}, getElementById: element, createElement: () => element(Symbol()) };
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async () => ({ ok: true, result: { discarded: true, jobId: 'ready-capture' } })
      },
      storage: { local: { remove: async () => {} } }
    };
    const { __voiceTestHooks: hooks } = await import(`../extension/panel.js?unauthorized=${Date.now()}`);
    hooks.state.token = 'expired-token';
    hooks.state.user = { name: 'Account A' };
    hooks.state.page = null;
    hooks.state.job = { id: 'ready-capture', status: 'ready' };
    hooks.state.voice.status = 'uploading';
    hooks.state.voice.blob = new Blob(['private voice draft']);
    hooks.state.voice.mediaId = 'owned-voice-media';
    hooks.state.voice.uploadAbort = { abort() { uploadAborted = true; } };
    hooks.state.pendingPublication = { fingerprint: 'account-a-draft', clientId: 'account-a-publication' };
    element('commentary').value = 'Account A private draft.';

    await hooks.handleUnauthorizedSession();

    assert.equal(uploadAborted, true);
    assert.equal(hooks.state.token, null);
    assert.equal(hooks.state.user, null);
    assert.equal(hooks.state.job, null);
    assert.equal(hooks.state.voice.status, 'idle');
    assert.equal(hooks.state.voice.blob, null);
    assert.equal(hooks.state.voice.mediaId, null);
    assert.equal(hooks.state.pendingPublication, null);
    assert.equal(element('commentary').value, '');
  } finally {
    if (original.document === undefined) delete globalThis.document; else globalThis.document = original.document;
    if (original.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = original.chrome;
  }
});

test('expired bootstrap session discards a persisted worker capture before refresh can restore it', async () => {
  const original = { document: globalThis.document, chrome: globalThis.chrome, fetch: globalThis.fetch };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', disabled: false, src: '', dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, removeAttribute() {}, setAttribute() {}, append() {}, replaceChildren(...children) { this.children = children; }, pause() {}
    });
    return elements.get(id);
  };
  const runtimeMessages = [];
  try {
    globalThis.document = { addEventListener() {}, getElementById: element, createElement: () => element(Symbol()) };
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async (message) => {
          runtimeMessages.push(message);
          if (message.type === 'ANNOTATED_PANEL_BOOTSTRAP') return {
            ok: true,
            result: { page: { kind: 'article' }, job: { id: 'persisted-ready', status: 'ready' } }
          };
          return { ok: true, result: { discarded: true, jobId: message.jobId } };
        }
      },
      storage: { local: { set: async () => {}, remove: async () => {} } }
    };
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ user: null }) });
    const { __voiceTestHooks: hooks } = await import(`../extension/panel.js?expired-bootstrap=${Date.now()}`);
    hooks.state.token = 'expired-token';
    hooks.state.user = { id: 'account-a', name: 'Account A' };
    hooks.state.page = null;
    hooks.state.job = null;
    hooks.state.pendingPublication = { fingerprint: 'account-a-draft', clientId: 'retry-id' };
    element('commentary').value = 'Account A draft.';

    await hooks.revalidateSession();

    assert.deepEqual(runtimeMessages.map((message) => message.type), ['ANNOTATED_PANEL_BOOTSTRAP', 'ANNOTATED_DISCARD_CAPTURE']);
    assert.equal(runtimeMessages[1].jobId, 'persisted-ready');
    assert.equal(hooks.state.token, null);
    assert.equal(hooks.state.job, null);
    assert.equal(hooks.state.pendingPublication, null);
    assert.equal(element('commentary').value, '');
  } finally {
    if (original.document === undefined) delete globalThis.document; else globalThis.document = original.document;
    if (original.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = original.chrome;
    if (original.fetch === undefined) delete globalThis.fetch; else globalThis.fetch = original.fetch;
  }
});

test('signing in as a different user clears the previous account draft first', async () => {
  const original = { document: globalThis.document, chrome: globalThis.chrome };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', disabled: false, src: '', dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, removeAttribute() {}, setAttribute() {}, append() {}, replaceChildren(...children) { this.children = children; }, pause() {}
    });
    return elements.get(id);
  };
  try {
    globalThis.document = { addEventListener() {}, getElementById: element, createElement: () => element(Symbol()) };
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async (message) => message.type === 'ANNOTATED_DISCARD_CAPTURE'
          ? { ok: true, result: { discarded: true, jobId: message.jobId } }
          : { ok: true, result: { page: null, job: null } }
      },
      storage: { local: { set: async () => {}, remove: async () => {} } }
    };
    const { __voiceTestHooks: hooks } = await import(`../extension/panel.js?identity-change=${Date.now()}`);
    hooks.state.token = 'account-a-token';
    hooks.state.user = { id: 'account-a', name: 'Account A' };
    hooks.state.page = null;
    hooks.state.job = { id: 'account-a-ready', status: 'ready' };
    hooks.state.voice.status = 'ready';
    hooks.state.voice.blob = new Blob(['account a voice']);
    hooks.state.pendingPublication = { fingerprint: 'account-a-draft', clientId: 'retry-id' };
    element('commentary').value = 'Account A draft.';

    await hooks.acceptSession({ token: 'account-b-token', user: { id: 'account-b', name: 'Account B' } });

    assert.equal(hooks.state.token, 'account-b-token');
    assert.equal(hooks.state.user.id, 'account-b');
    assert.equal(hooks.state.job, null);
    assert.equal(hooks.state.voice.blob, null);
    assert.equal(hooks.state.pendingPublication, null);
    assert.equal(element('commentary').value, '');
  } finally {
    if (original.document === undefined) delete globalThis.document; else globalThis.document = original.document;
    if (original.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = original.chrome;
  }
});
