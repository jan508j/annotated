const AUDIENCES = ['everyone', 'following'];
const FORMATS = ['all', 'text', 'video', 'audio'];
const label = value => value[0].toUpperCase() + value.slice(1);

export function readFeedFilters(search) {
  const params = new URLSearchParams(search);
  const audience = params.has('audience') ? params.get('audience') : params.get('following') === '1' ? 'following' : 'everyone';
  const format = params.has('format') ? params.get('format') : params.get('type') || 'all';
  return { audience: AUDIENCES.includes(audience) ? audience : 'everyone', format: FORMATS.includes(format) ? format : 'all' };
}

export function feedPath({ audience, format }) {
  const params = new URLSearchParams();
  if (audience === 'following') params.set('audience', audience);
  if (FORMATS.includes(format) && format !== 'all') params.set('format', format);
  return `/feed${params.size ? `?${params}` : ''}`;
}

export function radioStep(values, value, key) {
  const index = values.indexOf(value);
  if (key === 'Home') return values[0];
  if (key === 'End') return values.at(-1);
  if (['ArrowRight', 'ArrowDown'].includes(key)) return values[(index + 1) % values.length];
  if (['ArrowLeft', 'ArrowUp'].includes(key)) return values[(index - 1 + values.length) % values.length];
  return null;
}

export function feedStatus({ audience, format }) {
  return `Showing ${format} annotations${audience === 'following' ? ' from people you follow' : ''}`;
}

export function filteredEmpty({ audience, format }) {
  if (format !== 'all') return { text: `No ${format} annotations${audience === 'following' ? ' from people you follow' : ' yet'}.`, action: 'Show all formats', group: 'format', value: 'all' };
  if (audience === 'following') return { text: 'No one you follow has marked anything yet.', action: 'Show everyone', group: 'audience', value: 'everyone' };
  return null;
}

