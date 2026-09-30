import { markerHome } from '/web/marker-home.js';
import { markElement } from '/shared/marker.mjs';
import { displaySourceTitle, sourceExcerpts, sourceIdentity, xShareIntent } from '/shared/source-identity.mjs';
import { openShareSheet } from '/shared/share-sheet.mjs';
import { articleEditor } from '/web/article-editor.js';
import { clearArticleDraft } from '/shared/article-draft.mjs';
import { mobileSetup } from '/web/mobile-setup.js';
import { sourceHref } from '/web/source-link.js';
import { commentaryParts, supportingLinkLabel } from '/web/commentary-links.js';
import { feedPage } from '/web/feed-filters.js';
import { profilePage } from '/web/profile-page.js';

const main = document.querySelector('#main');
const sessionControl = document.querySelector('#session-control');
const toast = document.querySelector('#toast');

let session = { user: null, mode: 'unknown', oauthConfigured: false, extensionAvailable: false };
let toastTimer;
let disposeHome = null;
let disposeEditor = null;
let activeFeed = null;
let activeProfile = null;
let routeVersion = 0;
let renderedRouteKey = '';

function isLocal() { return session.mode === 'local'; }
function signInHref(returnTo = location.pathname === '/signin' ? new URLSearchParams(location.search).get('returnTo') || '/' : location.pathname + location.search) {
  return isLocal() ? `/install?returnTo=${encodeURIComponent(returnTo)}`
    : `/signin?returnTo=${encodeURIComponent(returnTo)}`;
}

function signInControl(returnTo, label = 'Sign in') {
  return session.oauthConfigured || session.authProviders?.x
    ? el('a', { class: `button ${label === 'Sign in' ? 'secondary' : 'primary'}`, href: signInHref(returnTo) }, label)
    : el('p', { class: 'muted' }, 'Sign-in is temporarily unavailable. Please try again later.');
}

function signInOptions(returnTo = '/') {
  const providers = session.authProviders || { google: session.oauthConfigured, x: false };
  return el('div', { class: 'sign-in-options' },
    ...['google', 'x'].map((provider) => {
      const label = `Continue with ${provider === 'google' ? 'Google' : 'X'}`;
      return providers[provider]
        ? el('a', { class: 'button secondary', href: `/auth/${provider}/start?returnTo=${encodeURIComponent(returnTo)}` }, label)
        : el('button', { class: 'button secondary', type: 'button', disabled: true }, label);
    }),
    !providers.x ? el('small', { class: 'muted' }, 'X sign-in is not available yet.') : null
  );
}

function renderSignIn() {
  setDocumentTitle('Sign in');
  const requested = new URLSearchParams(location.search).get('returnTo') || '/';
  const returnTo = requested.startsWith('/') && !requested.startsWith('//') && !/[\\\u0000-\u001f]/.test(requested) ? requested : '/';
  main.replaceChildren(el('section', { class: 'page narrow sign-in-page' },
    el('p', { class: 'eyebrow' }, 'ANNOTATED ACCOUNT'),
    el('h1', {}, session.user ? 'You’re signed in' : 'Keep your marks.'),
    session.user ? el('a', { class: 'button primary', href: returnTo }, 'Continue') : signInOptions(returnTo),
    el('p', { class: 'muted' }, 'Use the same sign-in option each time to return to your annotations.'),
    el('p', { class: 'muted' }, el('a', { href: '/feed' }, 'Browse without an account ↗'))
  ));
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function commentaryNodes(value) {
  return commentaryParts(value).map(({ text, href }) => href
    ? el('a', { class: 'supporting-link', href, title: href, target: '_blank', rel: 'noopener nofollow ugc' }, supportingLinkLabel(text), el('span', { class: 'link-new-tab' }, ' (opens in a new tab)'))
    : document.createTextNode(text));
}

function initials(name = '?') {
  const visibleName = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return visibleName.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function avatar(user, className = 'avatar') {
  const node = markElement(el('span', { class: className, 'aria-hidden': 'true' }, initials(user?.name)), user?.id || user?.name);
  if (user?.avatarUrl?.startsWith('/api/users/')) {
    // Initials stay visible until the photo loads, including on a failed request.
    const photo = el('img', { src: user.avatarUrl, alt: '', decoding: 'async', onload: () => { node.replaceChildren(photo); } });
  }
  return node;
}

function humanDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }).format(date);
}

function formatTime(seconds = 0) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return value >= 3600
    ? `${Math.floor(value / 3600)}:${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
    : `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && typeof options.body !== 'string' && !(options.body instanceof Blob)) {
    headers.set('content-type', 'application/json');
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showToast(message, { profile = false } = {}) {
  clearTimeout(toastTimer);
  toast.classList.toggle('profile-toast', profile);
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), profile ? 3000 : 2600);
}

function setDocumentTitle(title) {
  document.title = title ? `${title} — Annotated` : 'Annotated — Open the source. Join the conversation.';
}

function demoBadge() {
  return el('span', { class: 'demo-badge', title: 'Created with a local test identity' }, 'Local demo');
}

