import test from 'node:test';
import assert from 'node:assert/strict';
import { createMicrophoneSetup } from '../extension/microphone.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(getUserMedia, tabs = {}, search = '') {
  const elements = new Map();
  const listeners = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      const classes = new Set(['hidden']);
      elements.set(id, {
        textContent: '', disabled: false,
        classList: {
          add: (name) => classes.add(name),
          remove: (name) => classes.delete(name),
          toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
          contains: (name) => classes.has(name)
        },
        addEventListener(type, callback) { listeners.set(`${id}:${type}`, callback); }
      });
    }
    return elements.get(id);
  };
  const page = createMicrophoneSetup({
    document: { getElementById: element },
    window: { location: { search }, addEventListener(type, callback) { listeners.set(type, callback); } },
    navigator: { mediaDevices: { getUserMedia } },
    chrome: { tabs, windows: tabs.windows || {} }
  });
  return { page, element, listeners };
}

function stream() {
  const tracks = [{ stops: 0, stop() { this.stops += 1; } }, { stops: 0, stop() { this.stops += 1; } }];
  return { tracks, getTracks: () => tracks };
}

test('setup asks only after a click and stops every track immediately on grant', async () => {
  const media = stream();
  const calls = [];
  const view = setup(async (constraints) => { calls.push(constraints); return media; });
  assert.equal(calls.length, 0);
  await view.listeners.get('enable-microphone:click')();
  assert.deepEqual(calls, [{ audio: true, video: false }]);
  assert.deepEqual(media.tracks.map((track) => track.stops), [1, 1]);
  assert.match(view.element('microphone-status').textContent, /microphone is off/i);
  assert.equal(view.element('enable-microphone').classList.contains('hidden'), true);
});

test('cancel and pagehide discard a pending permission result and stop late tracks', async () => {
  for (const exit of ['return-to-source:click', 'pagehide']) {
    const pending = deferred();
    const media = stream();
    const view = setup(() => pending.promise, {
      getCurrent: async () => null
    });
    const request = view.listeners.get('enable-microphone:click')();
    await view.listeners.get(exit)();
    pending.resolve(media);
    await request;
    assert.deepEqual(media.tracks.map((track) => track.stops), [1, 1], exit);
    assert.doesNotMatch(view.element('microphone-status').textContent, /access is allowed/i);
  }
});

test('denied access gives recovery instructions and permits retry', async () => {
  const view = setup(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); });
  await view.page.request();
  assert.match(view.element('microphone-status').textContent, /not granted/i);
  assert.match(view.element('microphone-help').textContent, /Site settings → Microphone/);
  assert.match(view.element('microphone-help').textContent, /Privacy & Security → Microphone/);
  assert.equal(view.element('enable-microphone').disabled, false);
});

test('return activates only the opener tab and closes setup', async () => {
  const actions = [];
  const view = setup(async () => stream(), {
    getCurrent: async () => ({ id: 20, openerTabId: 12 }),
    get: async (id) => { actions.push(['get', id]); return { id, windowId: 2 }; },
    update: async (id, options) => { actions.push(['update', id, options]); },
    remove: async (id) => { actions.push(['remove', id]); },
    windows: { update: async (id, options) => { actions.push(['window', id, options]); } }
  });
  await view.page.returnToSource();
  assert.deepEqual(actions, [
    ['get', 12], ['update', 12, { active: true }],
    ['window', 2, { focused: true }], ['remove', 20]
  ]);
});

test('permission tab stops its microphone and returns to source without closing a temporary grant', async () => {
  const media = stream();
  const actions = [];
  const view = setup(async () => media, {
    getCurrent: async () => ({ id: 30 }),
    get: async (id) => ({ id, windowId: 2 }),
    update: async (id) => { assert.ok(media.tracks.every(track => track.stops === 1)); actions.push(['source', id]); },
    remove: async (id) => { actions.push(['close', id]); },
    windows: { update: async (id) => actions.push(['window', id]) }
  }, '?returnAfterGrant=1&sourceTab=12');
  await view.page.request();
  assert.deepEqual(actions, [['source', 12], ['window', 2]]);
  assert.match(view.element('microphone-help').textContent, /Keep this tab open/);
});

test('dismissed permission remains in the current tab without opening another helper', async () => {
  const view = setup(async () => { throw Object.assign(new Error('dismissed'), { name: 'NotAllowedError' }); }, {}, '?returnAfterGrant=1&sourceTab=12');
  await view.page.request();
  assert.equal(view.element('enable-microphone').disabled, false);
  assert.match(view.element('microphone-status').textContent, /not granted/i);
  assert.equal(view.listeners.has('open-full-tab:click'), false);
});

test('a missing source after permission grant still explains temporary permission', async () => {
  const media = stream();
  const view = setup(async () => media, {
    getCurrent: async () => ({ id: 30 }),
    get: async () => { throw new Error('Source tab closed'); }
  }, '?returnAfterGrant=1&sourceTab=12');
  await view.page.request();
  assert.deepEqual(media.tracks.map(track => track.stops), [1, 1]);
  assert.match(view.element('microphone-status').textContent, /Switch back/);
  assert.match(view.element('microphone-help').textContent, /Keep this tab open/);
});
