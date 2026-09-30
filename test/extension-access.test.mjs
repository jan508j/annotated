import test from 'node:test';
import assert from 'node:assert/strict';

test('a toolbar invocation connects an inaccessible public tab without toggling the panel closed', async () => {
  const original = globalThis.chrome;
  const events = {};
  const event = (name) => ({ addListener(fn) { events[name] = fn; } });
  const requests = [], injections = [], opened = [], notifications = [], behaviors = [];
  let tab = { id: 14, windowId: 2 }; // Chrome hides the URL without activeTab.
  let injected = false;
  try {
    globalThis.chrome = {
      runtime: { onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message'),
        async sendMessage(message) { notifications.push(message); } },
      action: { onClicked: event('action') },
      sidePanel: {
        async setPanelBehavior(behavior) { behaviors.push(behavior); },
        async open(options) { opened.push(options); }
      },
      tabs: {
        onRemoved: event('removed'), onUpdated: event('updated'),
        async query(query) { requests.push(query); return [tab]; },
        async sendMessage() {
          if (!injected) throw new Error('Receiving end does not exist.');
          return { ok: true, result: { url: tab.url, kind: 'article', excerpt: 'A selected passage.' } };
        }
      },
      scripting: { async executeScript(options) { injections.push(options); injected = true; } },
      storage: { session: { async get() { return {}; } } }
    };
    await import(`../extension/service-worker.js?access=${Date.now()}`);
    const bootstrap = () => new Promise((resolve) => events.message({ type: 'ANNOTATED_PANEL_BOOTSTRAP', windowId: 2 }, {}, resolve));
    const denied = await bootstrap();
    assert.equal(denied.ok, false);
    assert.match(denied.error, /click the Annotated icon/i);
    assert.doesNotMatch(denied.error, /works on public/);
    assert.equal(injections.length, 0);

    events.installed();
    assert.deepEqual(behaviors, [{ openPanelOnActionClick: false }]);
    tab = { ...tab, url: 'https://www.reuters.com/example-article/' };
    events.action(tab); // Represents Chrome granting activeTab on this gesture.
    assert.deepEqual(opened, [{ windowId: 2 }]); // open() happens before any await.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(notifications, [{ type: 'ANNOTATED_PAGE_ACCESS_GRANTED', windowId: 2 }]);
    const allowed = await bootstrap();
    assert.equal(allowed.ok, true);
    assert.equal(allowed.result.page.excerpt, 'A selected passage.');
    assert.equal(allowed.result.page.tabId, 14);
    assert.deepEqual(injections, [{ target: { tabId: 14 }, files: ['content-script.js'] }]);
    assert.ok(requests.every((query) => query.windowId === 2 && !('currentWindow' in query)));

    tab = { ...tab, url: 'chrome://extensions/' };
    assert.match((await bootstrap()).error, /Chrome or local-file page/);
    assert.equal(injections.length, 1);
    tab = { id: 15, windowId: 2 }; // Switching tabs requires a fresh gesture.
    assert.match((await bootstrap()).error, /click the Annotated icon/i);
  } finally {
    if (original === undefined) delete globalThis.chrome; else globalThis.chrome = original;
  }
});