function sourceLabel(source) {
  const identity = sourceIdentity(source);
  return el('span', { class: 'source-identity' },
    el('span', { class: `source-badge source-badge-${identity.platform}`, 'aria-hidden': 'true' }, identity.platform === 'youtube' ? null : identity.badge),
    el('span', {}, identity.publisher),
    identity.author && identity.platform === 'x' ? el('span', { class: 'source-person' }, identity.author) : null,
    identity.handle && !identity.author.includes(identity.handle) ? el('span', { class: 'source-handle' }, identity.handle) : null
  );
}

function excerptQuotes(annotation, className = '') {
  return sourceExcerpts(annotation).map(quote => el('blockquote', { class: className }, el('mark', {}, quote)));
}

function relativeDate(value) {
  const seconds = Math.max(0, (Date.now() - new Date(value).valueOf()) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return humanDate(value);
}

function authorLine(user, date) {
  const href = user?.id ? `/u/${encodeURIComponent(user.id)}` : '#';
  return el('div', { class: 'byline-row' },
    avatar(user),
    el('span', {}, el('a', { href }, user?.name || 'Unknown author'), date ? el('span', { class: 'muted' }, ` · ${humanDate(date)}`) : null)
  );
}

function annotationCard(annotation, options = {}) {
  const href = `/a/${encodeURIComponent(annotation.id)}`;
  const card = el('article', { class: 'annotation-card', tabindex: '0', role: 'link', 'aria-label': `Open annotation: ${annotation.source?.title || 'Untitled source'}` });
  markElement(card, annotation.id);
  const openCard = (event) => {
    if (event.target.closest('a,button,select,input,textarea,video,audio')) return;
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    navigate(href);
  };
  card.addEventListener('click', openCard);
  card.addEventListener('keydown', openCard);

  const author = annotation.author || {};
  const follow = el('button', { class: 'follow-button', type: 'button' }, 'Follow');
  let following = false;
  card.updateFollowState = (next, busy = false) => {
    following = Boolean(next);
    follow.textContent = following ? 'Following' : 'Follow';
    follow.classList.toggle('is-following', following);
    follow.disabled = busy;
  };
  if (!author.id || session.user?.id === author.id) follow.hidden = true;
  else {
    if (typeof options.following === 'boolean') card.updateFollowState(options.following);
    else {
      follow.disabled = true;
      api(`/api/users/${encodeURIComponent(author.id)}`).then(data => card.updateFollowState(data.isFollowing))
        .catch(() => { follow.hidden = true; }).finally(() => { follow.disabled = false; });
    }
    follow.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (options.onFollow) { options.onFollow(); return; }
      if (!session.user) { location.assign(signInHref()); return; }
      follow.disabled = true;
      try {
        const result = await api(`/api/users/${encodeURIComponent(author.id)}/follow`, { method: 'POST', body: { following: !following } });
        following = Boolean(result.following);
        follow.textContent = following ? 'Following' : 'Follow';
        follow.classList.toggle('is-following', following);
        await renderRoute();
      } catch (error) { showToast(error.message); }
      finally { follow.disabled = false; }
    });
  }
  const timing = annotation.start != null ? `${formatTime(annotation.start)}${annotation.end != null ? `–${formatTime(annotation.end)}` : ''}` : null;
  const source = annotation.source || {};
  const identity = sourceIdentity(source);
  const sourceMedia = source.kind === 'video' || source.kind === 'audio';
  card.append(
    el('div', { class: 'card-topline' },
      el('div', { class: 'feed-author' }, avatar(author),
        el('a', { href: `/u/${encodeURIComponent(author.id)}`, class: 'feed-author-name' }, author.name || 'Unknown author'),
        el('time', { datetime: annotation.createdAt, title: humanDate(annotation.createdAt) }, relativeDate(annotation.createdAt))),
      follow
    ),
    el('div', { class: 'take feed-take' },
      el('p', {}, ...commentaryNodes(annotation.commentary || 'A take in their own voice.')),
      annotation.voiceUrl ? el('audio', { src: annotation.voiceUrl, class: 'receipt-audio', controls: true, preload: 'metadata', 'aria-label': 'Voice take' }) : null
    ),
    el('section', { class: 'feed-source-block', 'aria-label': 'Source' },
      sourceMedia ? el('p', { class: 'feed-source-title', title: displaySourceTitle(source) }, displaySourceTitle(source)) : null,
      el('div', { class: 'card-source-meta' },
        sourceMedia && identity.author && identity.author.toLowerCase() !== identity.publisher.toLowerCase() ? el('span', { class: 'feed-source-channel' }, identity.author) : null,
        el('span', {}, identity.publisher),
        el('span', {}, identity.platform === 'x' ? 'Post' : source.kind || 'source'),
        timing ? el('span', {}, timing) : null,
        annotation.isDemo ? demoBadge() : null
      ),
      mediaFor(annotation),
      excerptQuotes(annotation)
    ),
    el('div', { class: 'annotation-meta' },
      el('a', { href }, annotation.commentCount ? `${annotation.commentCount} ${annotation.commentCount === 1 ? 'reply' : 'replies'}` : 'Start the conversation'),
      el('button', { class: 'action-link', type: 'button', onclick: () => openShareSheet({ annotation }) }, 'Share as image'),
      el('a', { class: 'source-action', href: sourceHref(source, annotation.start, sourceExcerpts(annotation)), target: '_blank', rel: 'noopener noreferrer', title: displaySourceTitle(source) }, 'Open source ↗')
    )
  );
  return card;
}

