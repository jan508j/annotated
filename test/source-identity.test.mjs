import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { displaySourceTitle, sourceExcerpts, sourceIdentity, xShareIntent } from '../shared/source-identity.mjs';

test('X sharing leads with the actual take, followed by source context and the receipt link', () => {
  const permalink = 'https://annotated.example/a/annotation-123';
  const intent = new URL(xShareIntent({
    commentary: 'One in eight. That’s the headline.', excerpt: 'Quoted source evidence.',
    source: { url: 'https://reuters.com/world/story', title: 'A warmer world | Reuters', publisher: 'Reuters' }
  }, permalink));
  assert.equal(intent.origin + intent.pathname, 'https://x.com/intent/post');
  assert.equal(intent.searchParams.get('text'), `One in eight. That’s the headline.\n\nOn Reuters: A warmer world\n\n${permalink}`);
});

test('X sharing shortens long multilingual text without splitting graphemes or losing source/link', () => {
  const permalink = 'https://annotated.example/a/annotation-123';
  const text = new URL(xShareIntent({
    commentary: '👩🏽‍💻 中文 e\u0301 '.repeat(60),
    source: { url: 'https://youtube.com/watch?v=123', title: 'Long video title '.repeat(20) }
  }, permalink)).searchParams.get('text');
  const [take, context, link] = text.split('\n\n');
  assert.match(take, /^(?:👩🏽‍💻 中文 é )*(?:👩🏽‍💻(?: 中文(?: é)?)?)?…$/u);
  assert.match(context, /^On YouTube: Long video title /);
  assert.ok(context.endsWith('…'));
  assert.equal(link, permalink);
  // Counting every non-ASCII code point as two is an upper bound here.
  assert.ok(Array.from(`${take}\n\n${context}\n\n`).reduce((n, char) => n + (char.codePointAt(0) < 128 ? 1 : 2), 23) <= 280);
});

test('X sharing keeps URLs whole and reserves their shortened length even for tiny links', () => {
  const link = 'https://annotated.example/a/annotation-123';
  const text = new URL(xShareIntent({ commentary: 'x.co '.repeat(80), source: { title: 'Fixture' } }, link)).searchParams.get('text');
  const [take, context, permalink] = text.split('\n\n');
  assert.match(take, /^(?:x\.co )*x\.co…$/);
  assert.ok((take.match(/x\.co/g) || []).length * 24 + context.length + 4 + 23 + 2 <= 280);
  assert.equal(permalink, link);
});

test('voice-only X sharing stays neutral and does not turn source evidence into a take', () => {
  const text = new URL(xShareIntent({ voiceUrl: '/voice.webm', excerpt: 'Source quote', source: { title: 'Fixture' } }, 'https://annotated.example/a/voice')).searchParams.get('text');
  assert.match(text, /^A voice take\.\n\nOn Source: Fixture\n\n/);
  assert.ok(!text.includes('Source quote'));
});

test('recognizes saved X post identity from URL and older page title', () => {
  const source = {
    url: 'https://x.com/author_name/status/1234567890',
    title: '(1) Jane Doe on X: "A short post about the source" / X',
    author: ''
  };
  assert.deepEqual(sourceIdentity(source), {
    platform: 'x', publisher: 'X', badge: 'X', author: 'Jane Doe', handle: '@author_name'
  });
  assert.equal(displaySourceTitle(source), 'A short post about the source');
});

test('keeps publisher and byline separate for an ordinary article', () => {
  const source = { url: 'https://www.reuters.com/world/story', title: 'Story headline | Reuters', author: 'Jane Doe', publisher: 'Reuters' };
  assert.equal(sourceIdentity(source).publisher, 'Reuters');
  assert.equal(sourceIdentity(source).author, 'Jane Doe');
  assert.equal(displaySourceTitle(source), 'Story headline');
  assert.equal(sourceIdentity({ url: source.url }).publisher, 'Reuters');
});

test('prefers explicit bounded publisher metadata while keeping platform identities', () => {
  const article = sourceIdentity({ url: 'https://news.example/story', title: 'A story', author: 'Jane Reporter', publisher: '  Example   Gazette  ' });
  assert.equal(article.publisher, 'Example Gazette');
  assert.equal(article.author, 'Jane Reporter');
  assert.equal(sourceIdentity({ url: 'https://news.example/story', publisher: '<b>' }).publisher, 'news.example');
  assert.equal(sourceIdentity({ url: 'https://x.com/jane/status/123', publisher: 'Other' }).publisher, 'X');
  assert.equal(sourceIdentity({ url: 'https://youtube.com/watch?v=fixture', publisher: 'Other' }).publisher, 'YouTube');
});

