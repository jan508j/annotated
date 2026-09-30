import { emptyArticle, hasArticle, publicArticleUrl, sharedArticle, readArticleDraft, saveArticleDraft, clearArticleDraft } from '/shared/article-draft.mjs';

export function articleEditor({ el, api, session, navigate, signInHref, refreshSession }) {
  let storage;
  try { storage = sessionStorage; } catch { storage = null; }
  const existing = readArticleDraft(storage, session.user?.id);
  let clientId = existing?.clientId || crypto.randomUUID();
  let disposed = false;
  let revision = 0;
  let previewAbort;
  let previewTimer;
  let shared = null;
  let sharedError = '';
  // A fragment stays out of HTTP requests/referrers and is removed immediately.
  if (location.hash) {
    try { shared = sharedArticle(new URLSearchParams(location.hash.slice(1))); }
    catch (error) { sharedError = error.message; }
    history.replaceState({}, '', '/write');
  }
  const initial = existing?.values || shared || emptyArticle();
  let sourcePublisher = '';
  let publisherSource = '';
  const sourceStatus = el('p', { class: 'editor-hint', role: 'status' });
  const status = el('p', { class: 'form-status', role: 'status' });
  const saved = el('p', { class: 'editor-hint editor-saved', role: 'status' });
  const count = el('span', { class: 'editor-count', id: 'quote-count' });
  const input = (tag, name, attrs) => {
    const element = el(tag, { name, id: `article-${name}`, ...attrs });
    element.value = initial[name];
    return element;
  };
  const url = input('input', 'url', { type: 'url', required: true, maxlength: '2000', placeholder: 'https://…', inputmode: 'url', autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'source-help' });
  const title = input('input', 'title', { required: true, maxlength: '300', placeholder: 'Page title', autocomplete: 'off' });
  const excerpt = input('textarea', 'excerpt', { rows: '4', required: true, maxlength: '2000', placeholder: 'Paste the exact passage you’re responding to.', 'aria-describedby': 'quote-count' });
  const commentary = input('textarea', 'commentary', { rows: '4', required: true, maxlength: '2000', placeholder: 'What should people notice?' });
  const fields = { url, title, excerpt, commentary };
  let titleSource = url.value;
  const values = () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.value]));
  const publish = el('button', { class: 'button primary', type: 'submit' }, session.user ? 'Publish annotation' : 'Sign in to publish');
  const persist = () => {
    const ok = saveArticleDraft(storage, values(), session.user?.id, clientId);
    saved.textContent = ok ? (hasArticle(values()) ? 'Draft saved in this tab' : '') : 'Draft could not be saved. Keep a copy before leaving this page.';
    return ok;
  };
  function updateCount() {
    const words = (excerpt.value.match(/\S+/g) || []).length;
    count.textContent = `${words} / 100 words`;
    excerpt.setCustomValidity(words > 100 ? 'Keep the quoted passage within 100 words.' : excerpt.value.length > 2000 ? 'Keep the quoted passage within 2,000 characters.' : '');
  }
  async function previewSource() {
    const current = ++revision;
    previewAbort?.abort();
    let source;
    try { source = publicArticleUrl(url.value); url.setCustomValidity(''); }
    catch { sourceStatus.textContent = url.value ? 'Use the original public page link; you can enter the title yourself.' : ''; return; }
    const titleBefore = title.value;
    previewAbort = new AbortController();
    sourceStatus.textContent = 'Finding the page title…';
    try {
      const result = await api('/api/source-preview', { method: 'POST', body: { url: source }, signal: previewAbort.signal });
      if (disposed || current !== revision || publicArticleUrl(url.value) !== source) return;
      sourcePublisher = typeof result.publisher === 'string' ? result.publisher : '';
      publisherSource = source;
      if (result.title && title.value === titleBefore && !title.value.trim()) {
        title.value = result.title;
        clientId = crypto.randomUUID();
        persist();
      }
      sourceStatus.textContent = result.title ? 'Check the source title before publishing.' : 'Enter the page title below.';
    } catch (error) {
      if (disposed || current !== revision || error.name === 'AbortError') return;
      sourceStatus.textContent = 'Couldn’t read this page’s title. You can enter it below.';
    }
  }
  function sourceChanged() {
    clearTimeout(previewTimer);
    void previewSource();
  }
  const paste = el('button', { class: 'text-button editor-paste', type: 'button' }, 'Paste link');
  paste.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (disposed) return;
      const imported = sharedArticle(new URLSearchParams({ text }));
      if (!imported.url) throw new Error('No single source link found.');
      url.value = imported.url;
      titleSource = url.value;
      title.value = '';
      clientId = crypto.randomUUID();
      persist();
      await previewSource();
    } catch {
      sourceStatus.textContent = 'Tap the source field and use Paste to add the original page link.';
      url.focus();
    }
  });
  const source = el('section', { class: 'editor-source', 'aria-labelledby': 'editor-source-label' },
    el('div', { class: 'editor-field-heading' }, el('label', { for: url.id, id: 'editor-source-label' }, 'Source link'), paste), url,
    el('p', { class: 'editor-hint', id: 'source-help' }, 'The original page stays attached.'), sourceStatus,
    el('label', { for: title.id }, 'Source title'), title);
  const form = el('form', { class: 'article-form' }, source,
    el('section', { class: 'editor-quote' }, el('div', { class: 'editor-field-heading' }, el('label', { for: excerpt.id }, 'Quoted passage'), count), excerpt),
    el('section', { class: 'editor-take' }, el('label', { class: 'eyebrow', for: commentary.id }, 'Your take'), commentary),
    status,
    el('div', { class: 'editor-publish' }, el('div', {}, publish, !session.user ? el('p', { class: 'editor-hint' }, 'Your draft stays here while you sign in.') : null), saved));
  const discard = el('button', { class: 'text-button', type: 'button' }, 'Discard draft');
  const discardConfirm = el('div', { class: 'editor-confirm', hidden: true }, el('p', {}, 'Discard this unpublished draft?'),
    el('button', { class: 'button secondary', type: 'button', onclick: () => { clearArticleDraft(storage); navigate('/feed'); } }, 'Discard'),
    el('button', { class: 'button subtle', type: 'button', onclick: () => { discardConfirm.hidden = true; discard.focus(); } }, 'Keep writing'));
  discard.addEventListener('click', () => { discardConfirm.hidden = false; discardConfirm.querySelector('button').focus(); });
  const incoming = el('div', { class: 'editor-incoming', hidden: true });
  const root = el('section', { class: 'page editor-page' },
    el('div', { class: 'editor-topline' }, el('a', { href: '/feed' }, '← Back to feed'), el('a', { href: '/phone' }, 'Use on your phone ↗')),
    el('header', { class: 'editor-heading' }, el('p', { class: 'eyebrow' }, 'ARTICLE ANNOTATION'), el('h1', {}, 'Mark the part.', el('br'), el('span', {}, 'Make your point.'))),
    incoming, form, el('div', { class: 'editor-bottom' }, discard), discardConfirm);
  if (existing && shared && hasArticle(shared)) {
    incoming.hidden = false;
    incoming.append(el('p', {}, 'You have an unfinished draft. Replace it with the shared source?'),
      el('button', { class: 'button secondary', type: 'button', onclick: () => {
        for (const [name, field] of Object.entries(fields)) field.value = shared[name];
        titleSource = url.value;
        clientId = crypto.randomUUID(); incoming.hidden = true; updateCount(); persist(); if (url.value) void previewSource();
      } }, 'Replace draft'),
      el('button', { class: 'button subtle', type: 'button', onclick: () => { incoming.hidden = true; } }, 'Keep draft'));
  }
  for (const [name, field] of Object.entries(fields)) field.addEventListener('input', () => {
    if (name === 'url') {
      if (titleSource && url.value !== titleSource) title.value = '';
      titleSource = url.value;
      revision++; previewAbort?.abort(); clearTimeout(previewTimer);
      sourceStatus.textContent = ''; url.setCustomValidity('');
      previewTimer = setTimeout(sourceChanged, 600);
    }
    clientId = crypto.randomUUID(); status.textContent = ''; updateCount(); persist();
  });
  url.addEventListener('change', sourceChanged);
  form.addEventListener('submit', async event => {
    event.preventDefault(); status.textContent = '';
    let source;
    try { source = publicArticleUrl(url.value); }
    catch (error) { url.setCustomValidity(error.message); url.reportValidity(); return; }
    updateCount();
    if (!form.reportValidity()) return;
    if (!session.user) {
      if (!persist()) { status.textContent = 'Copy your text before signing in; this browser could not save your draft.'; return; }
      navigate(signInHref('/write'));
      return;
    }
    revision++;
    clearTimeout(previewTimer);
    previewAbort?.abort();
    sourceStatus.textContent = '';
    const submittedId = clientId;
    publish.disabled = true; paste.disabled = true; discard.disabled = true;
    Object.values(fields).forEach(field => { field.disabled = true; });
    publish.textContent = 'Publishing…'; persist();
    try {
      const result = await api('/api/annotations', { method: 'POST', body: {
        clientId: submittedId, source: { url: source, title: title.value, kind: 'article', author: '', publisher: publisherSource === source ? sourcePublisher : '' }, excerpt: excerpt.value,
        commentary: commentary.value, start: null, end: null, mediaId: null, voiceMediaId: null, isDemo: session.mode === 'local'
      } });
      if (readArticleDraft(storage, session.user?.id)?.clientId === submittedId) clearArticleDraft(storage);
      if (!disposed) navigate(`/a/${encodeURIComponent(result.annotation.id)}`);
    } catch (error) {
      if (disposed) return;
      if (error.status === 401) {
        persist();
        await refreshSession();
        if (!disposed) navigate(signInHref('/write'));
      }
      else status.textContent = error.message;
    } finally {
      if (!disposed) {
        publish.disabled = false; paste.disabled = false; discard.disabled = false;
        Object.values(fields).forEach(field => { field.disabled = false; });
        publish.textContent = 'Publish annotation';
      }
    }
  });
  updateCount();
  if (sharedError) status.textContent = sharedError;
  if (existing || shared) persist();
  if (url.value) void previewSource();
  return { root, dispose: () => { disposed = true; clearTimeout(previewTimer); previewAbort?.abort(); } };
}