function pageError(error, retry) {
  const box = el('section', { class: 'error-box', role: 'alert' },
    el('h2', {}, error.status === 404 ? 'Nothing here yet.' : 'This page couldn’t load.'),
    el('p', { class: 'muted' }, error.message || 'The service did not respond.'),
    error.status === 404 ? el('a', { class: 'button primary', href: '/feed' }, 'Back to the feed')
      : el('button', { class: 'button primary', type: 'button', onclick: retry }, 'Try again')
  );
  main.replaceChildren(box);
}

function navAvatar() {
  const href = `/u/${encodeURIComponent(session.user.id)}`;
  return el('a', { class: 'nav-profile-link', href, 'aria-label': 'Your profile', 'aria-current': location.pathname === href ? 'page' : null }, avatar(session.user));
}

function renderSession() {
  sessionControl.replaceChildren();
  const localNote = document.querySelector('.local-note');
  if (localNote) localNote.textContent = isLocal() ? 'Local development build · demo identities and content are clearly marked' : 'Preview · source excerpts and human commentary stay distinct';
  if (!isLocal()) {
    if (session.user) {
      const logout = el('button', { class: 'text-button', type: 'button' }, 'Sign out');
      logout.addEventListener('click', async () => {
        logout.disabled = true;
        try {
          await api('/api/logout', { method: 'POST' });
          try { clearArticleDraft(sessionStorage); } catch { /* Storage may be unavailable. */ }
          await refreshSession();
          await renderRoute();
        } catch (error) { showToast(error.message); logout.disabled = false; }
      });
      sessionControl.append(el('a', { class: 'header-my-link', href: `/u/${encodeURIComponent(session.user.id)}` }, 'My annotations'), navAvatar(), el('details', { class: 'web-account-menu' }, el('summary', { class: 'account-menu-label', 'aria-label': 'Account menu' }, 'Account'), el('div', { class: 'web-account-content' }, el('strong', {}, session.user.name), el('a', { href: `/u/${encodeURIComponent(session.user.id)}` }, 'My annotations'), logout)));
    } else sessionControl.append(signInControl(undefined, 'Sign in'));
    return;
  }
  if (session.user) {
    const identity = el('div', { class: 'identity' }, el('div', {}, session.user.name, el('small', {}, 'Local test account')));
    const select = el('select', { 'aria-label': 'Switch local test account' },
      el('option', { value: '' }, 'Account'),
      el('option', { value: 'mira' }, 'Switch to Mira'),
      el('option', { value: 'leo' }, 'Switch to Leo'),
      el('option', { value: 'logout' }, 'Sign out')
    );
    select.addEventListener('change', async () => {
      const value = select.value;
      select.disabled = true;
      try {
        if (value === 'logout') {
          await api('/api/logout', { method: 'POST' });
          try { clearArticleDraft(sessionStorage); } catch { /* Storage may be unavailable. */ }
        }
        else if (value) await api('/api/dev/session', { method: 'POST', body: { persona: value } });
        await refreshSession();
        await renderRoute();
      } catch (error) { showToast(error.message); }
      finally { select.disabled = false; select.value = ''; }
    });
    sessionControl.append(el('a', { class: 'header-my-link', href: `/u/${encodeURIComponent(session.user.id)}` }, 'My annotations'), navAvatar(), identity, select);
  } else {
    const select = el('select', { 'aria-label': 'Use a local test account' },
      el('option', { value: '' }, 'Try a test account'),
      el('option', { value: 'mira' }, 'Mira — local operator'),
      el('option', { value: 'leo' }, 'Leo — local member')
    );
    select.addEventListener('change', async () => {
      if (!select.value) return;
      select.disabled = true;
      try {
        await api('/api/dev/session', { method: 'POST', body: { persona: select.value } });
        await refreshSession();
        const returnTo = new URLSearchParams(location.search).get('returnTo');
        if (location.pathname === '/install' && (returnTo === '/write' || /^\/feed(?:\?(?:audience=(?:everyone|following)|format=(?:all|text|video|audio))(?:&(?:audience=(?:everyone|following)|format=(?:all|text|video|audio)))?)?$/.test(returnTo || '') || /^\/[au]\/[A-Za-z0-9_-]+$/.test(returnTo || ''))) {
          history.replaceState({}, '', returnTo);
        }
        await renderRoute();
        showToast(`Using ${session.user.name} locally`);
      } catch (error) { showToast(error.message); }
      finally { select.disabled = false; }
    });
    sessionControl.append(select);
  }
}

async function refreshSession() {
  try { session = await api('/api/session'); }
  catch { session = { user: null, mode: 'unknown', oauthConfigured: false, extensionAvailable: false }; }
  renderSession();
}


function renderFeed() {
  setDocumentTitle('');
  activeFeed = feedPage({ el, api, session, annotationCard, signInHref,
    localNotice: isLocal() ? el('div', { class: 'demo-strip' }, el('span', { class: 'demo-dot', 'aria-hidden': 'true' }), 'Local demo · test identities and sample annotations') : null });
  main.replaceChildren(activeFeed.root);
  activeFeed.start();
}

