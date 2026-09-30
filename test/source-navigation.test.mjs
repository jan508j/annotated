import test from 'node:test';
import assert from 'node:assert/strict';

const source = (id) => ({ tabId: id, url: `https://example.test/article-${id}`, title: `Article ${id}`, kind: 'article', media: [], excerpt: 'Selected evidence.' });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function panelHarness(run) {
  const original = { chrome: globalThis.chrome, document: globalThis.document, fetch: globalThis.fetch };
  const elements = new Map();
  const listeners = {};
  const calls = [];
  let bootstrap = async () => ({ ok: true, result: { page: source(14), job: null } });
  let fetcher = async () => ({ annotations: [] });
  const element = (id) => {
    if (!elements.has(id)) {
      const classes = new Set(['source-workspace', 'discussion', 'paused-draft'].includes(id) ? ['hidden'] : []);
      elements.set(id, {
        value: '', textContent: '', disabled: false, dataset: {}, style: {},
        classList: {
          add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
          toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
          contains(name) { return classes.has(name); }
        },
        setAttribute() {}, removeAttribute() {}, pause() {}, append(...children) { this.children = [...(this.children || []), ...children]; }, addEventListener() {}, replaceChildren(...children) { this.children = children; }
      });
    }
    return elements.get(id);
  };
  try {
    globalThis.document = { addEventListener() {}, getElementById: element, createElement: () => element(Symbol()) };
    globalThis.chrome = {
      runtime: { onMessage: { addListener() {} }, async sendMessage(message) { calls.push(message); return bootstrap(message); } },
      tabs: {
        onActivated: { addListener(fn) { listeners.activated = fn; } },
        onUpdated: { addListener(fn) { listeners.updated = fn; } },
        onRemoved: { addListener(fn) { listeners.removed = fn; } }
      }
    };
    globalThis.fetch = async (url, options) => ({
      ok: true, status: 200, json: async () => fetcher(url, options)
    });
    const { __voiceTestHooks: hooks } = await import(`../extension/panel.js?navigation=${Math.random()}`);
    hooks.state.windowId = 2;
    hooks.state.token = 'local-test-token';
    hooks.state.user = { name: 'Test reader' };
    hooks.bindSourceEvents();
    await run({ hooks, element, listeners, calls, setBootstrap(fn) { bootstrap = fn; }, setFetcher(fn) { fetcher = fn; } });
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
}

test('same-window tab activation updates the source and clears an old published result', async () => panelHarness(async ({ hooks, element, listeners, setBootstrap }) => {
  await hooks.refresh();
  hooks.state.publishedResult = { id: 'saved-14', source: { title: 'Article 14' } };
  setBootstrap(async () => ({ ok: true, result: { page: source(15), job: null } }));
  listeners.activated({ tabId: 15, windowId: 3 });
  await tick();
  assert.equal(hooks.state.page.tabId, 14, 'other windows do not replace the panel source');
  listeners.activated({ tabId: 15, windowId: 2 });
  await tick();
  assert.equal(hooks.state.page.tabId, 15);
  assert.equal(element('source-title').textContent, 'Article 15');
  assert.equal(hooks.state.publishedResult, null);
  assert.equal(element('source-workspace').classList.contains('hidden'), false);
}));

test('pending or denied navigation hides old source and invalidates an in-flight discussion lookup', async () => panelHarness(async ({ hooks, element, listeners, setBootstrap, setFetcher }) => {
  await hooks.refresh();
  const oldLookup = deferred();
  setFetcher(() => oldLookup.promise);
  const lookup = hooks.lookupSource();
  const next = deferred();
  setBootstrap(() => next.promise);
  listeners.updated(14, { status: 'loading' }, { active: true, windowId: 2 });
  assert.equal(element('source-workspace').classList.contains('hidden'), true);
  assert.equal(element('discussion').classList.contains('hidden'), true);
  assert.equal(hooks.state.lookup, null);
  assert.equal(element('publish').disabled, true);
  listeners.updated(14, { status: 'complete' }, { active: true, windowId: 2 });
  oldLookup.resolve({ annotations: [{ id: 'old' }] });
  await lookup;
  assert.equal(hooks.state.lookup, null, 'old lookup cannot restore old discussion');
  next.resolve({ ok: false, error: 'Connect this page: click the Annotated icon.' });
  await tick();
  assert.equal(element('source-workspace').classList.contains('hidden'), true);
  assert.match(element('notice').textContent, /click the Annotated icon/);
}));

test('an unfinished take stays bound to its source until return or explicit discard', async () => panelHarness(async ({ hooks, element, listeners, setBootstrap }) => {
  await hooks.refresh();
  element('commentary').value = 'My unfinished take for article 14.';
  setBootstrap(async () => ({ ok: true, result: { page: source(15), job: null } }));
  listeners.activated({ tabId: 15, windowId: 2 });
  await tick();
  assert.equal(hooks.state.page.tabId, 14);
  assert.equal(element('paused-draft').classList.contains('hidden'), false);
  assert.match(element('paused-draft-source').textContent, /Article 14/);
  assert.equal(element('commentary').value, 'My unfinished take for article 14.');
  assert.equal(element('publish').disabled, true);
  setBootstrap(async () => ({ ok: true, result: { page: source(14), job: null } }));
  listeners.activated({ tabId: 14, windowId: 2 });
  await tick();
  assert.equal(element('paused-draft').classList.contains('hidden'), true);
  assert.equal(element('commentary').value, 'My unfinished take for article 14.');
  assert.equal(element('publish').disabled, false);
  setBootstrap(async () => ({ ok: true, result: { page: source(15), job: null } }));
  listeners.activated({ tabId: 15, windowId: 2 });
  await tick();
  await hooks.discardPausedDraft();
  assert.equal(hooks.state.page.tabId, 15);
  assert.equal(element('commentary').value, '');
  assert.equal(element('paused-draft').classList.contains('hidden'), true);
}));

test('a switch during publication posts the original source and refreshes after the post settles', async () => panelHarness(async ({ hooks, element, listeners, setBootstrap, setFetcher }) => {
  await hooks.refresh();
  hooks.state.page.publisher = 'Example Gazette';
  hooks.state.page.author = 'Jane Reporter';
  element('commentary').value = 'A completed take.';
  const post = deferred();
  let posted;
  setFetcher((url, options) => {
    if (url.endsWith('/api/annotations')) {
      posted = JSON.parse(options.body);
      return post.promise;
    }
    return { annotations: [] };
  });
  const publishing = hooks.publish();
  await tick();
  assert.equal(posted.source.url, source(14).url);
  assert.equal(posted.source.publisher, 'Example Gazette');
  assert.equal(posted.source.author, 'Jane Reporter');
  setBootstrap(async () => ({ ok: true, result: { page: source(15), job: null } }));
  listeners.activated({ tabId: 15, windowId: 2 });
  assert.equal(element('source-workspace').classList.contains('hidden'), true);
  post.resolve({ annotation: { id: 'saved-14', source: { title: 'Article 14' }, commentary: 'A completed take.' } });
  await publishing;
  assert.equal(hooks.state.page.tabId, 15);
  assert.equal(hooks.state.publishedResult, null);
  assert.equal(element('source-title').textContent, 'Article 15');
}));

test('a delayed YouTube title update changes attribution without refreshing or resetting a draft', async () => panelHarness(async ({ hooks, element, listeners, calls, setBootstrap }) => {
  const page = { ...source(14), url: 'https://www.youtube.com/watch?v=new-video', title: 'Previous video' };
  setBootstrap(async () => ({ ok: true, result: { page, job: null } }));
  await hooks.refresh();
  element('commentary').value = 'Keep my take.';
  element('range-start').value = '31.9';
  element('range-end').value = '37.5';
  hooks.state.job = { id: 'existing-clip', status: 'ready', tabId: 14, sourceUrl: page.url };
  const job = hooks.state.job;
  const lookup = hooks.state.lookup;
  const before = calls.length;
  listeners.updated(14, { title: 'Justin Timberlake - Say Something - YouTube' }, { active: true, windowId: 2, url: page.url });
  await tick();
  assert.equal(element('source-title').textContent, 'Justin Timberlake - Say Something');
  assert.equal(hooks.state.page.title, 'Justin Timberlake - Say Something - YouTube');
  assert.equal(element('commentary').value, 'Keep my take.');
  assert.equal(element('range-start').value, '31.9');
  assert.equal(element('range-end').value, '37.5');
  assert.equal(hooks.state.job, job);
  assert.equal(hooks.state.lookup, lookup);
  assert.equal(calls.length, before, 'title-only updates must not restart discovery, capture or input');
  listeners.updated(15, { title: 'Other window - YouTube' }, { active: true, windowId: 3, url: page.url });
  listeners.updated(14, { title: 'Another source - YouTube' }, { active: true, windowId: 2, url: 'https://www.youtube.com/watch?v=other' });
  listeners.updated(14, { title: '   ' }, { active: true, windowId: 2, url: page.url });
  assert.equal(element('source-title').textContent, 'Justin Timberlake - Say Something');
}));

test('a YouTube title arriving during navigation supersedes the earlier stale discovery', async () => panelHarness(async ({ hooks, element, listeners, setBootstrap, setFetcher }) => {
  setBootstrap(async () => ({ ok: true, result: { page: { ...source(14), excerpt: '' }, job: null } }));
  await hooks.refresh();
  const url = 'https://www.youtube.com/watch?v=next-video';
  const lookupFinished = deferred();
  setFetcher(() => { lookupFinished.resolve(); return { annotations: [] }; });
  const olderDiscovery = deferred();
  setBootstrap(() => olderDiscovery.promise);
  listeners.updated(14, { url }, { active: true, windowId: 2, url });
  assert.equal(hooks.state.pageAccessBlocked, true);
  setBootstrap(async () => ({ ok: true, result: { page: { ...source(14), url, title: 'New video - YouTube' }, job: null } }));
  listeners.updated(14, { title: 'New video - YouTube' }, { active: true, windowId: 2, url });
  await tick();
  assert.equal(element('source-title').textContent, 'New video');
  olderDiscovery.resolve({ ok: true, result: { page: { ...source(14), url, title: 'Previous video' }, job: null } });
  // Title rendering precedes the asynchronous source-key lookup. Let its API
  // continuation settle before the harness removes the document mock.
  await lookupFinished.promise;
  await tick();
  assert.equal(element('source-title').textContent, 'New video');
  assert.equal(hooks.state.page.url, url);
  assert.equal(hooks.state.pageAccessBlocked, false);
}));
