import { openProfileEditor } from './profile-editor.js';
import { openProfilePeople } from './profile-people.js';

export function profileCount(value) {
  const count = Math.max(0, Math.floor(Number(value) || 0));
  if (count < 10000) return count.toLocaleString('en-US');
  if (count >= 999950) return `${Number((count / 1000000).toFixed(1))}M`;
  return `${Number((count / 1000).toFixed(1))}k`;
}

const FOLLOW_INTENT = 'annotated:follow-intent';
export function takeFollowIntent(storage, id, now = Date.now()) {
  try {
    const intent = JSON.parse(storage.getItem(FOLLOW_INTENT));
    if (!intent || intent.id !== id) return false;
    storage.removeItem(FOLLOW_INTENT);
    return Number.isFinite(intent.at) && now >= intent.at && now - intent.at < 15 * 60 * 1000;
  } catch { return false; }
}

export function profilePage({ el, api, session, data, avatar, annotationCard, signInHref, onSaved, showToast }) {
  let user = data.user;
  let following = Boolean(data.isFollowing);
  let followers = data.followerCount;
  let busy = false;
  let disposed = false;
  let prompt;
  let promptTimer;
  let editor;
  let people;
  const timers = new Set();
  const own = session.user?.id === user.id;
  const firstName = user.name.trim().split(/\s+/)[0];
  const path = `/u/${encodeURIComponent(user.id)}`;
  const error = el('p', { class: 'profile-follow-error', role: 'status', hidden: true });
  const bio = el('p', { class: 'profile-bio' });
  const counts = el('div', { class: 'profile-counts' });
  const portrait = el('div', { class: 'profile-portrait' }, avatar(user, 'avatar profile-avatar'));
  const action = el('button', { class: 'button profile-action', type: 'button' });
  const actionWrap = el('div', { class: 'profile-action-wrap' }, action);
  const details = el('div', { class: 'profile-details' });
  const name = el('div', { class: 'profile-name' }, el('h1', {}, user.name), el('p', { class: 'profile-handle', title: `@${user.handle}` }, `@${user.handle}`));
  const identity = el('header', { class: 'profile-identity-block' }, portrait, name, actionWrap, details);
  const cards = data.annotations.map(annotation => annotationCard(annotation, {
    following, onFollow: () => session.user ? void follow(!following) : openPrompt(true)
  }));
  const annotations = el('div', { class: 'feed-grid' }, cards);
  const root = el('div', { class: 'page profile-page' }, identity,
    el('section', { class: 'profile-annotations', 'aria-label': 'Annotations' },
      el('h2', { class: 'profile-list-label' }, 'Annotations · Newest first'),
      data.annotations.length ? annotations : el('div', { class: 'profile-empty' }, el('p', {}, 'Nothing marked yet.'),
        own ? el('a', { class: 'button primary', href: '/write' }, 'Write annotation') : el('span', {}, `${firstName}’s annotations will show up here.`))));

  function update() {
    bio.textContent = user.bio || '';
    details.replaceChildren(...(user.bio ? [bio] : []), counts, error);
    counts.replaceChildren(...[[data.annotationCount, 'annotation'], [followers, 'follower', 'followers'], [data.followingCount, 'following', 'following']].map(([value, noun, kind]) =>
      el(kind ? 'button' : 'span', kind ? { type: 'button', class: 'profile-count-link', 'aria-haspopup': 'dialog', onclick: () => {
        people?.dispose();
        people = openProfilePeople({ el, api, user, kind, avatar, onClose: () => { people = null; } });
      } } : {}, el('strong', {}, profileCount(value)), ` ${noun}${noun !== 'following' && value !== 1 ? 's' : ''}`)));
    action.classList.toggle('primary', !own && !following);
    action.classList.toggle('is-following', !own && following);
    if (own) action.textContent = 'Edit profile';
    else {
      action.setAttribute('aria-pressed', String(following));
      action.setAttribute('aria-label', following ? 'Following' : 'Follow');
      action.replaceChildren(...[el('span', { class: 'profile-follow-label', 'aria-hidden': 'true' }, following ? 'Following' : 'Follow'),
        following ? el('span', { class: 'profile-unfollow-label', 'aria-hidden': 'true' }, 'Unfollow') : null].filter(Boolean));
    }
    action.disabled = busy;
    for (const card of cards) card.updateFollowState?.(following, busy);
  }

  function closePrompt(restore = true, immediate = false) {
    if (!prompt) return;
    const closing = prompt;
    prompt = null;
    closing.inert = true;
    closing.classList.add('is-closing');
    clearTimeout(promptTimer);
    if (immediate) closing.remove();
    else promptTimer = setTimeout(() => closing.remove(), 120);
    action.removeAttribute('aria-expanded');
    action.removeAttribute('aria-controls');
    if (restore && action.isConnected) action.focus({ preventScroll: true });
  }

  function openPrompt(revealAnchor = false) {
    if (revealAnchor) action.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (prompt) return prompt.querySelector('a').focus();
    clearTimeout(promptTimer);
    actionWrap.querySelectorAll('.profile-signin-prompt.is-closing').forEach(node => node.remove());
    prompt = el('div', { class: 'profile-signin-prompt', id: 'profile-signin', role: 'dialog', 'aria-labelledby': 'profile-signin-title' },
      el('p', { id: 'profile-signin-title' }, `Sign in to follow ${firstName}.`),
      el('div', { class: 'profile-signin-actions' },
        el('a', { class: 'button primary', href: signInHref(path), onclick: () => {
          // A return visit only completes a follow explicitly requested here.
          try { sessionStorage.setItem(FOLLOW_INTENT, JSON.stringify({ id: user.id, at: Date.now() })); } catch { /* Follow remains available after sign-in. */ }
        } }, 'Sign in'),
        el('button', { class: 'text-button', type: 'button', onclick: () => closePrompt() }, 'Not now')));
    actionWrap.append(prompt);
    action.setAttribute('aria-expanded', 'true'); action.setAttribute('aria-controls', prompt.id);
    prompt.querySelector('a').focus({ preventScroll: true });
  }

  async function follow(next) {
    if (busy || disposed) return;
    const previous = following;
    const previousCount = followers;
    busy = true; following = next;
    followers = Math.max(0, followers + Number(next) - Number(previous));
    error.hidden = true; update();
    try {
      const result = await api(`/api/users/${encodeURIComponent(user.id)}/follow`, { method: 'POST', body: { following: next } });
      if (disposed) return;
      following = Boolean(result.following);
      followers = Math.max(0, previousCount + Number(following) - Number(previous));
    } catch {
      if (disposed) return;
      following = previous; followers = previousCount;
      error.textContent = next ? "Couldn't follow. Try again." : "Couldn't unfollow. Try again.";
      error.hidden = false;
    } finally { if (!disposed) { busy = false; update(); } }
  }

  function swapAvatar(container, next, className) {
    const previous = container.firstElementChild;
    const replacement = avatar(next, className);
    container.prepend(replacement);
    if (!previous) return;
    previous.classList.add('profile-avatar-out');
    const timer = setTimeout(() => { previous.remove(); timers.delete(timer); }, 250);
    timers.add(timer);
  }

  action.addEventListener('click', () => {
    if (own) {
      editor = openProfileEditor({ el, api, user, avatar,
        onSaved: updated => {
          if (disposed) return;
          const photoChanged = updated.avatarUrl !== user.avatarUrl;
          user = updated;
          if (photoChanged) swapAvatar(portrait, user, 'avatar profile-avatar');
          for (const item of annotations.querySelectorAll('.feed-author')) {
            const old = item.querySelector('.avatar');
            if (old) old.replaceWith(avatar(user));
          }
          update(); onSaved(user); showToast('Profile saved', { profile: true });
        }, onClose: () => { editor = null; } });
    } else if (!session.user) openPrompt();
    else void follow(!following);
  });
  function outside(event) { if (prompt && !actionWrap.contains(event.target)) closePrompt(); }
  function escape(event) { if (prompt && event.key === 'Escape') { event.preventDefault(); closePrompt(); } }
  document.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', escape);
  update();
  return { root, start() {
    if (session.user && !own && takeFollowIntent(sessionStorage, user.id) && !following) void follow(true);
  }, dispose() {
    disposed = true; closePrompt(false, true); clearTimeout(promptTimer); editor?.dispose(); people?.dispose();
    for (const timer of timers) clearTimeout(timer);
    document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape);
  } };
}