async function renderSource(id) {
  const { source, annotations } = await api(`/api/sources/${encodeURIComponent(id)}`);
  setDocumentTitle(displaySourceTitle(source));
  const page = el('div', { class: 'page' },
    el('section', { class: 'source-hero' },
      el('div', {}, el('p', { class: 'eyebrow' }, `${source.kind} source conversation`), sourceLabel(source), el('h1', { class: 'source-title' }, displaySourceTitle(source)),
        el('div', { class: 'source-details' }, sourceIdentity(source).platform !== 'x' && source.author ? el('span', {}, `By ${source.author}`) : null, el('span', {}, `${annotations.length} ${annotations.length === 1 ? 'annotation' : 'annotations'}`))),
      el('a', { class: 'button primary', href: sourceHref(source), target: '_blank', rel: 'noopener noreferrer' }, 'Open original ↗')
    ),
    el('section', { class: 'conversation-list', 'aria-label': 'Annotations about this source' },
      annotations.length ? annotations.map(annotationCard) : el('div', { class: 'empty-state' }, el('p', {}, 'Nothing marked yet.'), el('a', { class: 'button primary', href: '/install' }, 'Add to Chrome'))
    )
  );
  main.replaceChildren(page);
}

function mediaFor(annotation) {
  if (annotation.mediaUrl && annotation.source?.kind === 'video') {
    const video = el('video', { class: 'receipt-media', 'aria-label': 'Source video excerpt', src: annotation.mediaUrl, controls: true, preload: 'metadata' });
    video.addEventListener('loadedmetadata', () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        video.style.setProperty('--video-width', `${Math.min(video.videoWidth, 240 * video.videoWidth / video.videoHeight)}px`);
      }
    });
    return video;
  }
  if (annotation.mediaUrl) return el('audio', { class: 'receipt-audio', 'aria-label': 'Source audio excerpt', src: annotation.mediaUrl, controls: true, preload: 'metadata' });
  return null;
}

function commentNode(comment, onDeleted) {
  const meta = el('div', { class: 'comment-meta' }, el('a', { href: comment.author?.id ? `/u/${encodeURIComponent(comment.author.id)}` : '#' }, comment.author?.name || 'Unknown author'), el('span', {}, ` · ${humanDate(comment.createdAt)}`));
  const node = el('article', { class: 'comment' }, avatar(comment.author), el('div', { class: 'comment-body' }, el('p', {}, ...commentaryNodes(comment.text)), meta));
  if (session.user && (session.user.id === comment.author?.id || session.user.isAdmin)) {
    const remove = el('button', { class: 'text-button', type: 'button' }, 'Delete reply');
    remove.addEventListener('click', async () => {
      if (!window.confirm('Delete this reply?')) return;
      remove.disabled = true;
      try {
        await api(`/api/comments/${encodeURIComponent(comment.id)}`, { method: 'DELETE' });
        node.remove();
        onDeleted?.();
        showToast('Reply deleted');
      } catch (error) { showToast(error.message); remove.disabled = false; }
    });
    meta.append(remove);
  }
  return node;
}

