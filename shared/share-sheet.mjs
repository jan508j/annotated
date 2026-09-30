const FORMATS = {
  wide: { width: 2400, height: 1260 },
  tall: { width: 2160, height: 2700 }
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function supportsPngClipboard() {
  return Boolean(navigator.clipboard?.write && globalThis.ClipboardItem &&
    (typeof ClipboardItem.supports !== 'function' || ClipboardItem.supports('image/png')));
}

/** Open the image export dialog for a published annotation. */
export function openShareSheet({ annotation, apiOrigin = location.origin }) {
  if (!annotation?.id) throw new TypeError('A published annotation with an id is required.');

  document.querySelector('.share-sheet')?.close();
  const previousFocus = document.activeElement;
  const dialog = node('dialog', 'share-sheet');
  dialog.setAttribute('aria-labelledby', 'share-sheet-title');
  dialog.setAttribute('aria-describedby', 'share-sheet-size');
  const heading = node('h2', '', 'Share as image');
  heading.id = 'share-sheet-title';
  const closeButton = node('button', 'share-sheet-close', '×');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close share sheet');
  const header = node('div', 'share-sheet-header');
  header.append(heading, closeButton);

  const preview = node('div', 'share-sheet-preview');
  preview.setAttribute('aria-live', 'polite');
  const image = node('img', 'share-sheet-image');
  image.alt = `Share image for ${annotation.author?.name || 'this annotation'}`;
  image.hidden = true;
  const previewStatus = node('p', 'share-sheet-preview-status', 'Preparing image…');
  preview.append(image, previewStatus);

  const segmented = node('div', 'share-sheet-formats');
  segmented.setAttribute('role', 'group');
  segmented.setAttribute('aria-label', 'Image format');
  const formatButtons = Object.keys(FORMATS).map((format) => {
    const button = node('button', '', format === 'wide' ? 'Wide' : 'Tall');
    button.type = 'button';
    button.dataset.format = format;
    button.addEventListener('click', () => load(format));
    segmented.append(button);
    return button;
  });
  const size = node('span', 'share-sheet-size');
  size.id = 'share-sheet-size';
  const formatRow = node('div', 'share-sheet-format-row');
  formatRow.append(segmented, size);

  const download = node('a', 'share-sheet-download', 'Download PNG');
  // A nonempty download attribute bypasses the app router. The endpoint's
  // Content-Disposition supplies the author/annotation filename.
  download.download = 'annotated-image.png';
  download.setAttribute('aria-disabled', 'true');
  download.tabIndex = -1;
  const copy = node('button', 'share-sheet-copy', 'Copy image');
  copy.type = 'button';
  copy.hidden = !supportsPngClipboard();
  copy.disabled = true;
  const actions = node('div', 'share-sheet-actions');
  actions.append(download, copy);
  const feedback = node('p', 'share-sheet-feedback');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');

  const linkUrl = new URL(`/a/${encodeURIComponent(annotation.id)}`, apiOrigin).href;
  if (typeof navigator.share === 'function') {
    const shareLink = node('button', 'share-sheet-link', 'Share link');
    shareLink.type = 'button';
    shareLink.addEventListener('click', async () => {
      try {
        await navigator.share({ title: 'Annotated', url: linkUrl });
      } catch (error) {
        if (error?.name !== 'AbortError') feedback.textContent = 'Could not share the link.';
      }
    });
    dialog.append(header, preview, formatRow, actions, shareLink, feedback);
  } else dialog.append(header, preview, formatRow, actions, feedback);

  let activeController;
  let previewUrl;
  let pngBlob;
  let selectedFormat;
  let generation = 0;
  let closed = false;

  function cardUrl(format, forDownload = false) {
    const url = new URL(`/api/annotations/${encodeURIComponent(annotation.id)}/share-card.png`, apiOrigin);
    url.searchParams.set('format', format);
    if (forDownload) url.searchParams.set('download', '1');
    return url.href;
  }

  function clearPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    pngBlob = null;
    image.removeAttribute('src');
    image.hidden = true;
  }

  async function load(format) {
    if (closed || (format === selectedFormat && (activeController || pngBlob))) return;
    selectedFormat = format;
    const current = ++generation;
    activeController?.abort();
    activeController = new AbortController();
    clearPreview();
    preview.dataset.format = format;
    previewStatus.hidden = false;
    previewStatus.textContent = 'Preparing image…';
    feedback.textContent = '';
    download.removeAttribute('href');
    download.setAttribute('aria-disabled', 'true');
    download.tabIndex = -1;
    copy.disabled = true;
    size.textContent = `${FORMATS[format].width}×${FORMATS[format].height} · PNG`;
    for (const button of formatButtons) button.setAttribute('aria-pressed', String(button.dataset.format === format));
    try {
      const response = await fetch(cardUrl(format), { signal: activeController.signal });
      if (!response.ok) throw new Error(`Image could not load (${response.status}).`);
      const blob = await response.blob();
      if (blob.type !== 'image/png') throw new Error('The image service returned an invalid PNG.');
      if (closed || current !== generation) return;
      pngBlob = blob;
      previewUrl = URL.createObjectURL(blob);
      image.src = previewUrl;
      image.width = FORMATS[format].width;
      image.height = FORMATS[format].height;
      image.hidden = false;
      previewStatus.hidden = true;
      download.href = cardUrl(format, true);
      download.removeAttribute('aria-disabled');
      download.tabIndex = 0;
      copy.disabled = false;
    } catch (error) {
      if (error.name === 'AbortError' || closed || current !== generation) return;
      previewStatus.textContent = error.message || 'Image could not load. Try another format.';
    } finally {
      if (current === generation) activeController = null;
    }
  }

  download.addEventListener('click', (event) => {
    if (!pngBlob) event.preventDefault();
  });
  copy.addEventListener('click', async () => {
    if (!pngBlob) return;
    copy.disabled = true;
    feedback.textContent = '';
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      feedback.textContent = 'Image copied';
    } catch { feedback.textContent = 'Could not copy the image. Download it instead.'; }
    finally { if (!closed) copy.disabled = false; }
  });
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    closed = true;
    generation++;
    activeController?.abort();
    clearPreview();
    dialog.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  }, { once: true });

  document.body.append(dialog);
  dialog.showModal();
  closeButton.focus();
  load('wide');
  return dialog;
}
