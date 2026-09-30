// Read-only relationship lists share the profile's identity and navigation.
export function openProfilePeople({ el, api, user, kind, avatar, onClose }) {
  const opener = document.activeElement;
  const previousOverflow = document.documentElement.style.overflow;
  const controller = new AbortController();
  let closed = false;
  let busy = false;
  let offset = 0;
  const shown = new Set();
  const title = kind === 'followers' ? 'Followers' : 'Following';
  const dialog = el('dialog', { class: 'profile-people', 'aria-labelledby': 'profile-people-title', 'aria-describedby': 'profile-people-owner' });
  const closeButton = el('button', { class: 'profile-people-close', type: 'button', 'aria-label': 'Close' }, '×');
  const list = el('ul', { class: 'profile-people-list', 'aria-label': title });
  const status = el('p', { class: 'profile-people-status', role: 'status' });
  const more = el('button', { class: 'button profile-people-more', type: 'button', hidden: true }, 'Show more');
  const content = el('div', { class: 'profile-people-content' }, list, status, more);
  dialog.append(el('header', { class: 'profile-people-header' },
    el('div', {}, el('h2', { id: 'profile-people-title' }, title), el('p', { id: 'profile-people-owner' }, user.name)), closeButton), content);

  function close(restore = true) {
    if (closed) return;
    closed = true;
    controller.abort();
    dialog.removeEventListener('close', nativeClose);
    if (dialog.open) dialog.close();
    dialog.remove();
    document.documentElement.style.overflow = previousOverflow;
    if (restore && opener?.isConnected) opener.focus({ preventScroll: true });
    onClose?.();
  }
  function nativeClose() { close(); }
  async function load() {
    if (busy || closed || offset === null) return;
    const moveFocus = document.activeElement === more;
    busy = true;
    status.textContent = 'Loading…'; status.hidden = false;
    more.disabled = true;
    list.setAttribute('aria-busy', 'true');
    try {
      const data = await api(`/api/users/${encodeURIComponent(user.id)}/${kind}?offset=${offset}`, { signal: controller.signal });
      if (closed) return;
      let firstAdded;
      for (const person of data.users) {
        if (shown.has(person.id)) continue;
        shown.add(person.id);
        const link = el('a', { class: 'profile-person', href: `/u/${encodeURIComponent(person.id)}` },
          avatar(person), el('span', { class: 'profile-person-identity' },
            el('strong', {}, person.name), el('span', {}, `@${person.handle}`)));
        firstAdded ??= link;
        list.append(el('li', {}, link));
      }
      offset = data.nextOffset;
      status.textContent = kind === 'followers' ? 'No followers yet.' : 'Not following anyone yet.';
      status.hidden = shown.size > 0;
      more.textContent = 'Show more'; more.hidden = offset === null;
      if (moveFocus) (firstAdded || (offset === null ? closeButton : more)).focus();
    } catch (error) {
      if (closed || error.name === 'AbortError') return;
      status.textContent = `Couldn’t load ${title.toLowerCase()}. Please try again.`;
      more.textContent = 'Try again'; more.hidden = false;
    } finally {
      busy = false;
      if (!closed) { more.disabled = false; list.setAttribute('aria-busy', 'false'); }
    }
  }
  closeButton.addEventListener('click', () => close());
  more.addEventListener('click', load);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', nativeClose);
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });
  document.body.append(dialog);
  document.documentElement.style.overflow = 'hidden';
  dialog.showModal(); closeButton.focus({ preventScroll: true });
  void load();
  return { dispose() { close(false); } };
}