async function renderAnnotation(id) {
  const { annotation, comments } = await api(`/api/annotations/${encodeURIComponent(id)}`);
  setDocumentTitle(displaySourceTitle(annotation.source));
  const source = annotation.source || {};
  const commentsTitle = el('h2', { class: 'comments-title' }, `${comments.length} ${comments.length === 1 ? 'reply' : 'replies'}`);
  const commentsList = el('div', { id: 'comment-list' });
  const updateCommentCount = () => {
    const count = commentsList.children.length;
    commentsTitle.textContent = `${count} ${count === 1 ? 'reply' : 'replies'}`;
  };
  commentsList.append(...comments.map((comment) => commentNode(comment, updateCommentCount)));
  let replyComposer;
  if (session.user) {
    const commentStatus = el('p', { class: 'form-status', role: 'status' });
    const form = el('form', { class: 'comment-form' },
      el('textarea', { name: 'text', rows: '1', maxlength: '1000', required: true, 'aria-label': 'Add to the conversation', placeholder: 'Add to the conversation…' }),
      el('button', { class: 'button primary', type: 'submit' }, 'Post'),
      commentStatus
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      commentStatus.textContent = '';
      try {
        const { comment } = await api(`/api/annotations/${encodeURIComponent(id)}/comments`, { method: 'POST', body: { text: new FormData(form).get('text') } });
        commentsList.append(commentNode(comment, updateCommentCount));
        form.reset();
        updateCommentCount();
        showToast('Reply posted');
      } catch (error) { commentStatus.textContent = error.message; }
      finally { button.disabled = false; }
    });
    replyComposer = form;
  } else {
    replyComposer = el('div', { class: 'signed-out-reply' },
      el('p', {}, isLocal() ? 'Sign in with a local test account to add to the conversation.' : 'Sign in to add to the conversation.'),
      isLocal() ? el('a', { class: 'button primary', href: signInHref(`/a/${id}`) }, 'Sign in to add') : signInControl(`/a/${id}`, 'Sign in to add')
    );
  }

  const author = annotation.author || {};
  const authorHref = author.id ? `/u/${encodeURIComponent(author.id)}` : '#';
  const canonicalUrl = new URL(`/a/${encodeURIComponent(id)}`, location.origin).href;
  const timing = annotation.start != null ? `${formatTime(annotation.start)}${annotation.end != null ? `–${formatTime(annotation.end)}` : ''}` : null;
  const sourceMedia = mediaFor(annotation);
  const quotes = excerptQuotes(annotation, 'receipt-quote');
  const take = el('section', { class: 'receipt-take' },
    annotation.commentary ? el('p', { class: 'take-body' }, ...commentaryNodes(annotation.commentary)) : null,
    !annotation.commentary && annotation.voiceUrl ? el('p', { class: 'voice-only-copy' }, `${author.name || 'This reader'} shared this take in their own voice.`) : null,
    annotation.voiceUrl ? el('audio', { class: 'receipt-audio', 'aria-label': 'Voice commentary', src: annotation.voiceUrl, controls: true, preload: 'metadata' }) : null
  );
  const sourceBlock = el('section', { class: 'receipt-source', 'aria-label': 'Source' },
    el('div', { class: 'source-block-heading' },
      el('span', { class: 'source-block-label' }, 'Source'),
      el('span', { class: 'source-range' }, [sourceIdentity(source).platform === 'x' ? 'post' : source.kind || 'source', timing].filter(Boolean).join(' · '))
    ),
    sourceLabel(source),
    el('h2', { class: 'receipt-source-title', title: displaySourceTitle(source) }, displaySourceTitle(source)),
    sourceIdentity(source).platform !== 'x' && sourceIdentity(source).author ? el('p', { class: 'receipt-source-author' }, `By ${sourceIdentity(source).author}`) : null,
    quotes.length ? el('div', { class: 'source-part' }, quotes) : null,
    sourceMedia ? el('div', { class: 'source-part source-media' }, sourceMedia) : null,
    el('div', { class: 'source-actions' },
      el('a', { class: 'action-link primary-action', href: sourceHref(source, annotation.start, sourceExcerpts(annotation)), target: '_blank', rel: 'noopener noreferrer' }, source.key?.startsWith('youtube:') && annotation.start != null ? `Open source at ${formatTime(annotation.start)} ↗` : 'Open source ↗'),
      source.id ? el('a', { class: 'action-link', href: `/s/${encodeURIComponent(source.id)}` }, 'View source discussion') : null
    )
  );
  const copyButton = el('button', { class: 'action-link', type: 'button' }, 'Copy link');
  copyButton.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(canonicalUrl); showToast('Link copied'); }
    catch { showToast('Copy unavailable — use the address bar'); }
  });
  const shareButton = el('button', { class: 'action-link', type: 'button', onclick: () => openShareSheet({ annotation }) }, 'Share as image');
  const xIntent = xShareIntent(annotation, canonicalUrl);
  const claimPanel = el('section', { class: 'claim-panel', hidden: true, 'aria-label': 'File a claim' });
  const claimButton = el('button', { class: 'claim-link', type: 'button', 'aria-expanded': 'false' }, 'File a claim');
  const inlineClaimStatus = el('p', { class: 'form-status full', role: 'status' });
  const inlineClaimForm = el('form', { class: 'inline-claim-form' },
    el('div', { class: 'claim-panel-head' }, el('div', {}, el('h2', {}, 'Request a review'), el('p', {}, 'Contact details stay private to the review team.')), el('button', { class: 'text-button', type: 'button', onclick: () => { claimPanel.hidden = true; claimButton.setAttribute('aria-expanded', 'false'); } }, 'Dismiss')),
    el('label', {}, 'Your name', el('input', { name: 'name', autocomplete: 'name', required: true, maxlength: '100' })),
    el('label', {}, 'Email', el('input', { name: 'email', type: 'email', autocomplete: 'email', required: true, maxlength: '254' })),
    el('label', {}, 'Reason', el('select', { name: 'reason', required: true }, el('option', { value: '' }, 'Choose a reason'), el('option', {}, 'Incorrect attribution'), el('option', {}, 'Private or sensitive material'), el('option', {}, 'Copyright concern'), el('option', {}, 'Harassment or abuse'), el('option', {}, 'Other'))),
    el('label', { class: 'full' }, 'Details', el('textarea', { name: 'details', rows: '3', maxlength: '2000', required: true })),
    inlineClaimStatus,
    el('div', { class: 'full' }, el('button', { class: 'button primary', type: 'submit' }, 'Send review request'))
  );
  inlineClaimForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = inlineClaimForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    inlineClaimStatus.textContent = '';
    inlineClaimStatus.classList.remove('success');
    let sent = false;
    try {
      const body = { ...Object.fromEntries(new FormData(inlineClaimForm)), annotationId: id };
      const { reference } = await api('/api/claims', { method: 'POST', body });
      inlineClaimStatus.classList.add('success');
      inlineClaimStatus.textContent = `Request received. Reference: ${reference}. The annotation remains visible while it is reviewed.`;
      submit.textContent = 'Request sent';
      sent = true;
      inlineClaimForm.querySelectorAll('input, select, textarea').forEach((field) => { field.disabled = true; });
    } catch (error) { inlineClaimStatus.textContent = error.message; }
    finally { submit.disabled = sent; }
  });
  claimPanel.append(inlineClaimForm);
  claimButton.addEventListener('click', () => {
    claimPanel.hidden = !claimPanel.hidden;
    claimButton.setAttribute('aria-expanded', String(!claimPanel.hidden));
    if (!claimPanel.hidden) requestAnimationFrame(() => inlineClaimForm.elements.name.focus());
  });
  const deleteButton = session.user?.id === annotation.author?.id ? el('button', { class: 'text-button', type: 'button' }, 'Delete annotation') : null;
  deleteButton?.addEventListener('click', async () => {
    if (!window.confirm('Delete this annotation and hide its attached media?')) return;
    deleteButton.disabled = true;
    try {
      await api(`/api/annotations/${encodeURIComponent(id)}`, { method: 'DELETE' });
      navigate(source.id ? `/s/${encodeURIComponent(source.id)}` : '/');
      showToast('Annotation deleted');
    } catch (error) { showToast(error.message); deleteButton.disabled = false; }
  });

  const receipt = el('article', { class: 'receipt-shell' },
    el('header', { class: 'receipt-brand-row' },
      el('a', { class: 'brand receipt-wordmark', href: '/' }, document.querySelector('.site-header .brand-icon').cloneNode(true), el('span', {}, 'Annotated')),
      el('nav', { class: 'receipt-nav', 'aria-label': 'Reading navigation' },
        el('a', { href: '/feed' }, 'Feed'),
        session.user?.id ? el('a', { href: `/u/${encodeURIComponent(session.user.id)}` }, 'My annotations') : null
      ),
      claimButton
    ),
    el('div', { class: 'receipt-author' },
      avatar(author, 'receipt-avatar'),
      el('div', {},
        el('a', { class: 'receipt-author-name', href: authorHref }, author.name || 'Unknown author'),
        el('div', { class: 'receipt-author-meta' }, humanDate(annotation.createdAt), annotation.isDemo ? demoBadge() : null)
      )
    ),
    take,
    sourceBlock,
    el('div', { class: 'receipt-actions' },
      copyButton,
      shareButton,
      el('a', { class: 'action-link', href: xIntent, target: '_blank', rel: 'noopener noreferrer' }, 'Post to X ↗'),
      deleteButton
    ),
    claimPanel,
    el('section', { class: 'comments', 'aria-label': 'Replies' }, commentsTitle, commentsList, replyComposer)
  );
  markElement(receipt, annotation.id);
  main.replaceChildren(el('div', { class: 'receipt-page' }, receipt));
}

