// Presentation-only home demo. No recording, account, or publication operations.
export function markerHome({ el, session, brand }) {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const abort = new AbortController();
  const listen = (target, event, callback) => target.addEventListener(event, callback, { signal: abort.signal });
  const label = text => el('span', { class: 'home-meta' }, text);
  const hueScope = (className, hue = 1) => el('div', { class: className, dataset: { marker: hue } });
  const marks = [];
  const takes = [
    'One in eight. That’s the headline, not the average.',
    '+5°C is where grids start failing.',
    '“Modest-sounding” is doing a lot of work.'
  ];
  const hero = hueScope('home-hero');
  const phrase = (text, index) => {
    const node = el('span', { class: 'home-sweep', tabindex: '0', role: 'button', 'aria-label': `Show take on ${text}` },
      el('span', { class: 'sweep-bracket', 'aria-hidden': 'true' }, '['), text,
      el('span', { class: 'sweep-bracket', 'aria-hidden': 'true' }, ']'));
    marks.push(node);
    for (const event of ['mouseenter', 'focus']) listen(node, event, () => { hovered = index; showPhrase(index); });
    for (const event of ['mouseleave', 'blur']) listen(node, event, () => { hovered = null; });
    listen(node, 'keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); showPhrase(index); } });
    return node;
  };
  const takeText = el('span', { class: 'home-take-text' });
  const download = el('a', { class: 'button primary home-download home-desktop-cta', href: '/install' }, 'Add to Chrome');
  hero.append(
    el('div', { class: 'home-hero-copy' },
      label(session.mode === 'local' ? 'CHROME EXTENSION · LOCAL PREVIEW' : 'CHROME EXTENSION · PREVIEW'),
      el('h1', {}, 'Mark the ', el('span', { class: 'home-solid-mark' }, 'exact part.')),
      el('p', {}, 'A passage, a moment in a video, ten seconds of a podcast. Add your take. The source stays attached.'),
      el('div', { class: 'home-actions' }, download, el('a', { class: 'button primary home-phone-cta', href: '/write' }, 'Write annotation'), session.extensionAvailable
        ? el('a', { href: '#install' }, 'How to install')
        : el('a', { href: '/feed' }, 'Browse the feed ↗'))),
    el('article', { class: 'home-quote-card', 'aria-label': 'Example article annotation' },
      el('div', { class: 'home-source' }, el('span', { class: 'home-source-tile', 'aria-hidden': 'true' }, 'R'), label('REUTERS · CLIMATE MONITOR')),
      el('p', { class: 'home-excerpt' }, 'An estimated 1,050 million people — ', phrase('one in eight on Earth', 0), ' — will face highs ', phrase('+5°C above the historic norm', 1), ', while the global average sits at ', phrase('a modest-sounding 18°C', 2), '.'),
      el('div', { class: 'home-take' }, label('TAKE — J. BLACKMOUNTAIN'), takeText),
      el('small', { class: 'home-example-label' }, 'Illustrative annotation'))
  );
  let tick = 0;
  const heroHues = ['coral', 'citrus', 'mint', 'sky', 'lilac'];
  let hovered = null;
  function showPhrase(index) {
    marks.forEach((mark, i) => { mark.classList.toggle('is-marked', i === index); mark.setAttribute('aria-pressed', String(i === index)); });
    takeText.textContent = takes[index];
  }
  showPhrase(0);
  const cycle = setInterval(() => {
    if (motion.matches || document.hidden || hovered !== null) return;
    tick++;
    const hue = (Number(hero.dataset.marker) + 1) % heroHues.length;
    hero.dataset.marker = String(hue);
    brand?.style.setProperty('--mark', `var(--${heroHues[hue]})`);
    showPhrase(tick % 3);
  }, 2600);

  const section = hueScope('home-video marker-demo', 3);
  const video = (className, name) => el('video', { class: className, muted: true, playsinline: true, preload: motion.matches ? 'none' : 'metadata', poster: '/web/media/marker-poster.jpg', 'aria-label': name },
    el('source', { src: '/web/media/marker-preview.webm', type: 'video/webm' }),
    el('source', { src: '/web/media/marker-preview.mp4', type: 'video/mp4' }));
  const sourceVideo = video('home-source-video', 'Source video demonstration');
  const cutVideo = video('home-cut-video', 'Selected four-second clip');
  sourceVideo.muted = cutVideo.muted = true;
  const play = el('button', { type: 'button', class: 'home-play', 'aria-label': 'Play video demonstration' }, 'Play');
  const current = label('0:00');
  const fill = el('span', { class: 'home-range-fill' });
  const head = el('span', { class: 'home-playhead' });
  const transcriptMark = el('span', { class: 'home-sweep' }, 'Mark a moment. Keep the source attached.');
  const transcript = el('p', { class: 'home-transcript' }, 'This is original generated footage for the source-code demo. ', transcriptMark, ' Add your own take…');
  const cutProgress = el('span', {});
  const quote = el('p', { class: 'home-cut-quote' }, '[Mark a moment. Keep the source attached.]');
  const typed = el('p', { class: 'home-typed', 'aria-label': 'A useful annotation points to the exact moment, with its source still attached.' });
  const take = 'A useful annotation points to the exact moment, with its source still attached.';
  const cutSlot = el('div', { class: 'home-cut-slot' }, el('span', { class: 'home-cut-placeholder' }, 'the cut lands here'),
    el('div', { class: 'home-cut' }, cutVideo, el('div', { class: 'home-cut-progress' }, cutProgress), el('span', { class: 'home-cut-chip' }, '[ 0:03 – 0:07 ]')));
  const videoStatus = el('p', { class: 'home-media-status', role: 'status' });
  section.append(
    el('div', { class: 'home-section-heading' },
      el('h2', {}, 'Or the exact ', el('span', { class: 'home-solid-mark' }, 'moment.')),
      el('p', {}, 'Clip up to 90 seconds from a video or podcast. The cut lands in your annotation, playing.')),
    el('div', { class: 'home-video-grid' },
      el('div', { class: 'home-player-card' },
        el('div', { class: 'home-player' }, sourceVideo, label('GENERATED DEMO · VIDEO'), play),
        el('div', { class: 'home-timeline', 'aria-label': 'Playback timeline' }, el('div', { class: 'home-range' }, fill), head),
        el('div', { class: 'home-time-labels' }, current, label('[ 0:03 – 0:07 ]'), label('0:08')),
        transcript, videoStatus),
      el('article', { class: 'home-video-annotation', 'aria-label': 'Example video annotation' },
        el('div', { class: 'home-example-author' }, el('span', { class: 'home-avatar' }, 'MK'), el('strong', {}, 'Mara Kovač'), el('span', {}, 'example')),
        cutSlot, quote, el('div', { class: 'home-take' }, label('TAKE — MARA KOVAČ'), typed),
        el('div', { class: 'home-example-footer' }, label('ORIGINAL TEST FOOTAGE'), el('span', {}, 'Illustrative annotation'))))
  );

  let frame = 0, hold = null, cut = false, loop = 0, cutTime = 3, typedPlayback = 0;
  let userPaused = false, disposed = false, previewUrl = null;
  let demoEntered = false, viewportObserver = null;
  function time(seconds) { return `0:${String(Math.floor(seconds)).padStart(2, '0')}`; }
  function staticState() {
    sourceVideo.pause(); cutVideo.pause();
    section.classList.add('has-cut', 'static-demo');
    typed.textContent = take;
    transcriptMark.style.backgroundSize = '100% 78%';
    fill.style.width = '100%';
    play.textContent = 'Play';
    play.setAttribute('aria-label', 'Play video demonstration');
  }
  function startVideo(player) {
    player.play().then(() => { if (!disposed && player === sourceVideo) videoStatus.textContent = ''; }).catch(error => {
      if (disposed || player !== sourceVideo) return;
      play.textContent = 'Play';
      play.setAttribute('aria-label', 'Play video demonstration');
      if (error.name === 'NotAllowedError') videoStatus.textContent = 'Press Play to start the demo.';
    });
  }
  function resumeDemo() {
    if (!demoEntered || !previewUrl || disposed || document.hidden || motion.matches || userPaused) return;
    if (sourceVideo.ended) { if (!hold) hold = setTimeout(resetVideo, 3800); }
    else startVideo(sourceVideo);
    if (cut) startVideo(cutVideo);
  }
  function enterDemo() {
    demoEntered = true;
    viewportObserver?.disconnect();
    resumeDemo();
  }
  function resetVideo() {
    hold = null;
    if (disposed || motion.matches || userPaused) return;
    cut = false; typedPlayback = 0; cutTime = 3;
    section.classList.remove('has-cut');
    typed.textContent = '';
    cutVideo.pause();
    sourceVideo.currentTime = 0;
    section.dataset.marker = String((++loop + 3) % 5);
    resumeDemo();
  }
  function updateVideo() {
    if (disposed) return;
    const t = Math.min(8, sourceVideo.currentTime);
    current.textContent = time(t);
    head.style.left = `${t / 8 * 100}%`;
    const progress = Math.max(0, Math.min(1, (t - 3) / 4));
    if (!motion.matches) {
      fill.style.width = `${progress * 100}%`;
      transcriptMark.style.backgroundSize = `${progress * 100}% 78%`;
      if (t >= 7 && !cut) {
        cut = true; cutTime = 3; cutVideo.currentTime = 3;
        section.classList.add('has-cut');
        if (!userPaused && !document.hidden) startVideo(cutVideo);
      }
      if (cut) {
        const clipTime = cutVideo.currentTime;
        if (clipTime < 3 || clipTime >= 7) { cutVideo.currentTime = 3; cutTime = 3; }
        else if (clipTime >= cutTime) typedPlayback += clipTime - cutTime;
        if (clipTime >= 3 && clipTime < 7) cutTime = clipTime;
        cutProgress.style.width = `${Math.max(0, Math.min(1, (clipTime - 3) / 4)) * 100}%`;
        typed.textContent = take.slice(0, Math.max(0, Math.floor((typedPlayback - .7) / .032)));
      }
      if (sourceVideo.ended && !hold && !userPaused && !document.hidden) hold = setTimeout(resetVideo, 3800);
    }
    frame = requestAnimationFrame(updateVideo);
  }
  listen(sourceVideo, 'play', () => { play.textContent = 'Pause'; play.setAttribute('aria-label', 'Pause video demonstration'); });
  listen(cutVideo, 'loadedmetadata', () => { if (cut && !motion.matches) cutVideo.currentTime = 3; });
  listen(sourceVideo, 'pause', () => {
    const continues = sourceVideo.ended && !userPaused && !motion.matches;
    play.textContent = continues ? 'Pause' : 'Play';
    play.setAttribute('aria-label', `${continues ? 'Pause' : 'Play'} video demonstration`);
  });
  listen(sourceVideo, 'error', () => { videoStatus.textContent = 'The preview could not load. You can still explore the feed.'; });
  listen(play, 'click', () => {
    demoEntered = true;
    viewportObserver?.disconnect();
    if (!sourceVideo.paused || hold) {
      userPaused = true; clearTimeout(hold); hold = null; sourceVideo.pause(); cutVideo.pause();
      play.textContent = 'Play'; play.setAttribute('aria-label', 'Play video demonstration');
    } else {
      userPaused = false;
      if (sourceVideo.ended && !motion.matches) return resetVideo();
      if (sourceVideo.ended) sourceVideo.currentTime = 0;
      startVideo(sourceVideo);
      if (cut && !motion.matches) startVideo(cutVideo);
    }
  });
  listen(document, 'visibilitychange', () => {
    if (document.hidden) { sourceVideo.pause(); cutVideo.pause(); clearTimeout(hold); hold = null; }
    else resumeDemo();
  });
  listen(motion, 'change', () => {
    clearTimeout(hold); hold = null;
    hero.dataset.marker = '1';
    brand?.style.removeProperty('--mark');
    if (motion.matches) staticState();
    else { section.classList.remove('static-demo'); userPaused = false; resetVideo(); }
  });
  const install = el('section', { class: 'home-install', id: 'install' }, el('h3', {}, 'Install the preview'),
    el('ol', {},
      el('li', {}, label('01'), el('span', {}, 'Download the .zip and unpack it.')),
      el('li', {}, label('02'), el('span', {}, 'Open ', el('code', {}, 'chrome://extensions'), ' and turn on Developer mode.')),
      el('li', {}, label('03'), el('span', {}, 'Load unpacked, then pin Annotated to your toolbar.'))),
    !session.extensionAvailable ? el('p', { class: 'muted' }, 'The preview download is temporarily unavailable.') : null,
    el('div', { class: 'setup-options' }, el('a', { class: 'button secondary', href: '/install' }, 'Open installation guide'), el('a', { href: '/phone' }, 'Use on your phone ↗')),
    el('a', { class: 'home-browse', href: '/feed' }, 'Browse the public feed ↗'));
  const root = el('div', { class: 'marker-home' }, hero, section, install);
  // Wait until the route has mounted the media elements.
  queueMicrotask(async () => {
    if (disposed) return;
    if (motion.matches) staticState();
    frame = requestAnimationFrame(updateVideo);
    if (location.hash === '#install') install.scrollIntoView();
    // Preload now, then begin slightly before either demo card comes into view.
    // A one-time trigger never overrides an explicit Pause on a return scroll.
    if (typeof IntersectionObserver === 'function') {
      viewportObserver = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) enterDemo();
      }, { rootMargin: '240px 0px', threshold: 0 });
      viewportObserver.observe(section.querySelector('.home-video-grid'));
    } else enterDemo();
    // Existing static serving intentionally has no byte-range protocol. A
    // local object URL makes this tiny illustrative asset seekable without
    // changing the application media API or downloading it twice.
    try {
      const format = sourceVideo.canPlayType('video/mp4') ? 'mp4' : 'webm';
      const response = await fetch(`/web/media/marker-preview.${format}`, { signal: abort.signal });
      if (!response.ok) throw new Error('Preview unavailable');
      const blob = await response.blob();
      if (disposed) return;
      previewUrl = URL.createObjectURL(blob);
      sourceVideo.src = cutVideo.src = previewUrl;
      resumeDemo();
    } catch (error) {
      if (error.name !== 'AbortError') {
        videoStatus.textContent = 'The preview could not load. You can still explore the feed.';
        play.disabled = true;
      }
    }
  });
  return { root, dispose() { disposed = true; viewportObserver?.disconnect(); abort.abort(); clearInterval(cycle); brand?.style.removeProperty('--mark'); clearTimeout(hold); cancelAnimationFrame(frame); sourceVideo.pause(); cutVideo.pause(); if (previewUrl) URL.revokeObjectURL(previewUrl); } };
}
