import { prepareProfilePhoto } from './profile-photo.js';

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const BIO_LIMIT = 160;

// The caller owns the profile page and toast; this module owns only the draft dialog.
export function openProfileEditor({ el, api, user, avatar, onSaved, onClose }) {
  const opener = document.activeElement;
  const originalBio = user.bio || '';
  let draftPhoto;
  let preparing = false;
  let saving = false;
  let failed = false;
  let closed = false;
  let closing = false;
  const previousOverflow = document.documentElement.style.overflow;
  let photoRequest = 0;
  let previewTimer;
  let closeTimer;

  const dialog = el('dialog', { class: 'profile-editor', 'aria-labelledby': 'profile-editor-title', 'aria-modal': 'true' });
  const title = el('h2', { id: 'profile-editor-title' }, 'Edit profile');
  const fileInput = el('input', { class: 'profile-editor-file', type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': 'Profile photo' });
  const preview = el('div', { class: 'profile-editor-preview', 'aria-label': 'Profile photo preview' });
  const chooseButton = el('button', { class: 'profile-editor-pill profile-editor-outline', type: 'button' });
  const removeButton = el('button', { class: 'profile-editor-remove', type: 'button' }, 'Remove photo');
  const photoError = el('p', { class: 'profile-editor-error', role: 'alert', hidden: true });
  const bio = el('textarea', { id: 'profile-editor-bio', rows: '3', placeholder: 'A line about what you mark', 'aria-describedby': 'profile-editor-bio-hint' });
  bio.value = originalBio;
  const counter = el('span', { class: 'profile-editor-counter', 'aria-live': 'polite' });
  const bioError = el('p', { class: 'profile-editor-error', id: 'profile-editor-bio-hint', hidden: true }, 'Keep it to 160 characters.');
  const saveError = el('p', { class: 'profile-editor-error profile-editor-save-error', role: 'alert', hidden: true });
  const cancelTop = el('button', { class: 'profile-editor-top-cancel', type: 'button' }, 'Cancel');
  const cancelFooter = el('button', { class: 'profile-editor-pill profile-editor-outline profile-editor-footer-cancel', type: 'button' }, 'Cancel');
  const saveTop = el('button', { class: 'profile-editor-pill profile-editor-primary profile-editor-top-save', type: 'submit' }, 'Save');
  const saveFooter = el('button', { class: 'profile-editor-pill profile-editor-primary profile-editor-footer-save', type: 'submit' }, 'Save changes');

  function photoValue() { return draftPhoto === undefined ? user.avatarUrl : draftPhoto; }
  function photoLayer(value) {
    const layer = avatar({ ...user, avatarUrl: value?.startsWith('/api/users/') ? value : null }, 'profile-editor-avatar');
    if (value && !value.startsWith('/api/users/')) {
      const image = el('img', { src: value, alt: '', decoding: 'async' });
      image.addEventListener('load', () => layer.replaceChildren(image), { once: true });
    }
    return layer;
  }
  function showPreview(animate = true) {
    clearTimeout(previewTimer);
    const next = photoLayer(photoValue());
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      preview.replaceChildren(next);
      return;
    }
    next.classList.add('profile-editor-preview-next');
    preview.append(next);
    requestAnimationFrame(() => next.classList.add('profile-editor-preview-visible'));
    previewTimer = setTimeout(() => {
      if (!closed) { preview.replaceChildren(next); next.classList.remove('profile-editor-preview-next', 'profile-editor-preview-visible'); }
    }, 270);
  }
  function setPhotoError(message = '') {
    photoError.textContent = message;
    photoError.hidden = !message;
  }
  function setSaveError(message = '') {
    saveError.textContent = message;
    saveError.hidden = !message;
  }
  function update() {
    const length = Array.from(bio.value).length;
    const invalid = length > BIO_LIMIT;
    const changed = bio.value !== originalBio || draftPhoto !== undefined;
    counter.textContent = `${length}/${BIO_LIMIT}`;
    counter.classList.toggle('profile-editor-invalid', invalid);
    bio.classList.toggle('profile-editor-invalid', invalid);
    bio.setAttribute('aria-invalid', String(invalid));
    bioError.hidden = !invalid;
    chooseButton.textContent = photoValue() ? 'Replace photo' : 'Choose photo';
    removeButton.hidden = !photoValue();
    chooseButton.disabled = preparing || saving;
    removeButton.disabled = preparing || saving;
    fileInput.disabled = preparing || saving;
    bio.disabled = saving;
    cancelTop.disabled = saving;
    cancelFooter.disabled = saving;
    const canSave = changed && !invalid && !preparing && !saving;
    saveTop.disabled = !canSave;
    saveFooter.disabled = !canSave;
    saveTop.textContent = saving ? 'Saving…' : failed ? 'Try again' : 'Save';
    saveFooter.textContent = saving ? 'Saving…' : failed ? 'Try again' : 'Save changes';
    dialog.setAttribute('aria-busy', String(saving));
    saveTop.setAttribute('aria-busy', String(saving));
    saveFooter.setAttribute('aria-busy', String(saving));
  }
  function finish() {
    if (closed) return;
    closed = true;
    photoRequest++;
    clearTimeout(previewTimer);
    clearTimeout(closeTimer);
    dialog.removeEventListener('close', onNativeClose);
    if (dialog.open) dialog.close();
    dialog.remove();
    document.documentElement.style.overflow = previousOverflow;
    if (opener?.isConnected) opener.focus();
    onClose?.();
  }
  function close() {
    if (closed || closing || saving) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
    closing = true;
    dialog.inert = true;
    dialog.classList.add('profile-editor-closing');
    closeTimer = setTimeout(finish, matchMedia('(max-width: 639px)').matches ? 240 : 160);
  }
  function onNativeClose() { finish(); }

  const form = el('form', { method: 'dialog', class: 'profile-editor-form' },
    el('header', { class: 'profile-editor-header' }, cancelTop, title, saveTop),
    el('div', { class: 'profile-editor-content' },
      el('section', { class: 'profile-editor-photo' },
        el('div', { class: 'profile-editor-photo-row' }, preview,
          el('div', { class: 'profile-editor-photo-copy' },
            el('div', { class: 'profile-editor-photo-actions' }, chooseButton, removeButton, fileInput),
            el('p', { class: 'profile-editor-photo-hint' }, 'JPEG, PNG OR WEBP · UP TO 5 MB'))), photoError),
      el('section', { class: 'profile-editor-identity' },
        el('div', { class: 'profile-editor-identity-grid' },
          el('div', {}, el('span', { class: 'profile-editor-label' }, 'NAME'), el('div', { class: 'profile-editor-readonly', role: 'textbox', 'aria-label': 'Name', 'aria-readonly': 'true', title: user.name }, user.name)),
          el('div', {}, el('span', { class: 'profile-editor-label' }, 'HANDLE'), el('div', { class: 'profile-editor-readonly', role: 'textbox', 'aria-label': 'Handle', 'aria-readonly': 'true', title: `@${user.handle}` }, `@${user.handle}`))),
        el('p', { class: 'profile-editor-note' }, "Name and handle can't be changed yet.")),
      el('section', { class: 'profile-editor-bio' },
        el('div', { class: 'profile-editor-bio-heading' }, el('label', { class: 'profile-editor-label', for: 'profile-editor-bio' }, 'BIO'), counter),
        bio, bioError), saveError),
    el('footer', { class: 'profile-editor-footer' }, cancelFooter, saveFooter));
  dialog.append(form);

  chooseButton.addEventListener('click', () => { if (!preparing && !saving) fileInput.click(); });
  removeButton.addEventListener('click', () => {
    if (preparing || saving) return;
    draftPhoto = user.avatarUrl ? null : undefined;
    failed = false;
    setPhotoError(); setSaveError(); showPreview(); update();
    chooseButton.focus();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file || closed) return;
    setPhotoError(); setSaveError(); failed = false;
    if (!PHOTO_TYPES.has(file.type)) { setPhotoError("That file type isn't supported. Use a JPEG, PNG or WebP."); update(); return; }
    if (!file.size || file.size > MAX_PHOTO_BYTES) {
      setPhotoError(file.size > MAX_PHOTO_BYTES
        ? `That photo is ${(file.size / 1024 / 1024).toFixed(1)} MB. Choose one under 5 MB.`
        : 'Choose a photo under 5 MB.');
      update(); return;
    }
    const request = ++photoRequest;
    preparing = true; update();
    try {
      const prepared = await prepareProfilePhoto(file);
      if (closed || request !== photoRequest) return;
      draftPhoto = prepared;
      showPreview();
    } catch {
      if (!closed && request === photoRequest) setPhotoError('This photo could not be opened. Try another JPEG, PNG or WebP.');
    } finally {
      if (!closed && request === photoRequest) { preparing = false; update(); }
    }
  });
  bio.addEventListener('input', () => { failed = false; setSaveError(); update(); });
  for (const button of [cancelTop, cancelFooter]) button.addEventListener('click', close);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (closed || closing || saving || preparing || Array.from(bio.value).length > BIO_LIMIT || (bio.value === originalBio && draftPhoto === undefined)) return;
    saving = true; failed = false; setSaveError(); update();
    const body = { bio: bio.value };
    if (draftPhoto !== undefined) body.photo = draftPhoto;
    let result;
    try {
      result = await api(`/api/users/${encodeURIComponent(user.id)}/profile`, { method: 'POST', body });
    } catch {
      if (closed) return;
      saving = false; failed = true;
      setSaveError(draftPhoto && typeof draftPhoto === 'string'
        ? "Your photo didn't upload, so nothing was saved. Your changes are still here."
        : "Your changes weren't saved. They're still here. Try again.");
      update();
      return;
    }
    if (closed) return;
    try { onSaved?.(result.user); } finally { saving = false; close(); }
  });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')]
      .filter(node => !node.hidden && node.getClientRects().length);
    if (!controls.length) { event.preventDefault(); return; }
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('close', onNativeClose);
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  });

  showPreview(false);
  update();
  document.body.append(dialog);
  document.documentElement.style.overflow = 'hidden';
  dialog.showModal();
  requestAnimationFrame(() => dialog.classList.add('profile-editor-open'));
  chooseButton.focus();
  return { dispose: finish };
}