async function renderProfile(id) {
  const version = routeVersion;
  const data = await api(`/api/users/${encodeURIComponent(id)}`);
  if (version !== routeVersion) return;
  setDocumentTitle(data.user.name);
  activeProfile = profilePage({ el, api, session, data, avatar, annotationCard, signInHref, showToast,
    onSaved: user => { session.user = { ...session.user, ...user }; renderSession(); } });
  main.replaceChildren(activeProfile.root);
  activeProfile.start();
}

function renderInstall() {
  setDocumentTitle('Add to Chrome');
  const address = el('input', { value: 'chrome://extensions', readonly: true, 'aria-label': 'Chrome extensions address' });
  const copyStatus = el('p', { class: 'setup-status', role: 'status' });
  const copy = el('button', { class: 'button secondary', type: 'button' }, 'Copy address');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(address.value); copyStatus.textContent = 'Copied. Paste it into a new Chrome tab.'; }
    catch { address.select(); copyStatus.textContent = 'Copy the selected address and paste it into a new Chrome tab.'; }
  });
  main.replaceChildren(el('section', { class: 'page setup-page install-utility' },
    el('p', { class: 'eyebrow' }, 'CHROME EXTENSION · PREVIEW'),
    el('h1', {}, 'Your browser. Your marks.'),
    el('p', { class: 'lede' }, 'Select a passage or capture a moment beside the source. This preview installs in desktop Chrome.'),
    el('div', { class: 'setup-options' }, session.extensionAvailable
      ? el('a', { class: 'button primary', href: '/extension.zip', download: 'annotated-extension.zip' }, 'Download for Chrome')
      : el('p', { class: 'muted' }, 'The preview download is temporarily unavailable.'), el('a', { href: '/phone' }, 'Using your phone? ↗')),
    el('div', { class: 'setup-card' }, el('h2', {}, 'One setup. Then mark anything.'),
      el('ol', {},
        el('li', {}, el('strong', {}, 'Unzip the download'), 'Open annotated-extension.zip. Keep the extracted folder somewhere permanent.'),
        el('li', {}, el('strong', {}, 'Open Chrome’s extension page'), el('div', { class: 'setup-copy' }, address, copy), copyStatus, 'Turn on Developer mode in the top-right corner.'),
        el('li', {}, el('strong', {}, 'Choose Load unpacked'), 'Select the extracted annotated-extension folder. Chrome installs the preview.'),
        el('li', {}, el('strong', {}, 'Pin Annotated and make your first mark'), 'Use Chrome’s puzzle-piece menu to pin Annotated. Open an article, click the Annotated icon, then sign in inside the panel. Select a passage and add your take.'))),
    el('p', { class: 'editor-hint' }, 'Already installed? Use Reload on Annotated’s extension card after replacing the files, then refresh the source tab.'),
    el('div', { class: 'setup-options' }, el('a', { class: 'button secondary', href: '/write' }, 'Write an article annotation'), el('a', { href: '/feed' }, 'Browse the feed ↗')),
    isLocal() ? el('p', {}, el('a', { href: '/fixtures/article.html', target: '_blank', rel: 'noopener' }, 'Open the local test article ↗')) : null
  ));
}