test('page discovery keeps metadata publisher separate from article author', async () => {
  const script = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8');
  for (const [siteName, jsonLd, expected] of [
    ['The Daily & Review', '', 'The Daily & Review'],
    ['', '{"@graph":[{"@type":"NewsArticle","publisher":{"name":"Example Gazette"}}]}', 'Example Gazette']
  ]) {
    let receive;
    runInNewContext(script, {
      location: { href: 'https://news.example/story', hostname: 'news.example' },
      URL, getSelection: () => null,
      document: {
        title: 'Article title', addEventListener() {},
        querySelector: selector => selector === 'meta[property="og:site_name"]' && siteName ? { content: siteName }
          : selector === 'meta[name="author"]' ? { content: 'Jane Reporter' } : null,
        querySelectorAll: selector => selector === 'script[type="application/ld+json"]' && jsonLd ? [{ textContent: jsonLd }] : []
      },
      chrome: { runtime: { onMessage: { addListener(callback) { receive = callback; } } } }
    });
    const page = await new Promise(resolve => receive({ type: 'ANNOTATED_DISCOVER' }, {}, response => resolve(response.result)));
    assert.equal(page.publisher, expected);
    assert.equal(page.author, 'Jane Reporter');
  }
});

test('recognizes YouTube source variants without branding unrelated domains', () => {
  for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']) {
    const identity = sourceIdentity({ url: `https://${host}/watch?v=fixture` });
    assert.equal(identity.platform, 'youtube');
    assert.equal(identity.publisher, 'YouTube');
    assert.equal(identity.badge, '▶');
  }
  for (const host of ['notyoutube.com', 'youtube.com.example.org', 'example.org']) {
    const identity = sourceIdentity({ url: `https://${host}/watch?v=fixture`, title: 'YouTube video' });
    assert.equal(identity.platform, 'web');
    assert.equal(identity.badge, host[0].toUpperCase());
  }
});

test('separate excerpts take precedence over a joined legacy quote', () => {
  assert.deepEqual(sourceExcerpts({ excerpt: 'One.\n\n[…]\n\nTwo.', excerpts: ['One.', 'Two.'] }), ['One.', 'Two.']);
  assert.deepEqual(sourceExcerpts({ excerpt: 'Stale legacy quote.', excerpts: [] }), []);
  assert.deepEqual(sourceExcerpts({ excerpt: 'Legacy quote.' }), ['Legacy quote.']);
});

test('X snapshot binds main post and selection to the URL, despite replies and focus loss', async () => {
  const script = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8');
  let receive;
  const events = {};
  let selection = null;
  const makePost = (handle, name, text, id) => {
    const profileLink = { getAttribute: () => `/${handle}`, querySelector: () => ({ textContent: name }), textContent: `${name}@${handle}` };
    const timestampLink = { getAttribute: () => `/${handle}/status/${id}` };
    return {
      setText(value) { text = value; },
      querySelector(selector) {
        if (selector === 'time') return { closest: () => timestampLink };
        if (selector === '[data-testid="User-Name"]') return { querySelectorAll: () => [profileLink], textContent: `${name}@${handle} · Sep 25` };
        if (selector === '[data-testid="tweetText"]') return { textContent: text };
        return null;
      }
    };
  };
  const mainPost = makePost('jane', 'Jane Doe', 'The original post text.', '1234567890');
  const reply = makePost('bob', 'Bob Smith', 'A reply with different evidence.', '9999999999');
  const select = (article, text) => {
    selection = text ? {
      isCollapsed: false, rangeCount: 1,
      getRangeAt: () => ({ commonAncestorContainer: { nodeType: 1, closest: (selector) => selector === 'article' ? article : null }, intersectsNode: () => false }),
      toString: () => text
    } : null;
    events.selectionchange();
  };
  runInNewContext(script, {
    location: { href: 'https://x.com/jane/status/1234567890', hostname: 'x.com' },
    URL, Node: { ELEMENT_NODE: 1 }, getSelection: () => selection,
    document: {
      title: '(9) Jane Doe on X: a stale title',
      addEventListener(name, callback) { events[name] = callback; },
      querySelector: () => null,
      querySelectorAll: (selector) => selector === 'article' ? [reply, mainPost] : []
    },
    chrome: { runtime: { onMessage: { addListener(callback) { receive = callback; } } } }
  });
  const snapshot = () => new Promise((resolve, reject) => receive({ type: 'ANNOTATED_DISCOVER' }, {}, (response) => response.ok ? resolve(response.result) : reject(new Error(response.error))));
  const initial = await snapshot();
  assert.equal(initial.title, 'The original post text.');
  assert.equal(initial.author, 'Jane Doe');
  assert.equal(sourceIdentity(initial).handle, '@jane');
  select(mainPost, 'A highlighted phrase.');
  select(null, '');
  assert.equal((await snapshot()).excerpt, 'A highlighted phrase.');
  select(reply, 'A reply phrase.');
  await assert.rejects(snapshot(), /different X post/);
  select(mainPost, 'A highlighted phrase.');
  mainPost.setText('A'.repeat(330));
  const bounded = await snapshot();
  assert.equal(bounded.title.length, 300);
  assert.ok(bounded.title.endsWith('…'));
});