test('panel reconnect is window-scoped, preserves a draft and ignores stale refresh results', async () => {
  const original = { chrome: globalThis.chrome, document: globalThis.document, fetch: globalThis.fetch };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', disabled: false, dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, removeAttribute() {}, pause() {}, addEventListener() {}, append(...children) { this.children = [...(this.children || []), ...children]; }, replaceChildren(...children) { this.children = children; }
    });
    return elements.get(id);
  };
  let receive;
  const source = (id) => ({ tabId: id, url: `https://example.test/article-${id}`, title: `Article ${id}`, kind: 'article', media: [], excerpt: 'Selected evidence.' });
  let result = { ok: false, error: 'Connect this page: click the Annotated icon.' };
  const requests = [];
  try {
    globalThis.document = { addEventListener() {}, getElementById: element, createElement: () => element(Symbol()) };
    globalThis.chrome = { runtime: {
      onMessage: { addListener(fn) { receive = fn; } },
      async sendMessage(message) { requests.push(message); return result; }
    } };
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ annotations: [] }) });
    const { __voiceTestHooks: hooks } = await import(`../extension/panel.js?access=${Date.now()}`);
    hooks.state.windowId = 2;
    hooks.state.token = 'local-test-token';
    await hooks.refresh();
    assert.match(element('notice').textContent, /click the Annotated icon/);
    assert.equal(hooks.state.page, null);
    assert.equal(element('publish').disabled, true);

    result = { ok: true, result: { page: source(14), job: null } };
    receive({ type: 'ANNOTATED_PAGE_ACCESS_GRANTED', windowId: 3 });
    assert.equal(requests.length, 1);
    receive({ type: 'ANNOTATED_PAGE_ACCESS_GRANTED', windowId: 2 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(hooks.state.page.tabId, 14);
    assert.equal(hooks.state.pageAccessBlocked, false);
    assert.match(element('publish-hint').textContent, /Write or dictate your take/);
    assert.ok(requests.every((request) => request.windowId === 2));
    element('commentary').value = 'My unfinished take about article 14.';
    await hooks.refresh();
    assert.equal(element('commentary').value, 'My unfinished take about article 14.');
    assert.equal(element('publish').disabled, false);

    result = { ok: true, result: { page: { ...source(14), excerpt: 'A newly highlighted sentence.' }, job: null } };
    await hooks.refresh();
    assert.equal(hooks.state.page.excerpt, 'Selected evidence.', 'Ordinary refresh keeps the attached passage');
    await hooks.refresh({ useSelection: true, replaceIndex: 0 });
    assert.equal(hooks.state.page.excerpt, 'A newly highlighted sentence.');
    assert.equal(element('excerpt').children[0].children[0].children[0].textContent, 'A newly highlighted sentence.');
    assert.equal(element('commentary').value, 'My unfinished take about article 14.');
    assert.match(element('highlight-count').textContent, /100 WORDS/);
    result = { ok: true, result: { page: { ...source(14), excerpt: '' }, job: null } };
    await hooks.refresh({ useSelection: true });
    assert.equal(hooks.state.page.excerpt, 'A newly highlighted sentence.');
    assert.match(element('selection-status').textContent, /No new highlight found/);

    result = { ok: false, error: 'Connect this page: click the Annotated icon.' };
    await hooks.refresh();
    assert.equal(hooks.state.page.tabId, 14);
    result = { ok: true, result: { page: source(15), job: null } };
    await hooks.refresh();
    assert.equal(hooks.state.page.tabId, 14);
    assert.match(element('notice').textContent, /draft still belongs/);
    assert.equal(element('publish').disabled, true);
    assert.equal(element('commentary').value, 'My unfinished take about article 14.');

    result = { ok: true, result: { page: source(14), job: null } };
    await hooks.refresh();
    assert.equal(element('publish').disabled, false);
    element('commentary').value = '';
    hooks.state.page.excerpt = '';
    hooks.state.page.excerpts = [];
    let resolveOld;
    result = new Promise((resolve) => { resolveOld = resolve; });
    const old = hooks.refresh();
    result = { ok: true, result: { page: source(16), job: null } };
    await hooks.refresh();
    resolveOld({ ok: true, result: { page: source(15), job: null } });
    await old;
    assert.equal(hooks.state.page.tabId, 16);
    assert.equal(element('source-title').textContent, 'Article 16');

    hooks.state.publishedResult = { id: 'published-on-16', commentary: 'Already published', source: { title: 'Article 16', kind: 'article' } };
    hooks.state.lookup = { annotations: [{ id: 'old-source-note' }] };
    result = { ok: true, result: { page: source(17), job: null } };
    await hooks.refresh();
    assert.equal(hooks.state.publishedResult, null, 'A published receipt must not follow the reader to another source');
    assert.deepEqual(hooks.state.lookup, { annotations: [] });
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
});