function renderPhoneSetup() {
  setDocumentTitle('Use on your phone');
  main.replaceChildren(el('section', { class: 'page setup-page' },
    el('p', { class: 'eyebrow' }, 'ANNOTATED · ON YOUR PHONE'), el('h1', {}, 'A thought worth keeping.'),
    el('p', { class: 'lede' }, 'Bring a passage, keep its source, and add your take. The same Annotated, wherever you’re reading.'),
    el('div', { class: 'setup-options' }, el('a', { class: 'button primary', href: '/write' }, 'Write annotation'), el('a', { href: '/feed' }, 'Browse the feed ↗')),
    mobileSetup(el), el('p', { class: 'editor-hint' }, 'Video clipping is available in the desktop Chrome extension.'),
    el('a', { href: '/install' }, 'Set up desktop Chrome ↗')));
}

function renderPrivacy() {
  setDocumentTitle('Privacy');
  main.replaceChildren(el('article', { class: 'page narrow prose' },
    el('p', { class: 'eyebrow' }, isLocal() ? 'Local development policy' : 'Preview service'), el('h1', {}, 'Privacy'),
    el('p', { class: 'lede' }, isLocal() ? 'This build runs on your computer and is intended for product testing.' : 'Annotated stores the annotations and conversations you choose to publish. Public reading does not require sign-in.'),
    el('h2', {}, 'What is stored'), el('p', {}, 'The service stores account sessions, sources, excerpts, commentary, replies, follows, uploaded clips, and review requests you submit. Review requests can include a name and email and are visible only to authorized reviewers.'),
    el('h2', {}, 'Unpublished recordings'), el('p', {}, 'Uploaded clips and voice takes stay private until you publish them. Unpublished uploads become eligible for automatic deletion after 24 hours. Cleanup runs periodically; a backlog or storage failure can delay removal. Clips already attached to an annotation are kept, including when the annotation is hidden or deleted from public view.'),
    el('h2', {}, 'Drafts and source titles'), el('p', {}, 'The web editor keeps an unpublished article draft in this browser tab for up to 24 hours, including while you sign in. Publishing, discarding or signing out clears it. Shared text opens as a draft for your review. When you add a source link, Annotated can request its public page title; it does not send the quoted passage or your take to that source.'),
    el('h2', {}, 'Your commentary'), el('p', {}, 'Your text and voice are not sent to an LLM. Annotated publishes the take you write or record; it does not generate or rewrite your opinion.'),
    el('h2', {}, 'Capture boundaries'), el('p', {}, 'The extension asks for an explicit action before recording. It is designed to capture the chosen source area, stop tracks on cancellation or source loss, reject clips longer than 90 seconds, and avoid credentials or unrelated page areas.'),
    el('h2', {}, 'Public reading'), el('p', {}, 'Annotation receipts, source conversations, profiles, excerpts, commentary, and replies are readable without signing in. Do not put confidential, private, or credential-bearing material into an annotation.'),
    el('h2', {}, isLocal() ? 'Local identities' : 'Sign-in'), el('p', {}, isLocal() ? 'Mira and Leo are clearly labeled test identities. The account switcher is a local development aid.' : 'Google sign-in provides your account identifier, display name and verified email. X sign-in, when available, provides your account identifier, display name and username. We do not request your X email or permission to post. X access tokens are used for the sign-in identity check and are not stored. Your email is not included in public profiles. Google and X identities are separate accounts; use the same option each time.'),
    ...(session.supportEmail ? [el('h2', {}, 'Contact'), el('p', {}, 'Support and review requests: ', el('a', { href: `mailto:${session.supportEmail}` }, session.supportEmail))] : []),
    el('h2', {}, 'Deletion and review'), el('p', {}, 'Annotation owners can delete their own posts. Anyone can send a review request from a receipt. Authorized reviewers can hide or restore an annotation or its media and can reject a request.')
  ));
}

function renderTerms() {
  setDocumentTitle('Terms');
  main.replaceChildren(el('article', { class: 'page narrow prose' },
    el('p', { class: 'eyebrow' }, isLocal() ? 'Local development terms' : 'Preview use'), el('h1', {}, 'Terms of use'),
    el('p', { class: 'lede' }, 'Annotated is a preview. Use it with material you are permitted to annotate.'),
    el('h2', {}, 'Your responsibility'), el('p', {}, 'Only upload and publish material you have the right to use. Keep excerpts focused on the point you are responding to. Do not include private information, credentials, threats, harassment, or unlawful content.'),
    el('h2', {}, 'Source and commentary'), el('p', {}, 'The interface keeps the quoted excerpt, attached source media, human commentary, and original link distinct. An annotation does not imply endorsement by the source author.'),
    el('h2', {}, 'Preview status'), el('p', {}, 'The product is being tested and is not a substitute for the original source. Keep your own copy of contributions you need to retain.'),
    el('h2', {}, 'Review requests'), el('p', {}, 'Use “File a claim” on a receipt to report attribution, privacy, copyright, or abuse concerns. Authorized reviewers can hide content or media while reviewing the request.')
  ));
}