test('an X title remains complete for expansion, while captured post text signals truncation', () => {
  const title = 'A'.repeat(250);
  assert.equal(displaySourceTitle({ url: 'https://x.com/jane/status/1234567890', title }), title);
});

test('YouTube discovery follows the current video title even when social metadata stays stale', async () => {
  const script = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8');
  let receive;
  const location = { href: 'https://www.youtube.com/watch?v=old-video', hostname: 'www.youtube.com' };
  const document = {
    title: 'Previous video - YouTube', addEventListener() {},
    querySelector: selector => selector === 'meta[property="og:title"]' ? { content: 'Previous video' } : null,
    querySelectorAll: () => []
  };
  runInNewContext(script, { location, document, URL, getSelection: () => null,
    chrome: { runtime: { onMessage: { addListener(callback) { receive = callback; } } } }
  });
  const snapshot = () => new Promise(resolve => receive({ type: 'ANNOTATED_DISCOVER' }, {}, response => resolve(response.result)));
  location.href = 'https://www.youtube.com/watch?v=8MPbR6Cbwi4';
  document.title = 'Justin Timberlake - Say Something (Official Video) ft. Chris Stapleton - YouTube';
  const page = await snapshot();
  assert.equal(page.url, location.href);
  assert.equal(displaySourceTitle(page), 'Justin Timberlake - Say Something (Official Video) ft. Chris Stapleton');
});

test('YouTube channel comes from the matching watch page, not stale metadata or recommendations', async () => {
  const script = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8');
  let receive;
  let videoId = 'video-first';
  let heading = 'First video';
  let channel = 'First channel';
  const location = { href: 'https://www.youtube.com/watch?v=video-first', hostname: 'www.youtube.com' };
  const watch = { querySelector: selector => selector === '#title h1' ? { textContent: heading } : selector === '#owner #channel-name a' ? { textContent: channel } : null };
  const document = {
    title: '(2) First video - YouTube', addEventListener() {}, querySelectorAll: () => [],
    querySelector(selector) {
      if (selector === `ytd-watch-flexy[video-id="${videoId}"]`) return watch;
      if (selector === 'meta[name="author"]') return { content: 'Stale metadata author' };
      return null;
    }
  };
  runInNewContext(script, { location, document, URL, getSelection: () => null,
    chrome: { runtime: { onMessage: { addListener(callback) { receive = callback; } } } }
  });
  const snapshot = () => new Promise((resolve, reject) => receive({ type: 'ANNOTATED_DISCOVER' }, {}, response => response.ok ? resolve(response.result) : reject(new Error(response.error))));
  assert.equal((await snapshot()).author, 'First channel');
  location.href = 'https://www.youtube.com/watch?v=video-next';
  assert.equal((await snapshot()).author, '', 'URL changed before the old player');
  videoId = 'video-next';
  document.title = 'Next video - YouTube';
  assert.equal((await snapshot()).author, '', 'The old title/owner has not caught up');
  heading = 'Next video';
  channel = 'Next channel';
  assert.equal((await snapshot()).author, 'Next channel');
  channel = '';
  assert.equal((await snapshot()).author, '', 'Missing owner is omitted, not inferred from stale metadata');
  location.hostname = 'example.org'; location.href = 'https://example.org/article';
  assert.equal((await snapshot()).author, 'Stale metadata author', 'Ordinary article attribution stays unchanged');
});