// Keep the controls mounted during requests so rapid selection and keyboard focus
// remain stable. Only the latest request may replace the results.
export function feedPage({ el, api, session, annotationCard, signInHref, localNotice }) {
  let state = readFeedFilters(location.search);
  let disposed = false;
  let request;
  let loadingTimer;
  let frame;
  let gate;
  let navHeight = 0;
  let nextCursor = null;
  let loading = false;
  const shown = new Set();
  const buttons = {};
  const status = el('span', { class: 'feed-sr-status' });
  const list = el('div', { class: 'feed-grid' });
  const moreError = el('p', { class: 'feed-more-error', hidden: true });
  const more = el('button', { class: 'button feed-load-more', type: 'button', onclick: () => void load(true) }, 'Load more');
  const pagination = el('div', { class: 'feed-pagination', hidden: true }, moreError, more);
  const results = el('section', { id: 'conversations', class: 'feed-results', 'aria-label': 'Annotations', 'aria-live': 'polite', 'aria-busy': 'true' }, status, list, pagination);
  const audienceWrap = el('div', { class: 'feed-audience-wrap' });
  const filters = el('div', { class: 'feed-filter-bar' }, audienceWrap,
    el('span', { class: 'feed-filter-divider', 'aria-hidden': 'true' }),
    group('format', 'Source format', FORMATS),
    el('span', { class: 'feed-sort-label' }, 'Newest first'));
  audienceWrap.append(group('audience', 'Audience', AUDIENCES));
  const sentinel = el('div', { class: 'feed-filter-sentinel', 'aria-hidden': 'true' });
  const root = el('div', { class: 'page feed-page' },
    el('header', { class: 'feed-heading' }, el('h1', {}, 'Feed'),
      el('a', { class: 'button primary feed-write', href: '/write' }, 'Write annotation'), localNotice),
    sentinel, filters, results);

  function group(name, accessibleName, values) {
    const control = el('div', { class: `feed-radio-group feed-${name}`, role: 'radiogroup', 'aria-label': accessibleName });
    buttons[name] = {};
    for (const value of values) {
      const button = el('button', { type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1',
        onclick: () => select(name, value), onkeydown: event => {
          const next = radioStep(values, value, event.key);
          if (!next) return;
          event.preventDefault();
          select(name, next, true);
        } }, label(value));
      buttons[name][value] = button;
      control.append(button);
    }
    return control;
  }

  function updateControls() {
    for (const [name, groupButtons] of Object.entries(buttons)) {
      for (const [value, button] of Object.entries(groupButtons)) {
        button.setAttribute('aria-checked', String(state[name] === value));
        button.tabIndex = state[name] === value ? 0 : -1;
      }
    }
  }

  function closeGate(restoreFocus = true) {
    if (!gate) return;
    gate.remove(); gate = null;
    buttons.audience.following.removeAttribute('aria-expanded');
    buttons.audience.following.removeAttribute('aria-controls');
    if (restoreFocus) buttons.audience.following.focus({ preventScroll: true });
  }

  function openGate() {
    if (gate) { gate.querySelector('a').focus({ preventScroll: true }); return; }
    gate = el('div', { class: 'feed-signin-prompt', id: 'following-signin', role: 'dialog', 'aria-labelledby': 'following-signin-title' },
      el('p', { id: 'following-signin-title' }, 'Sign in to see takes from people you follow.'),
      el('div', { class: 'feed-signin-actions' },
        el('a', { class: 'button primary', href: signInHref(feedPath({ ...state, audience: 'following' })) }, 'Sign in'),
        el('button', { class: 'text-button', type: 'button', onclick: () => closeGate() }, 'Not now')));
    audienceWrap.append(gate);
    buttons.audience.following.setAttribute('aria-expanded', 'true');
    buttons.audience.following.setAttribute('aria-controls', gate.id);
    gate.querySelector('a').focus({ preventScroll: true });
  }

  function select(name, value, focus = false) {
    if (name === 'audience' && value === 'following' && !session.user) { openGate(); return; }
    if (state[name] === value) return;
    closeGate(false);
    state = { ...state, [name]: value };
    history.pushState({}, '', feedPath(state));
    updateControls();
    if (focus) buttons[name][value].focus({ preventScroll: true });
    if (sentinel.getBoundingClientRect().top < navHeight) {
      window.scrollTo({ top: Math.max(0, window.scrollY + sentinel.getBoundingClientRect().top - navHeight), behavior: 'instant' });
    }
    void load();
  }

  function skeletons() {
    return [0, 1].map(() => el('div', { class: 'feed-skeleton', 'aria-hidden': 'true' },
      el('div', { class: 'feed-skeleton-author' }, el('span', { class: 'feed-skeleton-avatar' }), el('span', { class: 'feed-skeleton-name' })),
      ...['take', 'take short', 'meta', 'excerpt', 'excerpt short'].map(className => el('span', { class: `feed-skeleton-${className}` }))));
  }

  async function load(append = false) {
    if (append && (loading || !nextCursor)) return;
    request?.abort();
    clearTimeout(loadingTimer);
    const current = request = new AbortController();
    const moveFocus = append && document.activeElement === more;
    loading = true;
    more.disabled = true;
    more.textContent = append ? 'Loading…' : 'Load more';
    moreError.hidden = true;
    results.setAttribute('aria-busy', 'true');
    status.textContent = append ? 'Loading more annotations…' : 'Loading annotations…';
    if (!append) {
      nextCursor = null;
      shown.clear();
      pagination.hidden = true;
      list.inert = true;
      loadingTimer = setTimeout(() => {
        if (!disposed && request === current) list.replaceChildren(...skeletons());
      }, 150);
    }
    try {
      const url = new URL(feedPath(state).replace('/feed', '/api/feed'), location.origin);
      url.searchParams.set('limit', '15');
      if (append) url.searchParams.set('cursor', nextCursor);
      const { annotations = [], nextCursor: after = null } = await api(url.pathname + url.search, { signal: current.signal });
      if (disposed || request !== current) return;
      const added = annotations.filter(annotation => !shown.has(annotation.id));
      const cards = added.map(annotation => annotationCard(annotation, { following: annotation.isFollowing }));
      if (append) list.append(...cards);
      else if (cards.length) list.replaceChildren(...cards);
      else {
        const empty = filteredEmpty(state);
        list.replaceChildren(empty ? el('div', { class: 'feed-filter-empty' }, el('p', {}, empty.text),
          el('button', { class: 'button', type: 'button', onclick: () => select(empty.group, empty.value, true) }, empty.action))
          : el('div', { class: 'empty-state' }, el('p', {}, 'Nothing marked yet.'), el('a', { class: 'button primary', href: '/install' }, 'Add to Chrome')));
      }
      added.forEach(annotation => shown.add(annotation.id));
      nextCursor = after;
      pagination.hidden = !nextCursor;
      more.textContent = 'Load more';
      status.textContent = `${feedStatus(state)}. ${shown.size} loaded.${append ? ` ${added.length} more added.` : ''}${nextCursor ? '' : ' All available annotations loaded.'}`;
      if (moveFocus) (cards[0] || (!nextCursor ? list.lastElementChild : more))?.focus({ preventScroll: true });
    } catch (error) {
      if (disposed || current.signal.aborted || request !== current) return;
      if (append) {
        moreError.textContent = 'Couldn’t load more annotations. Your place is saved.';
        moreError.hidden = false;
        more.textContent = 'Try again';
        status.textContent = 'Couldn’t load more annotations. Try again.';
      } else {
        list.replaceChildren(el('div', { class: 'feed-filter-empty feed-load-error' }, el('p', {}, 'The feed couldn’t load.'),
          el('span', { class: 'muted' }, error.message), el('button', { class: 'button', type: 'button', onclick: () => void load() }, 'Try again')));
        status.textContent = 'The feed couldn’t load. Try again.';
      }
    } finally {
      if (!disposed && request === current) {
        clearTimeout(loadingTimer);
        loading = false;
        more.disabled = false;
        results.setAttribute('aria-busy', 'false');
        list.inert = false;
      }
    }
  }

  function restore() {
    closeGate(false);
    state = readFeedFilters(location.search);
    const needsSignIn = state.audience === 'following' && !session.user;
    if (needsSignIn) state.audience = 'everyone';
    const canonical = feedPath(state);
    if (location.pathname + location.search !== canonical) history.replaceState({}, '', canonical + location.hash);
    updateControls();
    if (needsSignIn) openGate();
    void load();
  }

  const nav = document.querySelector('.site-header');
  function stickyState() {
    navHeight = nav?.getBoundingClientRect().height || 0;
    root.style.setProperty('--feed-nav-height', `${navHeight}px`);
    filters.classList.toggle('is-stuck', sentinel.getBoundingClientRect().top <= navHeight);
  }
  const resize = new ResizeObserver(stickyState);
  if (nav) resize.observe(nav);
  function onScroll() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(stickyState);
  }
  function onOutside(event) { if (gate && !audienceWrap.contains(event.target)) closeGate(); }
  function onEscape(event) { if (gate && event.key === 'Escape') { event.preventDefault(); closeGate(); } }
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('pointerdown', onOutside);
  document.addEventListener('keydown', onEscape);
  return { root, start: restore, restore, dispose() {
    disposed = true; request?.abort(); clearTimeout(loadingTimer); cancelAnimationFrame(frame); resize.disconnect();
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('pointerdown', onOutside);
    document.removeEventListener('keydown', onEscape);
  } };
}