async function renderAdminClaims() {
  setDocumentTitle('Review requests');
  const page = el('div', { class: 'page narrow' }, el('p', { class: 'eyebrow' }, isLocal() ? 'Local operator' : 'Review team'), el('h1', {}, 'Review requests'), el('p', { class: 'lede' }, 'Contact details shown here are private operator data and never appear on public annotation pages.'));
  main.replaceChildren(page);
  const { claims } = await api('/api/admin/claims');
  const list = el('section', { class: 'admin-list' });
  if (!claims.length) list.append(el('div', { class: 'empty-state' }, el('p', {}, 'No review requests.'), el('a', { href: '/feed' }, 'Back to the feed ↗')));
  for (const claim of claims) {
    const status = el('span', { class: 'status-badge' }, claim.status || 'open');
    const note = el('input', { placeholder: 'Private operator note', 'aria-label': `Note for claim ${claim.id}` });
    const card = el('article', { class: 'claim-card' },
      el('div', { class: 'card-topline' }, el('strong', {}, claim.reason || 'Review request'), status),
      el('dl', {},
        el('dt', {}, 'Reference'), el('dd', {}, claim.reference || claim.id),
        el('dt', {}, 'Annotation'), el('dd', {}, el('a', { href: `/a/${encodeURIComponent(claim.annotationId)}` }, claim.annotationId)),
        el('dt', {}, 'From'), el('dd', {}, `${claim.name || ''} · ${claim.email || ''}`),
        el('dt', {}, 'Details'), el('dd', {}, claim.details || '—'),
        el('dt', {}, 'Received'), el('dd', {}, humanDate(claim.createdAt))
      ), note
    );
    const actions = el('div', { class: 'claim-actions' });
    for (const [label, action, scope] of [['Hide annotation', 'hide', 'annotation'], ['Hide media', 'hide', 'media'], ['Reject', 'reject', 'annotation'], ['Restore', 'restore', 'annotation']]) {
      const button = el('button', { class: `button small ${action === 'hide' ? 'primary' : 'subtle'}`, type: 'button' }, label);
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await api(`/api/admin/claims/${encodeURIComponent(claim.id)}`, { method: 'POST', body: { action, scope, note: note.value } });
          showToast(`${label} completed`);
          await renderAdminClaims();
        } catch (error) { showToast(error.message); }
        finally { button.disabled = false; }
      });
      actions.append(button);
    }
    card.append(actions);
    list.append(card);
  }
  page.append(list);
}

function navigate(path) {
  history.pushState({}, '', path);
  renderRoute();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

async function renderRoute() {
  routeVersion++;
  activeProfile?.dispose();
  activeProfile = null;
  activeFeed?.dispose();
  activeFeed = null;
  disposeHome?.();
  disposeHome = null;
  disposeEditor?.();
  disposeEditor = null;
  renderSession();
  main.replaceChildren(el('div', { class: 'route-loading', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading…'));
  let path = location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/' && session.user) { history.replaceState({}, '', '/feed' + location.search); path = '/feed'; }
  const showHome = !session.user && path === '/';
  renderedRouteKey = location.pathname + location.search;
  document.body.dataset.route = showHome ? 'home' : path.startsWith('/a/') ? 'annotation' : path === '/install' ? 'install' : path === '/feed' ? 'feed' : path.startsWith('/u/') ? 'profile' : 'default';
  try {
    if (showHome) {
      setDocumentTitle('Mark the exact part.');
      const home = markerHome({ el, session, brand: document.querySelector('.site-header .brand') });
      disposeHome = home.dispose;
      main.replaceChildren(home.root);
    }
    else if (path === '/feed') await renderFeed();
    else if (path === '/signin') renderSignIn();
    else if (path === '/install') renderInstall();
    else if (path === '/phone') renderPhoneSetup();
    else if (path === '/write') {
      setDocumentTitle('Write annotation');
      const editor = articleEditor({ el, api, session, navigate, signInHref, refreshSession });
      disposeEditor = editor.dispose;
      main.replaceChildren(editor.root);
    }
    else if (path === '/privacy') renderPrivacy();
    else if (path === '/terms') renderTerms();
    else if (path === '/admin/claims') await renderAdminClaims();
    else if (path.startsWith('/a/')) await renderAnnotation(decodeURIComponent(path.slice(3)));
    else if (path.startsWith('/s/')) await renderSource(decodeURIComponent(path.slice(3)));
    else if (path.startsWith('/u/')) await renderProfile(decodeURIComponent(path.slice(3)));
    else {
      setDocumentTitle('Not found');
      main.replaceChildren(el('div', { class: 'empty-state' }, el('p', { class: 'eyebrow' }, '404'), el('h1', {}, 'That page isn’t here.'), el('a', { class: 'button primary', href: '/feed' }, 'Back to the feed')));
    }
  } catch (error) { pageError(error, renderRoute); }
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link || link.target || link.download || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/auth/')) return;
  if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
  event.preventDefault();
  navigate(url.pathname + url.search + url.hash);
});

window.addEventListener('popstate', () => {
  if (activeFeed && location.pathname === '/feed') { activeFeed.restore(); return; }
  // Native in-page anchors must preserve the running home's UI state.
  if (disposeHome && renderedRouteKey === location.pathname + location.search) return;
  renderRoute();
});

// Keep the source and the response intelligible when both have audio.
document.addEventListener('play', (event) => {
  if (!(event.target instanceof HTMLMediaElement) || event.target.closest('.marker-demo')) return;
  document.querySelectorAll('video, audio').forEach((player) => {
    if (player !== event.target) player.pause();
  });
}, true);

await refreshSession();
await renderRoute();
