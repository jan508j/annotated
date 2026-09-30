(() => {
  if (globalThis.__annotatedInstalled) return;
  globalThis.__annotatedInstalled = true;

  let prepared = null;
  let stopListeners = null;
  let selectedPassage = null;
  const observedMedia = new WeakSet();

  function observeMedia(element) {
    if (observedMedia.has(element)) return;
    observedMedia.add(element);
    let lastSent = 0;
    const report = (event) => {
      const now = Date.now();
      if (event.type === 'timeupdate' && now - lastSent < 250) return;
      lastSent = now;
      // Position metadata only. This never starts playback or capture.
      try {
        chrome.runtime.sendMessage({
          type: 'ANNOTATED_MEDIA_POSITION', url: location.href,
          mediaId: element.dataset.annotatedMediaId, event: event.type,
          currentTime: Number.isFinite(element.currentTime) ? element.currentTime : 0,
          duration: Number.isFinite(element.duration) ? element.duration : null
        }).catch(() => {}); // The sidebar may be closed.
      } catch {
        // Reloading the extension can invalidate an existing page's context.
        for (const type of ['timeupdate', 'seeked', 'durationchange']) element.removeEventListener(type, report);
      }
    };
    for (const event of ['timeupdate', 'seeked', 'durationchange']) element.addEventListener(event, report);
  }

  function cleanText(value, limit = 2000) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, limit);
  }

  function cleanPublisher(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/<[^>]*>/g, ' ').replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim().slice(0, 100).trim();
  }

  function publisherFromPage() {
    const siteName = cleanPublisher(document.querySelector('meta[property="og:site_name"]')?.content);
    if (siteName) return siteName;
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      if (script.textContent.length > 64 * 1024) continue;
      let data;
      try { data = JSON.parse(script.textContent); } catch { continue; }
      const queue = Array.isArray(data) ? [...data] : [data];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const publishers = Array.isArray(item.publisher) ? item.publisher : [item.publisher];
        for (const publisher of publishers) {
          const name = cleanPublisher(publisher?.name);
          if (name) return name;
        }
        if (Array.isArray(item['@graph'])) queue.push(...item['@graph']);
      }
    }
    return '';
  }

  function xStatusPath(url) {
    if (!url) return '';
    try { return /^\/[A-Za-z0-9_]+\/status\/\d+/i.exec(new URL(url, location.href).pathname)?.[0].toLowerCase() || ''; }
    catch { return ''; }
  }

  function articleStatusPath(article) {
    const timestamp = article?.querySelector?.('time');
    const link = timestamp?.closest?.('a[href]');
    return xStatusPath(link?.getAttribute?.('href') || link?.href || '');
  }

  function selectedArticle() {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const node = selection.getRangeAt(0).commonAncestorContainer;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return element?.closest?.('article') || null;
  }

  function shortTitle(value, limit = 300) {
    const text = cleanText(value, limit + 1);
    return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
  }

  function selectionText() {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return '';
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    const privateFields = 'input, textarea, select, form, [contenteditable]:not([contenteditable="false"])';
    if (container?.closest?.(privateFields) || [...document.querySelectorAll(privateFields)].some((field) => range.intersectsNode(field))) {
      selectedPassage = null;
      return '';
    }
    return cleanText(selection.toString());
  }

  function rememberSelection() {
    if (selectedPassage?.url !== location.href) selectedPassage = null;
    const text = selectionText();
    if (text) selectedPassage = { text, url: location.href, articleStatus: articleStatusPath(selectedArticle()) };
  }

  // Keep the last explicit passage when focus moves from the page to the panel.
  // It stays in this document and is read only when the user connects/attaches it.
  document.addEventListener('selectionchange', rememberSelection);

  function mediaId(element, index) {
    if (!element.dataset.annotatedMediaId) element.dataset.annotatedMediaId = `annotated-media-${index + 1}-${Math.random().toString(36).slice(2, 7)}`;
    observeMedia(element);
    return element.dataset.annotatedMediaId;
  }

  function visibleRect(element) {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right);
    const bottom = Math.min(innerHeight, rect.bottom);
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  function listMedia() {
    return [...document.querySelectorAll('video, audio')].map((element, index) => {
      const rect = visibleRect(element);
      return {
        id: mediaId(element, index),
        kind: element.tagName === 'VIDEO' ? 'video' : 'audio',
        label: cleanText(element.getAttribute('aria-label') || element.title || element.currentSrc?.split('/').pop() || `${element.tagName === 'VIDEO' ? 'Video' : 'Audio'} ${index + 1}`, 120),
        currentTime: Number.isFinite(element.currentTime) ? element.currentTime : 0,
        duration: Number.isFinite(element.duration) ? element.duration : null,
        paused: element.paused,
        visible: rect.width >= 2 && rect.height >= 2,
        native: Boolean(element.currentSrc)
      };
    }).filter((item) => item.native);
  }

  function snapshot() {
    const media = listMedia();
    rememberSelection();
    const excerpt = selectedPassage?.text || '';
    const embeddedSources = [...document.querySelectorAll('iframe[src]')].map((frame) => frame.src.toLowerCase());
    const embeddedKind = embeddedSources.some((src) => /youtube|vimeo|wistia/.test(src)) ? 'video'
      : embeddedSources.some((src) => /soundcloud|spotify|podbean/.test(src)) ? 'audio' : null;
    const statusPath = xStatusPath(location.href);
    const isXPost = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i.test(location.hostname) && Boolean(statusPath);
    if (isXPost && excerpt && selectedPassage?.articleStatus !== statusPath) {
      throw new Error('This highlight belongs to a different X post or its source cannot be verified. Open that post directly before attaching it.');
    }
    const post = isXPost ? [...document.querySelectorAll('article')].find((item) => articleStatusPath(item) === statusPath) : null;
    const authorPath = isXPost ? `/${statusPath.split('/')[1]}` : '';
    const nameBox = post?.querySelector('[data-testid="User-Name"]');
    const nameLink = [...(nameBox?.querySelectorAll?.('a[href]') || [])].find((link) => {
      try { return new URL(link.getAttribute('href') || link.href, location.href).pathname.toLowerCase() === authorPath; }
      catch { return false; }
    });
    const postName = nameLink?.querySelector?.('span')?.textContent || nameLink?.textContent || '';
    const postText = post?.querySelector('[data-testid="tweetText"]')?.textContent || '';
    const metaAuthor = document.querySelector('meta[name="author"]')?.content || document.querySelector('[rel="author"]')?.textContent || '';
    const titleAuthor = /^\s*(?:\(\d+\)\s*)?(.{1,80}?)\s+on\s+(?:X|Twitter)\s*:/i.exec(document.title)?.[1] || '';
    const isYouTube = /^(?:[a-z0-9-]+\.)?youtube\.com$/i.test(location.hostname);
    const author = isXPost ? postName || titleAuthor || `@${statusPath.split('/')[1]}` : isYouTube ? youtubeChannel() : metaAuthor;
    // YouTube can retain the previous video's Open Graph title across in-page
    // navigation, while its document title follows the current player.
    const youtubeTitle = /^(?:www\.)?(?:youtube\.com|youtu\.be)$/i.test(location.hostname) ? document.title : '';
    const title = isXPost && postText ? postText : youtubeTitle || document.querySelector('meta[property="og:title"]')?.content || document.title || location.hostname;
    return {
      url: location.href,
      title: shortTitle(title),
      author: cleanText(author, 160),
      publisher: publisherFromPage(),
      excerpt,
      kind: excerpt ? 'article' : media.some((item) => item.kind === 'video') ? 'video' : media.some((item) => item.kind === 'audio') ? 'audio' : embeddedKind || 'article',
      media,
      unsupportedEmbed: Boolean(embeddedKind && !media.length)
    };
  }

  function youtubeChannel() {
    const videoId = new URL(location.href).searchParams.get('v');
    if (!videoId || !/^[a-zA-Z0-9_-]+$/.test(videoId)) return '';
    const watch = document.querySelector(`ytd-watch-flexy[video-id="${videoId}"]`);
    const heading = cleanText(watch?.querySelector('#title h1')?.textContent);
    const title = cleanText(document.title).replace(/\s*-\s*YouTube$/i, '').replace(/^\(\d+\)\s*/, '');
    // Navigation updates the URL before the watch page. Wait for matching
    // video identity and title instead of borrowing a previous/recommended owner.
    if (!heading || heading !== title) return '';
    return cleanText(watch.querySelector('#owner #channel-name a')?.textContent, 160);
  }

  function findMedia(id) {
    return [...document.querySelectorAll('video, audio')].find((element) => element.dataset.annotatedMediaId === id);
  }

  function readMedia(id) {
    const element = findMedia(id);
    if (!element) throw new Error('That media player is no longer on this page.');
    return {
      currentTime: Number.isFinite(element.currentTime) ? element.currentTime : 0,
      duration: Number.isFinite(element.duration) ? element.duration : null,
      mediaKind: element.tagName === 'VIDEO' ? 'video' : 'audio'
    };
  }

  async function seek(element, time) {
    if (Math.abs(element.currentTime - time) < 0.08) return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The player did not seek to the excerpt start.')), 4000);
      const done = () => { clearTimeout(timeout); resolve(); };
      element.addEventListener('seeked', done, { once: true });
      element.currentTime = time;
    });
  }

  function clearRangeListeners() {
    stopListeners?.();
    stopListeners = null;
  }

  async function prepare(message) {
    cancel();
    const element = findMedia(message.mediaId);
    if (!element) throw new Error('That media player is no longer on this page.');
    if (!element.currentSrc) throw new Error('This player does not expose a native media source that Annotated can control.');
    const rect = visibleRect(element);
    if (element.tagName === 'VIDEO' && (rect.width < 16 || rect.height < 16)) throw new Error('Keep the video player visible before recording.');
    const playerRect = element.getBoundingClientRect();
    const protectedField = [...document.querySelectorAll('input[type="password"]')].some((field) => {
      const item = field.getBoundingClientRect();
      return item.left < playerRect.right && item.right > playerRect.left && item.top < playerRect.bottom && item.bottom > playerRect.top;
    });
    if (protectedField) throw new Error('Recording is blocked because a password field overlaps the player.');
    const otherPlaying = [...document.querySelectorAll('video, audio')].filter((item) => item !== element && !item.paused);
    otherPlaying.forEach((item) => item.pause());
    element.pause();
    const playbackRate = element.playbackRate;
    try {
      element.playbackRate = 1;
      await seek(element, message.start);
    } catch (error) {
      element.playbackRate = playbackRate;
      otherPlaying.forEach((item) => item.play().catch(() => {}));
      throw error;
    }
    prepared = {
      jobId: message.jobId,
      element,
      source: element.currentSrc,
      start: message.start,
      end: message.end,
      otherPlaying,
      playbackRate,
      rect,
      viewport: { width: innerWidth, height: innerHeight }
    };
    return {
      rect,
      viewport: { width: innerWidth, height: innerHeight },
      mediaKind: element.tagName === 'VIDEO' ? 'video' : 'audio',
      currentSrc: element.currentSrc
    };
  }

  async function playRange() {
    if (!prepared?.element?.isConnected || prepared.element.currentSrc !== prepared.source) throw new Error('The source changed before recording began.');
    const { element, start, end, source, rect, viewport } = prepared;
    const endMargin = Math.min(0.12, (end - start) * 0.1);
    const stop = (reason, detail) => {
      const jobId = prepared?.jobId;
      element.pause();
      clearRangeListeners();
      chrome.runtime.sendMessage({ type: reason, jobId, detail }).catch(() => {});
    };
    const onTime = () => {
      const currentRect = visibleRect(element);
      const geometryChanged = !element.isConnected
        || Math.abs(innerWidth - viewport.width) > 2
        || Math.abs(innerHeight - viewport.height) > 2
        || ['x', 'y', 'width', 'height'].some((key) => Math.abs(currentRect[key] - rect[key]) > 3);
      if (geometryChanged) stop('ANNOTATED_SOURCE_LOST', 'The player moved, resized or left the page during capture.');
      else if (element.currentSrc !== source) stop('ANNOTATED_SOURCE_LOST', 'The player source changed.');
      else if (element.playbackRate !== 1) {
        try { element.playbackRate = 1; }
        catch { stop('ANNOTATED_SOURCE_LOST', 'The player would not remain at normal speed.'); }
      }
      else if (element.currentTime >= end - endMargin) stop('ANNOTATED_RANGE_ENDED');
    };
    const onEnded = () => stop('ANNOTATED_RANGE_ENDED');
    const onLost = () => stop('ANNOTATED_SOURCE_LOST', 'The player stopped or replaced its source.');
    const onGeometry = () => onTime();
    element.addEventListener('timeupdate', onTime);
    element.addEventListener('ended', onEnded, { once: true });
    element.addEventListener('emptied', onLost, { once: true });
    element.addEventListener('error', onLost, { once: true });
    addEventListener('scroll', onGeometry, { passive: true });
    addEventListener('resize', onGeometry, { passive: true });
    const rangeTimer = setInterval(onTime, 25);
    stopListeners = () => {
      clearInterval(rangeTimer);
      element.removeEventListener('timeupdate', onTime);
      element.removeEventListener('ended', onEnded);
      element.removeEventListener('emptied', onLost);
      element.removeEventListener('error', onLost);
      removeEventListener('scroll', onGeometry);
      removeEventListener('resize', onGeometry);
    };
    await element.play();
    return { ok: true };
  }

  function cancel() {
    clearRangeListeners();
    prepared?.element?.pause();
    if (prepared?.element) {
      try { prepared.element.playbackRate = prepared.playbackRate; }
      catch { /* The page may have removed or replaced the player. */ }
    }
    prepared?.otherPlaying?.forEach((element) => {
      if (element.isConnected && element.paused) element.play().catch(() => {});
    });
    prepared = null;
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const respond = async () => {
      if (message.type === 'ANNOTATED_DISCOVER') return snapshot();
      if (message.type === 'ANNOTATED_READ_MEDIA') return readMedia(message.mediaId);
      if (message.type === 'ANNOTATED_PREPARE_CAPTURE') return prepare(message);
      if (message.type === 'ANNOTATED_PLAY_RANGE') return playRange();
      if (message.type === 'ANNOTATED_CANCEL_PAGE') return cancel();
      if (message.type === 'ANNOTATED_SEEK') {
        const element = findMedia(message.mediaId);
        if (!element) throw new Error('That player is no longer available.');
        element.currentTime = Math.max(0, Number(message.time) || 0);
        return { ok: true };
      }
      return undefined;
    };
    respond().then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
