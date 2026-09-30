import { APP_CONFIG, sessionStorageKey } from './config.mjs';
import { adjustVisualRange, parseTimestamp, boundedExcerpt, MAX_VOICE_RECORDING_MS, normalizeRange, oauthCallbackCode, pkceChallenge, publicationIdentity, randomPkceVerifier } from './helpers.mjs';
import { canonicalSource, formatTime, sourceKey } from './source.mjs';
import { uploadMedia } from './upload-media.mjs';
import { createDictation } from './dictation.mjs';
import { sourceIdentity, displaySourceTitle, sourceExcerpts, xShareIntent } from './source-identity.mjs';
import { validateHighlights, joinedHighlights } from './highlights.mjs';
import { markElement, markerIndex } from './marker.mjs';
import { openShareSheet } from './share-sheet.mjs';

const API = APP_CONFIG.apiOrigin;
const SESSION_KEY = sessionStorageKey();
const state = {
  token: null,
  user: null,
  authProviders: { google: false, x: false },
  signingIn: false,
  windowId: null,
  page: null,
  pageAccessBlocked: false,
  lookup: null,
  rangeMode: 'previous30',
  rangeValid: false,
  rangeInputInvalid: false,
  job: null,
  publishing: false,
  captureStarting: false,
  publishedResult: null,
  composerOpen: false,
  panelView: 'new',
  takeMode: 'write',
  draggingBoundary: null,
  draftHue: crypto.randomUUID(),
  draftIconActive: false,
  preset: 30,
  timelineWindow: null,
  customRange: null,
  pendingPublication: null,
  loggingOut: false,
  voice: { generation: 0, status: 'idle', stream: null, recorder: null, chunks: [], blob: null, previewUrl: null, duration: 0, startedAt: 0, timer: null, hardStop: null, discard: false, uploadAbort: null, mediaId: null }
};
const $ = (id) => document.getElementById(id);
let refreshSequence = 0;
let dictation = null;
let dictationStatus = 'idle';
let dictationInterim = '';
let microphoneSetupTabId = null;
let activeTabId = null;
let lookupSequence = 0;
let refreshAfterPublication = false;
let captureUpdateSequence = 0;
let validatedPreviewId = null;
let validatedPreviewUrl = null;
let previewGeneration = 0;

document.addEventListener('DOMContentLoaded', init);
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'ANNOTATED_MEDIA_POSITION') {
    updateMediaPosition(message, sender);
  } else if (message.type === 'ANNOTATED_JOB_UPDATE') {
    ++captureUpdateSequence;
    const previous = state.job;
    state.job = message.job;
    renderJob();
    if (!state.pageAccessBlocked && !$('preview-wrap').classList.contains('hidden') && state.job?.capture?.previewUrl && state.job.tabId === state.page?.tabId
      && state.job.sourceUrl === state.page?.url && (!previous?.capture?.previewUrl || (matchingReadyJob() && previous?.status !== 'ready'))) {
      $('preview-wrap').scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
    }
  } else if (message.type === 'ANNOTATED_AUTH_REQUIRED') {
    handleUnauthorizedSession();
  } else if (message.type === 'ANNOTATED_PAGE_ACCESS_GRANTED' && message.windowId === state.windowId) {
    refresh();
  }
});

async function init() {
  state.windowId = (await chrome.windows.getCurrent()).id;
  initDictation();
  bindEvents();
  renderMode();
  const saved = await chrome.storage.local.get([SESSION_KEY, ...(APP_CONFIG.mode === 'local' ? ['token', 'user'] : [])]);
  const session = saved[SESSION_KEY] || (APP_CONFIG.mode === 'local' && saved.token ? { token: saved.token, user: saved.user } : null);
  state.token = session?.token || null;
  state.user = session?.user || null;
  if (state.token) await revalidateSession();
  else if (APP_CONFIG.mode === 'production') {
    try { setAuthProviders(await api('/api/session', { authenticated: false })); }
    catch { showNotice('Sign-in could not load. Reopen the sidebar to try again.', true); }
  }
  renderSession();
  await refresh();
}

function bindEvents() {
  $('refresh').addEventListener('click', refresh);
  $('use-selection').addEventListener('click', () => refresh({ useSelection: true }));
  $('nav-page').addEventListener('click', () => setPanelView('page'));
  $('source-title-toggle').addEventListener('click', () => {
    const expanded = $('source-title-toggle').getAttribute('aria-expanded') !== 'true';
    $('source-title').classList.toggle('expanded', expanded);
    $('source-title-toggle').setAttribute('aria-expanded', String(expanded));
  });
  for (const id of ['video-preview', 'published-video']) $(id).addEventListener('loadedmetadata', () => fitVideo($(id)));
  for (const boundary of ['start', 'end']) {
    $(`${boundary}-time`).addEventListener('input', () => {
      useManualRange();
      try { const value = parseTimestamp($(`${boundary}-time`).value); updateRangeFromVisual(boundary, value); }
      catch (error) { state.rangeInputInvalid = true; state.rangeValid = false; $('range-summary').textContent = error.message; $('range-summary').classList.add('error'); renderRecordAvailability(); }
    });
  }
  $('enable-microphone').addEventListener('click', openMicrophoneSetup);
  $('dictate').addEventListener('click', toggleDictation);
  $('compose-toggle').addEventListener('click', () => setPanelView('new'));
  document.querySelectorAll('[data-persona]').forEach((button) => button.addEventListener('click', () => login(button.dataset.persona)));
  $('google-login').addEventListener('click', () => loginOAuth('google'));
  $('x-login').addEventListener('click', () => loginOAuth('x'));
  $('logout').addEventListener('click', logout);
  $('mode-previous').addEventListener('click', () => setRangeMode('previous30'));
  $('mode-manual').addEventListener('click', () => setRangeMode('manual'));
  $('media-select').addEventListener('change', () => { state.timelineWindow = null; updateSelectedMediaKind(); updateRange(); rememberCustomRange(); });
  $('range-start').addEventListener('input', updateRange);
  $('range-end').addEventListener('input', updateRange);
  $('range-start-visual').addEventListener('input', () => updateRangeFromVisual('start'));
  $('range-end-visual').addEventListener('input', () => updateRangeFromVisual('end'));
  for (const seconds of [15, 30, 60]) $(`preset-${seconds}`).addEventListener('click', () => selectPreset(seconds).catch(error => showNotice(error.message, true)));
  bindTimeline();
  $('set-start').addEventListener('click', () => choosePlayhead('start'));
  $('set-end').addEventListener('click', () => choosePlayhead('end'));
  $('range-here').addEventListener('click', () => choosePlayhead('window'));
  for (const boundary of ['start', 'end']) {
    $(boundary === 'start' ? 'range-start' : 'range-end').addEventListener('change', () => {
      const value = Number($(boundary === 'start' ? 'range-start' : 'range-end').value);
      if (Number.isFinite(value)) updateRangeFromVisual(boundary, value);
    });
    $(`nudge-${boundary}-back`).addEventListener('click', () => updateRangeFromVisual(boundary, Number($(`range-${boundary}`).value) - 1));
    $(`nudge-${boundary}-forward`).addEventListener('click', () => updateRangeFromVisual(boundary, Number($(`range-${boundary}`).value) + 1));
  }
  $('record').addEventListener('click', record);
  $('cancel').addEventListener('click', cancelCapture);
  $('rerecord').addEventListener('click', () => { rerecord(); });
  $('commentary').addEventListener('input', () => {
    state.draftIconActive = true;
    renderPublishAvailability();
    renderComposerVisibility();
  });
  $('take-write').addEventListener('click', () => setTakeMode('write'));
  $('take-dictate').addEventListener('click', () => setTakeMode('dictate'));
  $('share-image').addEventListener('click', () => openShareSheet({ annotation: state.publishedResult, apiOrigin: API }));
  $('voice-record').addEventListener('click', startVoice);
  $('voice-stop').addEventListener('click', () => stopVoice(false));
  $('voice-cancel').addEventListener('click', () => stopVoice(true));
  $('voice-delete').addEventListener('click', deleteVoice);
  const voicePlayer = $('voice-preview-audio');
  $('voice-play').addEventListener('click', () => {
    if (!voicePlayer.paused) voicePlayer.pause();
    else voicePlayer.play().catch(() => showNotice('The voice take could not play. Try the playback controls below.', true));
  });
  $('voice-seek').addEventListener('input', () => { voicePlayer.currentTime = Number($('voice-seek').value); });
  for (const event of ['play', 'pause', 'ended', 'timeupdate', 'loadedmetadata']) voicePlayer.addEventListener(event, renderVoicePlayback);
  $('publish').addEventListener('click', publish);
  $('copy-link').addEventListener('click', copyPublishedLink);
  $('new-annotation').addEventListener('click', startNewAnnotation);
  $('discard-paused-draft').addEventListener('click', discardPausedDraft);
  addEventListener('pagehide', () => { dictation?.abort(); disposeVoice(); });
  bindSourceEvents();
}

function bindSourceEvents() {
  chrome.tabs.onActivated?.addListener(({ tabId, windowId }) => {
    if (windowId !== state.windowId) return;
    activeTabId = tabId;
    stopSourceInput();
    refresh();
  });
  chrome.tabs.onUpdated?.addListener((tabId, change, tab) => {
    if (tabId !== (activeTabId ?? state.page?.tabId) && !(tab?.active && tab.windowId === state.windowId)) return;
    activeTabId = tabId;
    if (typeof change.title === 'string' && change.title.trim() && sourceIdentity({ url: tab?.url }).publisher === 'YouTube') {
      // YouTube may update the title after the URL/player. Refresh an in-flight
      // discovery, but do not reset an established cut, take or recording.
      if (state.pageAccessBlocked && !change.status && !change.url) {
        refresh();
        return;
      }
      if (!state.pageAccessBlocked && state.page?.tabId === tabId && state.page.url === tab.url) {
        state.page.title = change.title.trim().slice(0, 300);
        renderSourceTitle();
      }
    }
    if (change.status === 'loading') {
      stopSourceInput();
      invalidateSource();
      showNotice('The page is changing. Updating this source…');
      if (state.publishing) refreshAfterPublication = true;
    } else if (change.status === 'complete' || change.url) {
      stopSourceInput();
      refresh();
    }
  });
  chrome.tabs.onRemoved?.addListener((tabId) => {
    if (tabId !== (activeTabId ?? state.page?.tabId)) return;
    activeTabId = null;
    stopSourceInput();
    refresh();
  });
}

function stopSourceInput() {
  dictation?.abort();
  if (['requesting', 'recording', 'stopping'].includes(state.voice.status)) deleteVoice();
}

function invalidateSource() {
  ++refreshSequence;
  ++lookupSequence;
  state.pageAccessBlocked = true;
  state.lookup = null;
  $('nav-page').textContent = 'On this page · 0';
  $('source-workspace').classList.add('hidden');
  $('discussion').classList.add('hidden');
  renderPausedDraft();
  renderPublishAvailability();
  renderRecordAvailability();
}

function hasUnfinishedDraft() {
  return hasTakeDraft() || Boolean(!state.publishedResult && state.job && ['preparing', 'recording', 'uploading', 'ready'].includes(state.job.status))
    || Boolean(!state.publishedResult && state.page?.kind === 'article' && state.page.excerpt);
}

function renderPausedDraft() {
  const paused = state.pageAccessBlocked && !state.publishing && state.page && hasUnfinishedDraft();
  $('paused-draft').classList.toggle('hidden', !paused);
  $('paused-draft-source').textContent = paused ? `For: ${state.page.title || state.page.url}` : '';
  $('discard-paused-draft').disabled = state.publishing;
  $('source-card').classList.toggle('source-paused', Boolean(state.pageAccessBlocked));
}

async function discardPausedDraft() {
  if (state.publishing) return;
  $('discard-paused-draft').disabled = true;
  const error = await clearAccountDraft();
  if (error) return showNotice(`The draft could not be fully cleared: ${error.message}`, true);
  state.page = null;
  await refresh();
}

function initDictation() {
  dictation = createDictation({
    Recognition: globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition,
    textarea: $('commentary'),
    lang: () => $('dictation-language').value || 'en-US',
    onState: ({ status, interim }) => {
      dictationStatus = status;
      dictationInterim = interim;
      renderVoice();
      renderRecordAvailability();
    },
    onError: ({ message }) => showNotice(message, true),
    onPermissionNeeded: ({ code, message }) => {
      $('microphone-help').classList.toggle('hidden', code !== 'not-allowed');
      showNotice(message, true);
    }
  });
  renderDictation();
}

async function toggleDictation() {
  if (dictation?.active) return dictation.stop();
  clearNotice();
  if (!dictation?.supported) return showNotice('Dictation is unavailable in this browser. You can type your take or use your computer’s keyboard dictation.', true);
  if (!state.token || state.pageAccessBlocked || state.publishing || state.publishedResult) return;
  if (state.voice.status !== 'idle' && state.voice.status !== 'ready') return;
  if (state.job && ['preparing', 'recording', 'uploading'].includes(state.job.status)) return;
  // A permission query is not a failed request. Try this explicit click here
  // before offering a separate permission tab as recovery.
  $('microphone-help').classList.add('hidden');
  $('dictation-privacy').classList.remove('hidden');
  dictation.start();
}

function renderDictation() {
  const active = Boolean(dictation?.active);
  const captureActive = state.job && ['preparing', 'recording', 'uploading'].includes(state.job.status);
  const voiceActive = ['requesting', 'recording', 'stopping', 'uploading'].includes(state.voice.status);
  $('dictate').disabled = !dictation?.supported || (!active && (!state.token || state.pageAccessBlocked || state.publishing || Boolean(state.publishedResult) || Boolean(captureActive) || voiceActive));
  $('dictate').setAttribute('aria-pressed', String(active));
  const label = active ? 'Stop dictation' : 'Dictate your take';
  $('dictate').setAttribute('aria-label', label);
  $('dictate').title = label;
  $('dictation-language').disabled = active;
  $('dictation-privacy').classList.toggle('hidden', !active);
  $('compose-fields').classList.toggle('listening', active);
  state.takeMode = active ? 'dictate' : 'write';
  $('take-write').disabled = voiceActive;
  $('take-write').setAttribute('aria-pressed', String(!active));
  $('take-dictate').disabled = $('dictate').disabled;
  $('take-dictate').setAttribute('aria-pressed', String(active));
  $('take-dictate').textContent = active ? 'Stop' : 'Dictate';
  $('take-dictate').title = active ? 'Stop dictation' : 'Turn speech into text';
  $('take-dictate').setAttribute('aria-label', active ? 'Stop dictation' : 'Dictate your take');
  $('dictation-status').textContent = !dictation?.supported ? 'Dictation unavailable here'
    : dictationInterim || (dictationStatus === 'starting' ? 'Starting microphone…'
      : dictationStatus === 'listening' ? 'Listening…' : dictationStatus === 'stopping' ? 'Finishing…' : '');
}

function renderMode() {
  const local = APP_CONFIG.mode === 'local';
  $('local-login').classList.toggle('hidden', !local);
  $('google-login').classList.toggle('hidden', local);
  $('x-login').classList.toggle('hidden', local);
  renderAuthProviders();
  $('session-eyebrow').textContent = local ? 'LOCAL DEMO ACCESS' : 'ANNOTATED ACCOUNT';
  $('session-title').textContent = local ? 'Choose a test identity' : 'Sign in to Annotated';
  $('session-copy').textContent = local
    ? 'This local build uses sample accounts. It does not claim production sign-in.'
    : 'Sign in to publish. Use the same option each time to return to your annotations.';
  document.title = local ? 'Annotated — local demo' : 'Annotated';
}

async function refresh({ useSelection = false, replaceIndex = null } = {}) {
  if (state.publishing) {
    refreshAfterPublication = true;
    invalidateSource();
    showNotice('Finishing publication on the original source. The sidebar will then update to your current page.');
    return;
  }
  dictation?.abort();
  invalidateSource();
  const sequence = refreshSequence;
  clearNotice();
  try {
    const jobSequence = captureUpdateSequence;
    const response = await sendRuntime({ type: 'ANNOTATED_PANEL_BOOTSTRAP' });
    if (sequence !== refreshSequence) return;
    activeTabId = response.page.tabId;
    const sourceChanged = state.page && (state.page.tabId !== response.page.tabId || state.page.url !== response.page.url);
    if (sourceChanged && hasUnfinishedDraft()) {
      renderPausedDraft();
      showNotice('Your draft still belongs to its original source. Return to that tab, or discard the draft to start on this page.');
      return;
    }
    if (sourceChanged) {
      void updateActionIcon(state.page.tabId, 'citrus');
      state.publishedResult = null;
      state.pendingPublication = null;
      state.job = null;
      clearPreview();
      state.rangeMode = 'previous30';
      state.rangeValid = false;
      state.rangeInputInvalid = false;
      state.preset = 30;
      state.timelineWindow = null;
      state.customRange = null;
      state.draftHue = nextDraftHue(state.draftHue);
      state.draftIconActive = false;
      globalThis.scrollTo?.({ top: 0 });
    }
    const excerpt = boundedExcerpt(response.page.excerpt);
    let excerpts = !sourceChanged && state.page?.kind === 'article' ? sourceExcerpts(state.page) : (excerpt ? [excerpt] : []);
    let selectionError = '';
    if (useSelection && excerpt) {
      try {
        const next = [...excerpts];
        if (replaceIndex !== null && next[replaceIndex] !== undefined) next[replaceIndex] = excerpt;
        else next.push(excerpt);
        excerpts = validateHighlights(next);
      } catch (error) { selectionError = error.message; }
    }
    state.page = {
      ...response.page,
      ...(!sourceChanged && state.page?.kind === 'article' ? { kind: 'article' } : {}),
      excerpts,
      excerpt: joinedHighlights(excerpts)
    };
    state.pageAccessBlocked = false;
    $('source-workspace').classList.remove('hidden');
    renderPausedDraft();
    if (jobSequence === captureUpdateSequence) state.job = response.job;
    if (state.job?.draftHue && state.job.tabId === state.page.tabId && state.job.sourceUrl === state.page.url) {
      state.draftHue = state.job.draftHue;
    }
    renderPage();
    renderJob();
    if (useSelection && !excerpt) {
      $('selection-status').textContent = `No new highlight found. Select article text first, then attach it here.${state.page.excerpt ? ' Your attached passage stays unchanged.' : ''}`;
    }
    if (selectionError) $('selection-status').textContent = selectionError;
    await lookupSource();
  } catch (error) {
    if (sequence !== refreshSequence) return;
    renderPausedDraft();
    showNotice(error.message, true);
  }
}

async function login(persona) {
  clearNotice();
  try {
    const body = await api('/api/dev/session', { method: 'POST', body: { persona }, authenticated: false });
    await acceptSession(body);
    renderSession();
    await refresh();
  } catch (error) {
    showNotice(error.message, true);
  }
}

function setAuthProviders(body) {
  state.authProviders = body.authProviders || { google: Boolean(body.oauthConfigured), x: false };
  renderAuthProviders();
}

function renderAuthProviders() {
  for (const provider of ['google', 'x']) $(provider + '-login').disabled = state.signingIn || !state.authProviders[provider];
  $('x-login-status').classList.toggle('hidden', APP_CONFIG.mode !== 'production' || Boolean(state.authProviders.x));
}

async function loginOAuth(provider) {
  clearNotice();
  if (APP_CONFIG.mode !== 'production' || !['google', 'x'].includes(provider) || !state.authProviders[provider] || state.signingIn) return;
  state.signingIn = true;
  renderAuthProviders();
  try {
    const codeVerifier = randomPkceVerifier();
    const codeChallenge = await pkceChallenge(codeVerifier);
    const extensionId = chrome.runtime.id;
    const redirectUrl = chrome.identity.getRedirectURL('annotated');
    const start = new URL(`/auth/${provider}/start`, API);
    start.searchParams.set('extensionId', extensionId);
    start.searchParams.set('codeChallenge', codeChallenge);
    const callbackUrl = await chrome.identity.launchWebAuthFlow({ url: start.href, interactive: true });
    const code = oauthCallbackCode(callbackUrl, redirectUrl);
    const body = await api('/api/auth/extension/exchange', {
      method: 'POST',
      body: { code, codeVerifier },
      authenticated: false
    });
    if (!body.token || !body.user) throw new Error('The sign-in exchange returned an invalid session.');
    await acceptSession(body);
    renderSession();
    await refresh();
  } catch (error) {
    showNotice(error.message || 'Sign-in could not be completed.', true);
  } finally {
    state.signingIn = false;
    renderAuthProviders();
  }
}

async function revalidateSession() {
  try {
    const body = await api('/api/session');
    setAuthProviders(body);
    if (!body.user) {
      await handleUnauthorizedSession();
      return;
    }
    state.user = body.user;
    await saveSession();
  } catch {
    await clearSession();
  }
}

async function acceptSession(body) {
  if (!body?.token || !body.user) throw new Error('The sign-in response did not include a valid session.');
  if (state.user?.id && state.user.id !== body.user.id) {
    const cleanupError = await clearAccountDraft({ hydrateCapture: true });
    if (cleanupError) throw new Error(`The previous account draft could not be cleared: ${cleanupError.message}`);
  }
  state.token = body.token;
  state.user = body.user;
  await saveSession();
}

async function logout() {
  clearNotice();
  if (state.publishing) return showNotice('Wait for publishing to finish before logging out.', true);
  state.loggingOut = true;
  let cleanupError = await clearAccountDraft({ hydrateCapture: true });
  try {
    if (state.token) await api('/api/logout', { method: 'POST' });
  } catch (error) {
    cleanupError ||= error;
  } finally {
    await clearSession();
    state.loggingOut = false;
    renderSession();
    showNotice(cleanupError ? `Logged out, but draft cleanup reported: ${cleanupError.message}` : 'Logged out.', Boolean(cleanupError));
  }
}

async function handleUnauthorizedSession() {
  const cleanupError = await clearAccountDraft({ hydrateCapture: true });
  await clearSession();
  renderSession();
  if (!state.loggingOut) showNotice(cleanupError
    ? `Your session ended. Draft cleanup reported: ${cleanupError.message}`
    : 'Your session ended. Sign in again to continue.', true);
}

async function clearAccountDraft({ hydrateCapture = false } = {}) {
  dictation?.abort();
  $('commentary').value = '';
  state.pendingPublication = null;
  state.publishedResult = null;
  deleteVoice();
  let cleanupError = null;
  try {
    if (hydrateCapture && !state.job) {
      const bootstrap = await sendRuntime({ type: 'ANNOTATED_PANEL_BOOTSTRAP' });
      state.job = bootstrap.job;
    }
    const job = state.job;
    if (job && ['preparing', 'recording', 'uploading'].includes(job.status)) {
      await sendRuntime({ type: 'ANNOTATED_CANCEL_CAPTURE' });
    } else if (job?.status === 'ready') {
      await discardCaptureJob(job.id);
    }
  } catch (error) {
    cleanupError = error;
  } finally {
    state.job = null;
    clearPreview();
    state.draftIconActive = false;
    syncLogo();
  }
  return cleanupError;
}

async function saveSession() {
  await chrome.storage.local.set({ [SESSION_KEY]: { token: state.token, user: state.user } });
  if (APP_CONFIG.mode === 'local') await chrome.storage.local.remove(['token', 'user']);
}

async function clearSession() {
  state.token = null;
  state.user = null;
  await chrome.storage.local.remove(APP_CONFIG.mode === 'local' ? [SESSION_KEY, 'token', 'user'] : SESSION_KEY);
}

function renderSession() {
  renderPausedDraft();
  $('session-card').classList.toggle('hidden', Boolean(state.token && state.user));
  $('signed-in').textContent = state.user ? `${state.user.name}${APP_CONFIG.mode === 'local' ? ' · local demo' : ''}` : 'Sign in to publish';
  $('panel-user').textContent = state.user?.name || 'Welcome to Annotated';
  $('account-handle').textContent = state.user?.handle ? `@${state.user.handle.replace(/^@/, '')}` : APP_CONFIG.mode === 'local' ? 'LOCAL DEMO' : '';
  $('logout').classList.toggle('hidden', !state.token);
  $('nav-feed').href = `${API}/feed`;
  $('nav-mine').classList.toggle('hidden', !state.user?.id);
  if (state.user?.id) $('nav-mine').href = `${API}/u/${encodeURIComponent(state.user.id)}`;
  $('take-label').textContent = 'YOUR TAKE';
  $('account-avatar').textContent = (state.user?.name || 'Annotated').replace(/\s*\([^)]*\)\s*$/, '').split(/\s+/).slice(0, 2).map(part => part[0]).join('');
  markElement($('account-avatar'), state.user?.id || 'guest');
  renderPublishAvailability();
  renderJob();
  renderVoice();
}

function renderSourceTitle() {
  const title = displaySourceTitle(state.page);
  $('source-title').textContent = title;
  $('source-title').title = title;
  $('source-title').classList.remove('expanded');
  $('source-title-toggle').setAttribute('aria-expanded', 'false');
}

function renderPage() {
  const page = state.page;
  state.draftIconActive ||= !state.publishedResult && hasUnfinishedDraft();
  $('source-card').classList.remove('hidden');
  $('compose').classList.remove('hidden');
  const identity = sourceIdentity(page);
  $('source-kind').textContent = `${identity.publisher} · ${identity.platform === 'x' ? 'POST' : page.kind.toUpperCase()}`;
  $('source-badge').textContent = identity.platform === 'youtube' ? '' : identity.badge;
  $('source-badge').dataset.platform = identity.platform;
  renderSourceTitle();
  $('source-author').textContent = [identity.author, identity.handle].filter(Boolean).join(' · ');
  $('take-label').textContent = 'YOUR TAKE';
  markElement($('compose'), state.draftHue);
  const isArticle = page.kind === 'article';
  $('article-controls').classList.toggle('hidden', !isArticle);
  $('media-source').classList.toggle('hidden', isArticle);
  $('media-controls').classList.toggle('hidden', isArticle);
  renderHighlights();
  $('support-note').textContent = isArticle
    ? ''
    : page.media.length ? ''
      : page.unsupportedEmbed ? 'This embedded player cannot be controlled safely. Open its original source and try there.' : 'No controllable native media player was found on this page.';
  if (!isArticle) renderMedia();
  state.composerOpen = true;
  renderComposerVisibility();
}

function quoteNode(text) {
  const quote = document.createElement('blockquote');
  quote.className = 'excerpt';
  const mark = document.createElement('mark');
  mark.textContent = text;
  quote.replaceChildren(mark);
  return quote;
}

function renderHighlights() {
  const excerpts = sourceExcerpts(state.page);
  $('excerpt').replaceChildren(...excerpts.map((text, index) => {
    const item = document.createElement('div');
    item.className = 'highlight-item';
    const actions = document.createElement('div');
    actions.className = 'highlight-actions';
    for (const action of ['Remove']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-button';
      button.textContent = '×';
      button.classList.add('remove-highlight');
      button.setAttribute('aria-label', `${action} highlight ${index + 1}`);
      button.addEventListener('click', () => {
        if (state.publishing || state.publishedResult || state.pageAccessBlocked) return;
        state.page.excerpts = excerpts.filter((_, i) => i !== index);
        state.page.excerpt = joinedHighlights(state.page.excerpts);
        renderHighlights();
        renderPublishAvailability();
      });
      actions.append(button);
    }
    item.append(quoteNode(text), actions);
    return item;
  }));
  $('excerpt').classList.toggle('hidden', !excerpts.length);
  $('selection-hint').classList.toggle('hidden', Boolean(excerpts.length));
  $('selection-zone').classList.toggle('has-selections', Boolean(excerpts.length));
  $('use-selection').textContent = excerpts.length ? '+ Add another selection' : 'Add selection';
  const words = excerpts.reduce((count, text) => count + text.split(/\s+/).length, 0);
  $('highlight-count').textContent = `${excerpts.length}/5 · ${words}/100 WORDS`;
  $('selection-status').textContent = '';
}

function setPanelView(view) {
  state.panelView = view;
  renderFooter();
  $('source-workspace').dataset.view = view;
  for (const [id, active] of [['compose-toggle', view === 'new'], ['nav-page', view === 'page']]) {
    if (active) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
}

function renderFooter() {
  $('compose-footer').classList.toggle('hidden', !state.page || state.panelView !== 'new' || state.pageAccessBlocked);
}

function setTakeMode(mode) {
  if (mode === 'dictate') return toggleDictation();
  if (dictation?.active) dictation.stop();
  $('commentary').focus?.({ preventScroll: true });
}

// Presentation adapters select the existing manual mode without resetting the
// current cut. The original controller still validates every endpoint.
function useManualRange() {
  try {
    const range = currentRange();
    $('range-start').value = String(range.start);
    $('range-end').value = String(range.end);
  } catch { /* A typed chip can repair an invalid range. */ }
  state.rangeMode = 'manual';
  state.preset = null;
  state.timelineWindow = null;
}

async function choosePlayhead(boundary) {
  useManualRange();
  const selected = await setRangeToPlayhead(boundary);
  if (selected && boundary === 'window') state.preset = 'next30';
  renderTimeline();
}

function nextDraftHue(previous) {
  let next;
  do { next = crypto.randomUUID(); } while (markerIndex(next) === markerIndex(previous));
  return next;
}

function fitVideo(player) {
  if (player.videoWidth && player.videoHeight) {
    player.style.width = `${Math.round(Math.min(240, player.videoHeight) * player.videoWidth / player.videoHeight)}px`;
  }
}

function toggleComposer() {
  const captureActive = state.job && ['preparing', 'recording', 'uploading'].includes(state.job.status);
  const voiceActive = ['requesting', 'recording', 'stopping', 'uploading'].includes(state.voice.status);
  if (state.composerOpen && (captureActive || voiceActive)) return showNotice('Finish or cancel the active recording before closing the composer.', true);
  state.composerOpen = !state.composerOpen;
  renderComposerVisibility(false);
}

function renderComposerVisibility(autoOpen = true) {
  if (!state.page) return;
  const jobDraft = state.job && state.job.tabId === state.page.tabId && state.job.sourceUrl === state.page.url
    && ['preparing', 'recording', 'uploading', 'ready'].includes(state.job.status);
  const voiceDraft = state.voice.status !== 'idle' || state.voice.blob || state.voice.mediaId;
  const writtenDraft = Boolean($('commentary').value.trim());
  if (autoOpen || state.page.excerpt || jobDraft || voiceDraft || writtenDraft) state.composerOpen = true;
  $('compose').classList.toggle('collapsed', !state.composerOpen);
  $('compose-toggle').textContent = 'New';
  $('compose-toggle').setAttribute('aria-expanded', String(state.composerOpen));
  setPanelView(state.panelView);
  renderComposerStage();
}

function matchingReadyJob() {
  return Boolean(state.job?.status === 'ready' && state.job.capture?.id && state.page
    && state.job.tabId === state.page.tabId && state.job.sourceUrl === state.page.url);
}

function hasTakeDraft() {
  return Boolean(dictation?.active || $('commentary').value.trim() || state.voice.blob || state.voice.mediaId || state.voice.status !== 'idle');
}

function renderComposerStage() {
  syncLogo();
  if (!state.page) return;
  const compose = $('compose');
  const isArticle = state.page.kind === 'article';
  const active = state.captureStarting || Boolean(state.job && ['preparing', 'recording'].includes(state.job.status));
  const saving = !isArticle && state.job?.status === 'uploading';
  const ready = !isArticle && matchingReadyJob();
  const captured = ready || saving;
  const stage = state.publishedResult ? 'published' : state.publishing ? 'publishing' : saving ? 'saving' : active ? 'recording'
    : (isArticle || ready || hasTakeDraft()) ? 'compose' : 'idle';
  compose.dataset.stage = stage;
  $('publishing-status').classList.toggle('hidden', stage !== 'publishing');
  $('published-status').classList.toggle('hidden', stage !== 'published');
  $('composer-content').classList.toggle('hidden', stage === 'publishing' || stage === 'published');
  $('progress').classList.toggle('hidden', stage !== 'recording');
  $('media-setup').classList.toggle('hidden', isArticle || stage === 'recording' || captured);
  $('captured-chip').classList.toggle('hidden', !captured || stage === 'recording');
  // The worker owns upload/validation; Retake uses its existing ready-only discard.
  $('rerecord').disabled = !ready;
  $('rerecord').title = saving ? 'Available when the clip finishes saving' : '';
  $('clip-timeline').classList.toggle('hidden', captured);
  $('time-chips').classList.toggle('hidden', captured || stage === 'recording');
  $('selected-source-label').classList.toggle('hidden', stage === 'recording');
  $('progress-copy').classList.toggle('hidden', stage !== 'recording');
  renderFooter();
  if (stage === 'published') renderPublishedResult();
  renderPublishAvailability();
}

function syncLogo() {
  const recording = state.voice.status === 'recording' || (state.job?.status === 'recording'
    && state.job.tabId === state.page?.tabId && state.job.sourceUrl === state.page?.url);
  const hue = !state.publishedResult && state.draftIconActive ? markerIndex(state.draftHue) : 1;
  const logo = $('panel-logo');
  if (logo) {
    logo.dataset.marker = String(hue);
    logo.classList.toggle('is-recording', Boolean(recording));
  }
  void updateActionIcon(state.page?.tabId, recording ? 'recording' : hue);
}

async function updateActionIcon(tabId, hue) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  // The worker owns both draft and capture icons, including while this panel is closed.
  try { await sendRuntime({ type: 'ANNOTATED_SET_DRAFT_ICON', tabId, hue }); }
  catch { /* Icon presentation must never interrupt a draft or a recorder. */ }
}

function renderPublishAvailability() {
  if (!$('publish')) return;
  renderDictation();
  renderFooter();
  const sourceActive = state.captureStarting || Boolean(state.job && ['preparing', 'recording', 'uploading'].includes(state.job.status));
  const voiceActive = Boolean(dictation?.active) || ['requesting', 'recording', 'stopping', 'uploading'].includes(state.voice.status);
  const hasContent = Boolean($('commentary').value.trim() || state.voice.blob || state.voice.mediaId);
  const sourceReady = state.page?.kind === 'article' ? Boolean(boundedExcerpt(state.page.excerpt)) : matchingReadyJob();
  $('publish').disabled = state.pageAccessBlocked || !state.token || state.publishing || Boolean(state.publishedResult) || sourceActive || voiceActive || !hasContent || !sourceReady;
  $('use-selection').disabled = state.publishing || Boolean(state.publishedResult) || sourceActive || voiceActive;
  for (const button of $('excerpt').querySelectorAll?.('button') || []) button.disabled = $('use-selection').disabled;
  $('publish').textContent = state.publishing ? 'Publishing…' : state.publishedResult ? 'Published ✓'
    : 'Publish';
  $('publish').classList.toggle('is-published', Boolean(state.publishedResult));
  $('publish-hint').textContent = state.publishedResult ? 'Live on the feed'
    : state.publishing ? 'Publishing your annotation…'
      : !state.token ? 'Sign in to publish'
        : state.pageAccessBlocked ? 'Reconnect your source with the Annotated A toolbar icon.'
          : state.job?.status === 'uploading' ? 'Saving your clip…'
            : dictation?.active ? 'Finish dictation and review your take'
            : sourceActive || voiceActive ? 'Finish your recording first'
            : !sourceReady ? (state.page?.kind === 'article' ? 'Mark a passage first' : 'Capture a clip first')
              : !hasContent ? 'Write or dictate your take' : 'Ready';
  $('logout').disabled = state.publishing;
}

function renderMedia() {
  const select = $('media-select');
  const previous = select.value;
  select.replaceChildren(...state.page.media.map((media, index) => new Option(`${media.kind === 'video' ? 'Video' : 'Audio'} ${index + 1} · ${formatTime(media.duration || 0)}`, media.id)));
  $('player-choice').classList.toggle('hidden', state.page.media.length <= 1);
  if (state.page.media.some((item) => item.id === previous)) select.value = previous;
  updateSelectedMediaKind();
  syncRangeBounds();
  updateRange();
  if (state.rangeValid && !['start-time', 'end-time'].some(timeFieldFocused)) {
    state.rangeInputInvalid = false;
  }
}

function selectedMedia() {
  return state.page?.media.find((item) => item.id === $('media-select').value) || state.page?.media[0];
}

function updateSelectedMediaKind() {
  const media = selectedMedia();
  if (!media || state.page?.kind === 'article') return;
  state.page.kind = media.kind;
  $('source-kind').textContent = `${sourceIdentity(state.page).publisher} · ${media.kind.toUpperCase()} · ${formatTime(media.duration || 0)}`;
}

function setRangeMode(mode) {
  state.rangeInputInvalid = false;
  state.rangeMode = mode;
  state.preset = mode === 'previous30' ? 30 : null;
  state.timelineWindow = null;
  $('mode-previous').classList.toggle('active', mode === 'previous30');
  $('mode-manual').classList.toggle('active', mode === 'manual');
  $('manual-range').classList.toggle('hidden', mode !== 'manual');
  const media = selectedMedia();
  if (mode === 'manual' && media) {
    const duration = finiteMediaDuration(media);
    const start = duration ? Math.min(Math.max(0, duration - 0.1), media.currentTime) : media.currentTime;
    const end = duration ? Math.min(duration, start + 30) : start + 30;
    $('range-start').value = start.toFixed(1);
    $('range-end').value = end.toFixed(1);
    syncRangeBounds();
  }
  syncRangeBounds();
  updateRange();
  if (mode === 'manual') rememberCustomRange();
}

function currentRange() {
  const media = selectedMedia();
  if (!media) throw new Error('Choose a media player first.');
  if (state.rangeMode === 'manual' && !finiteMediaDuration(media)) throw new Error('Wait for the player duration, then refresh.');
  return normalizeRange({
    mode: state.rangeMode,
    start: $('range-start').value,
    end: $('range-end').value,
    currentTime: media.currentTime,
    duration: media.duration ?? Infinity
  });
}

function updateRange() {
  if (state.rangeMode === 'manual') syncVisualRangeFromPrecise();
  try {
    const range = currentRange();
    state.rangeValid = true;
    $('range-summary').textContent = `${formatTime(range.start)}–${formatTime(range.end)} · ${formatTime(range.duration)}`;
    $('range-summary').classList.remove('error');
    $('range-start-label').textContent = formatTime(range.start);
    $('range-end-label').textContent = formatTime(range.end);
  } catch (error) {
    state.rangeValid = false;
    $('range-summary').textContent = error.message;
    $('range-summary').classList.add('error');
  }
  renderRecordAvailability();
  renderTimeline();
}

// Presets adapt the existing previous30/manual modes; the recorder and its
// validation remain unchanged. Refresh the source clock before choosing a cut.
async function selectPreset(seconds) {
  const media = selectedMedia();
  if (!media) throw new Error('Choose a media player first.');
  const response = await sendRuntime({ type: 'ANNOTATED_PANEL_BOOTSTRAP' });
  if (response.page?.tabId !== state.page?.tabId || response.page?.url !== state.page?.url) throw new Error('Return to this source tab to choose a clip.');
  const fresh = response.page.media?.find(item => item.id === media.id);
  if (!fresh) throw new Error('That player is no longer available.');
  media.currentTime = fresh.currentTime;
  media.liveTime = fresh.currentTime;
  media.duration = fresh.duration;
  state.rangeMode = seconds === 30 ? 'previous30' : 'manual';
  state.preset = seconds;
  state.rangeInputInvalid = false;
  state.customRange = null;
  state.timelineWindow = null;
  $('range-start').value = String(Math.max(0, media.currentTime - seconds));
  $('range-end').value = String(media.currentTime);
  $('manual-range').classList.toggle('hidden', state.rangeMode !== 'manual');
  updateRange();
}

function timeFieldFocused(id) {
  return document.hasFocus?.() !== false && document.activeElement === $(id);
}

function rememberCustomRange() {
  if (!state.rangeValid || state.preset !== null) return;
  const range = currentRange();
  const media = selectedMedia();
  state.customRange = { offset: range.start - (media.liveTime ?? media.currentTime), duration: range.duration };
}

function updateMediaPosition(message, sender) {
  const media = selectedMedia();
  if (!media || state.page?.kind === 'article' || state.pageAccessBlocked
    || sender?.tab?.id !== state.page.tabId || sender.frameId !== 0
    || message.url !== state.page.url || message.mediaId !== media.id
    || !['timeupdate', 'seeked', 'durationchange'].includes(message.event)
    || !Number.isFinite(message.currentTime) || message.currentTime < 0) return;
  // sender.url can stay at the injection URL after pushState. The content
  // script supplies current location.href; tab/frame/player still bind it.
  // Keep the latest source clock even while the edit presentation is frozen.
  media.liveTime = message.currentTime;
  // Capture owns its interval once started. Editing also owns its visible axis.
  if (state.captureStarting || state.publishing || state.publishedResult
    || (state.job && (['preparing', 'recording', 'uploading'].includes(state.job.status)
      || (state.job.status === 'ready' && state.job.tabId === state.page.tabId && state.job.sourceUrl === state.page.url)))
    || state.draggingBoundary || state.rangeInputInvalid
    || ['start-time', 'end-time'].some(timeFieldFocused)) return;

  let priorRange;
  try { priorRange = currentRange(); } catch { /* Keep invalid manual edits available for repair. */ }
  const custom = state.customRange || (priorRange && { offset: priorRange.start - media.currentTime, duration: priorRange.duration });
  media.currentTime = message.currentTime;
  const previousDuration = media.duration;
  media.duration = Number.isFinite(message.duration) && message.duration > 0 ? message.duration : null;
  if (media.duration !== previousDuration) {
    state.timelineWindow = null;
    syncRangeBounds();
    updateSelectedMediaKind();
  }
  const duration = finiteMediaDuration();
  if (typeof state.preset === 'number') {
    $('range-start').value = String(Math.max(0, media.currentTime - state.preset));
    $('range-end').value = String(media.currentTime);
  } else if (state.preset === 'next30' && duration) {
    const start = Math.min(media.currentTime, Math.max(0, duration - .1));
    $('range-start').value = String(start);
    $('range-end').value = String(Math.min(duration, start + 30));
  } else if (custom && duration && (message.event === 'seeked' || media.duration !== previousDuration)) {
    // Keep a custom cut's length and its offset from the playhead at the last
    // deliberate trim/seek. Ordinary playback must not drift that cut.
    const length = Math.min(custom.duration, duration);
    const proposedStart = message.event === 'seeked' ? media.currentTime + custom.offset : Number($('range-start').value);
    const start = Math.max(0, Math.min(duration - length, proposedStart));
    $('range-start').value = String(start);
    $('range-end').value = String(start + length);
    // Clamping at the start/end must not replace the last deliberate trim.
    state.customRange = custom;
  }
  let range;
  try { range = currentRange(); } catch { /* Invalid times stay visible. */ }
  const window = state.timelineWindow;
  if (message.event === 'seeked' || (state.preset !== null && window
    && (media.currentTime < window.start || media.currentTime > window.end
      || (range && (range.start < window.start || range.end > window.end))))) state.timelineWindow = null;
  updateRange();
}

function renderTimeline() {
  const media = selectedMedia();
  if (!media || state.page?.kind === 'article') return;
  let range;
  try { range = currentRange(); } catch { range = { start: Number($('range-start').value) || 0, end: Number($('range-end').value) || 0 }; }
  const active = state.job && ['preparing', 'recording', 'uploading'].includes(state.job.status);
  if (active) range = state.job;
  const duration = finiteMediaDuration() || Math.max(media.currentTime + 60, range.end, 120);
  if (!state.timelineWindow) {
    const center = range.start < Math.max(0, media.currentTime - 60) || range.end > Math.min(duration, media.currentTime + 60) ? (range.start + range.end) / 2 : media.currentTime;
    const width = Math.min(duration, Math.max(120, range.end - range.start));
    const start = Math.max(0, Math.min(duration - width, center - width / 2));
    state.timelineWindow = { start, end: start + width };
  }
  const window = state.timelineWindow;
  const locked = Boolean(active || state.captureStarting || state.publishing || state.publishedResult || state.pageAccessBlocked || !finiteMediaDuration());
  const percent = value => `${Math.max(0, Math.min(100, (value - window.start) / (window.end - window.start) * 100))}%`;
  $('clip-range').style.left = percent(range.start);
  $('clip-range').style.width = `${Math.max(0, parseFloat(percent(range.end)) - parseFloat(percent(range.start)))}%`;
  $('clip-playhead').style.left = percent(active ? range.start + (state.job.elapsed || 0) : media.currentTime);
  $('clip-fill').style.width = active ? `${Math.min(100, (state.job.elapsed || 0) / state.job.duration * 100)}%` : '100%';
  $('clip-window-start').textContent = formatTime(window.start);
  $('clip-window-end').textContent = formatTime(window.end);
  for (const boundary of ['start', 'end']) {
    const handle = $(`clip-${boundary}`);
    handle.style.left = percent(range[boundary]);
    handle.disabled = locked;
    $(`${boundary}-time`).disabled = locked;
    $(`set-${boundary}`).disabled = locked;
    if (!timeFieldFocused(`${boundary}-time`)) $(`${boundary}-time`).value = `${formatTime(range[boundary])}.${String(Number(range[boundary].toFixed(3))).split('.')[1] || '0'}`;
    handle.setAttribute('aria-valuemin', '0');
    handle.setAttribute('aria-valuemax', String(duration));
    handle.setAttribute('aria-valuenow', String(range[boundary]));
    handle.setAttribute('aria-valuetext', formatTime(range[boundary]));
  }
  $('playhead-links').classList.toggle('hidden', state.preset !== null);
  $('clip-now').textContent = active ? `[ ${formatTime(range.start)} – ${formatTime(range.end)} ]` : `▲ now ${formatTime(media.currentTime)}`;
  $('clip-duration').textContent = `· ${formatTime(range.end - range.start)}`;
  $('range-here').disabled = locked;
  $('range-here').setAttribute('aria-pressed', String(state.preset === 'next30'));
  const mediaName = media.kind === 'audio' ? 'audio' : 'video';
  $('clip-help').textContent = state.preset ? `Follows the ${mediaName}. Drag the edges for a custom range, up to 90s.` : `Seeking the ${mediaName} moves this cut. ← / → adjusts an edge; Shift moves 5s.`;
  $('clip-bubble').classList.toggle('hidden', !state.draggingBoundary);
  $('clip-window').classList.toggle('dragging', Boolean(state.draggingBoundary));
  if (state.draggingBoundary) {
    $('clip-bubble').style.left = percent(range[state.draggingBoundary]);
    $('clip-bubble').textContent = formatTime(range[state.draggingBoundary]);
  }
  for (const seconds of [15, 30, 60]) {
    $(`preset-${seconds}`).setAttribute('aria-pressed', String(state.preset === seconds));
    $(`preset-${seconds}`).disabled = locked;
  }
}

function editTimeline(boundary, value) {
  let range;
  try { range = currentRange(); } catch { return; }
  state.rangeMode = 'manual';
  state.preset = null;
  $('range-start').value = String(range.start);
  $('range-end').value = String(range.end);
  $('manual-range').classList.remove('hidden');
  const min = boundary === 'start' ? Math.max(0, range.end - 90) : range.start + .1;
  const max = boundary === 'start' ? range.end - .1 : Math.min(finiteMediaDuration(), range.start + 90);
  updateRangeFromVisual(boundary, Math.max(min, Math.min(max, value)), { keepWindow: true });
}

function bindTimeline() {
  for (const boundary of ['start', 'end']) {
    const handle = $(`clip-${boundary}`);
    let pointer = null;
    handle.addEventListener('pointerdown', event => {
      if (handle.disabled) return;
      pointer = event.pointerId;
      state.draggingBoundary = boundary;
      renderTimeline();
      handle.setPointerCapture(pointer);
      event.preventDefault();
      handle.focus();
    });
    handle.addEventListener('pointermove', event => {
      if (pointer !== event.pointerId || handle.disabled) return;
      const rect = $('clip-window').getBoundingClientRect();
      const window = state.timelineWindow;
      editTimeline(boundary, Math.round((window.start + (event.clientX - rect.left) / rect.width * (window.end - window.start)) * 10) / 10);
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(event, () => { pointer = null; state.draggingBoundary = null; renderTimeline(); });
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || handle.disabled) return;
      event.preventDefault();
      try { editTimeline(boundary, currentRange()[boundary] + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 5 : 1)); } catch { /* Invalid range stays visible. */ }
    });
  }
}

function finiteMediaDuration(media = selectedMedia()) {
  const duration = Number(media?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function syncRangeBounds() {
  const duration = finiteMediaDuration();
  for (const id of ['range-start-visual', 'range-end-visual', 'range-start', 'range-end']) {
    const input = $(id);
    if (duration) input.max = String(duration);
    else input.removeAttribute('max');
    input.disabled = state.rangeMode === 'manual' && !duration;
  }
  $('set-start').disabled = state.rangeMode === 'manual' && !duration;
  $('set-end').disabled = state.rangeMode === 'manual' && !duration;
  $('range-here').disabled = !duration;
  for (const boundary of ['start', 'end']) {
    $(`range-${boundary}-visual`).min = '0';
    $(`range-${boundary}-scale`).textContent = duration ? `0:00 — ${formatTime(duration)}` : '';
    $(`${boundary}-time`).disabled = !duration;
  }
}

function syncVisualRangeFromPrecise() {
  const duration = finiteMediaDuration();
  if (!duration) return syncRangeBounds();
  syncRangeBounds();
  const start = Math.max(0, Math.min(duration, Number($('range-start').value) || 0));
  const end = Math.max(0, Math.min(duration, Number($('range-end').value) || 0));
  $('range-start-visual').value = String(start);
  $('range-end-visual').value = String(end);
  $('range-start-label').textContent = formatTime(start);
  $('range-end-label').textContent = formatTime(end);
  for (const [boundary, value] of [['start', start], ['end', end]]) {
    const precise = Number(value.toFixed(3));
    const fraction = String(precise).split('.')[1];
    if (!timeFieldFocused(`${boundary}-time`)) $(`${boundary}-time`).value = `${formatTime(precise)}${fraction ? `.${fraction}` : ''}`;
  }
}

function updateRangeFromVisual(boundary, explicitValue, { keepWindow = false } = {}) {
  const duration = finiteMediaDuration();
  if (!duration) return updateRange();
  state.preset = null;
  if (!keepWindow) state.timelineWindow = null;
  const { start, end } = adjustVisualRange({
    boundary,
    value: explicitValue ?? $(boundary === 'start' ? 'range-start-visual' : 'range-end-visual').value,
    start: $('range-start').value,
    end: $('range-end').value,
    duration
  });
  $('range-start').value = String(start);
  $('range-end').value = String(end);
  updateRange();
  state.rangeInputInvalid = !state.rangeValid;
  rememberCustomRange();
}

function renderRecordAvailability() {
  const sourceActive = state.captureStarting || (state.job && ['preparing', 'recording', 'uploading'].includes(state.job.status));
  const voiceActive = Boolean(dictation?.active) || ['requesting', 'recording', 'stopping', 'uploading'].includes(state.voice.status);
  $('record').disabled = state.pageAccessBlocked || Boolean(sourceActive) || voiceActive || !state.token || !state.page?.media?.length || !state.rangeValid;
}

async function setRangeToPlayhead(boundary) {
  clearNotice();
  const media = selectedMedia();
  if (!media) return showNotice('Choose a media player first.', true);
  try {
    const response = await sendRuntime({ type: 'ANNOTATED_PANEL_BOOTSTRAP' });
    if (response.page?.tabId !== state.page?.tabId || response.page?.url !== state.page?.url) {
      throw new Error('Return to this source tab before setting the range.');
    }
    const fresh = response.page.media?.find((item) => item.id === media.id);
    if (!fresh) throw new Error('That player is no longer available.');
    media.currentTime = fresh.currentTime;
    media.liveTime = fresh.currentTime;
    media.duration = fresh.duration;
    syncRangeBounds();
    if (!finiteMediaDuration(media)) throw new Error('Wait for the player duration, then try again.');
    const value = Number(fresh.currentTime).toFixed(1);
    if (boundary === 'window') {
      state.rangeInputInvalid = false;
      const start = Math.min(Number(value), Math.max(0, fresh.duration - 0.1));
      $('range-start').value = start.toFixed(1);
      $('range-end').value = Math.min(fresh.duration, start + 30).toFixed(1);
      updateRange();
    } else updateRangeFromVisual(boundary, value);
    return true;
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function record() {
  clearNotice();
  if (state.captureStarting || (state.job && ['preparing', 'recording', 'uploading'].includes(state.job.status))) return;
  if (dictation?.active) return showNotice('Finish dictation before recording a source excerpt.', true);
  if (state.pageAccessBlocked) return showNotice('Connect the source page with the Annotated A toolbar icon before recording.', true);
  if (!state.token) return showNotice(APP_CONFIG.mode === 'local' ? 'Choose a local demo identity before recording.' : 'Sign in before recording.', true);
  if (['requesting', 'recording', 'stopping', 'uploading'].includes(state.voice.status)) return showNotice('Finish the voice note before recording a source excerpt.', true);
  try {
    const media = selectedMedia();
    state.draftIconActive = true;
    state.captureStarting = true;
    renderRecordAvailability();
    if ([15, 60].includes(state.preset)) await selectPreset(state.preset);
    currentRange();
    clearPreview();
    renderJob();
    const sequence = captureUpdateSequence;
    const job = await sendRuntime({
      type: 'ANNOTATED_START_CAPTURE',
      tabId: state.page.tabId,
      draftHue: state.draftHue,
      mediaId: media.id,
      rangeMode: state.rangeMode,
      start: $('range-start').value,
      end: $('range-end').value
    });
    if (sequence === captureUpdateSequence) state.job = job;
    renderJob();
  } catch (error) {
    showNotice(error.message, true);
    $('capture-status').textContent = error.message;
    $('capture-status').classList.add('error');
  } finally {
    state.captureStarting = false;
    renderTimeline();
    renderRecordAvailability();
    renderComposerVisibility();
  }
}

async function cancelCapture() {
  await sendRuntime({ type: 'ANNOTATED_CANCEL_CAPTURE' }).catch((error) => showNotice(error.message, true));
}

async function rerecord() {
  if (state.job && ['preparing', 'recording', 'uploading'].includes(state.job.status)) return;
  const jobId = state.job?.status === 'ready' ? state.job.id : null;
  if (!jobId) return;
  clearNotice();
  try {
    await discardCaptureJob(jobId);
    clearPreview();
    renderJob();
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function discardCaptureJob(jobId) {
  const result = await sendRuntime({ type: 'ANNOTATED_DISCARD_CAPTURE', jobId });
  if (state.job?.id === jobId) state.job = null;
  return result;
}

function renderJob() {
  const job = state.job;
  renderPausedDraft();
  renderRecordAvailability();
  renderVoice();
  renderComposerVisibility();
  renderTimeline();
  $('capture-status').classList.toggle('error', Boolean(job && ['failed', 'cancelled'].includes(job.status)));
  $('capture-status').textContent = state.captureStarting && !job ? 'Starting capture…'
    : job?.status === 'ready' ? 'Clip ready. Play it above, then publish your take.'
      : job?.status === 'uploading' ? 'Recording finished. Saving and checking your clip…'
        : job?.status === 'preparing' ? 'Preparing the selected excerpt…'
          : job?.status === 'recording' ? 'Recording your selected excerpt…'
            : job?.status === 'failed' ? `Clip not saved: ${job.error || 'Recording failed.'} Your take is kept. Try recording again.`
              : job?.status === 'cancelled' ? `${job.error || 'Capture cancelled.'} Your take is kept.` : '';
  if (job?.status === 'cancelled') clearDraftPreview();
  if (!job) return;
  if (['preparing', 'recording', 'uploading', 'ready'].includes(job.status)
    && job.tabId === state.page?.tabId && job.sourceUrl === state.page?.url) {
    $('range-summary').textContent = `${formatTime(job.start)}–${formatTime(job.end)} · ${formatTime(job.duration)}`;
    $('range-summary').classList.remove('error');
  }
  const fraction = job.duration ? Math.min(1, (job.elapsed || 0) / job.duration) : 0;
  $('progress-bar').style.width = `${fraction * 100}%`;
  $('progress-label').textContent = job.status === 'preparing' ? 'Preparing…'
    : job.status === 'uploading' ? 'Validating…'
      : `${formatTime(job.elapsed)} / ${formatTime(job.duration)}`;
  $('capture-progress-title').textContent = job.status === 'uploading' ? 'Saving clip' : job.status === 'preparing' ? 'Preparing' : 'Recording';
  if (job.status !== 'cancelled' && (job.capture?.previewUrl || (job.status === 'ready' && job.capture?.id))) {
    $('captured-range').textContent = `${formatTime(job.start)}–${formatTime(job.end)}`;
    renderPreview(job);
  }
  if (job.status === 'failed') showNotice(`The clip couldn't be validated. Your take was kept. ${job.error || ''}`.trim(), true);
  if (job.status === 'cancelled') showNotice('Capture cancelled. Your take was kept.');
}

async function startVoice() {
  clearNotice();
  if (dictation?.active) return showNotice('Finish dictation before recording an audio note.', true);
  if (state.publishing || state.publishedResult || state.pageAccessBlocked) return;
  if (!state.token) return showNotice(APP_CONFIG.mode === 'local' ? 'Choose a local demo identity before recording voice commentary.' : 'Sign in before recording voice commentary.', true);
  if (state.job && ['preparing', 'recording', 'uploading'].includes(state.job.status)) return showNotice('Finish the source excerpt before recording voice commentary.', true);
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    return showNotice('Voice recording is not available in this browser.', true);
  }
  deleteVoice();
  const voice = state.voice;
  state.draftIconActive = true;
  const generation = ++voice.generation;
  voice.status = 'requesting';
  voice.discard = false;
  renderVoice();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    if (voice.generation !== generation || voice.status !== 'requesting') {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    voice.stream = stream;
    $('microphone-help').classList.add('hidden');
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type)) || '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 96_000 } : undefined);
    voice.recorder = recorder;
    voice.chunks = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (voice.generation === generation && voice.recorder === recorder && event.data.size) voice.chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => finalizeVoice(recorder, generation), { once: true });
    recorder.addEventListener('error', () => {
      if (voice.generation !== generation || voice.recorder !== recorder) return;
      voice.discard = true;
      voice.status = 'stopping';
      clearVoiceTimers();
      if (voice.recorder?.state === 'recording') voice.recorder.stop();
      stopVoiceTracks();
      renderVoice();
      showNotice('The microphone recording stopped unexpectedly.', true);
    }, { once: true });
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (voice.generation === generation && voice.recorder === recorder && voice.status === 'recording') {
          voice.discard = true;
          voice.status = 'stopping';
          clearVoiceTimers();
          if (voice.recorder?.state === 'recording') voice.recorder.stop();
          renderVoice();
          showNotice('Microphone access ended before the voice note was finished.', true);
        }
      }, { once: true });
    }
    recorder.start(250);
    voice.startedAt = performance.now();
    voice.status = 'recording';
    voice.timer = setInterval(renderVoiceTime, 250);
    voice.hardStop = setTimeout(() => {
      stopVoice(false);
      showNotice('Voice note reached the 90-second limit.');
    }, MAX_VOICE_RECORDING_MS);
    renderVoice();
  } catch (error) {
    if (voice.generation !== generation || voice.status !== 'requesting') return;
    stopVoiceTracks();
    resetVoice();
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      $('microphone-help').classList.remove('hidden');
      showNotice('Chrome did not allow microphone access here. Use Allow microphone below your take if Chrome cannot show its permission prompt.', true);
    } else {
      showNotice(`Voice recording could not start: ${error.message}`, true);
    }
  }
}

async function openMicrophoneSetup() {
  try {
    const url = new URL(chrome.runtime.getURL('microphone.html'));
    url.searchParams.set('returnAfterGrant', '1');
    if (Number.isInteger(state.page?.tabId)) url.searchParams.set('sourceTab', String(state.page.tabId));
    if (microphoneSetupTabId !== null) {
      // Restart the permission helper when a temporary grant has expired.
      try { await chrome.tabs.update(microphoneSetupTabId, { active: true, url: url.href }); return; }
      catch { microphoneSetupTabId = null; }
    }
    // Chrome may need a normal extension tab to display an initial permission
    // prompt. Open it only when the user chooses this recovery action.
    const setupTab = await chrome.tabs.create({ url: url.href, ...(Number.isInteger(state.page?.tabId) ? { openerTabId: state.page.tabId } : {}), ...(Number.isInteger(state.windowId) ? { windowId: state.windowId } : {}) });
    microphoneSetupTabId = setupTab.id;
    showNotice('Allow microphone access in the setup tab, then click the mic here to dictate. Keep the setup tab open if you choose “Allow this time”.');
  } catch {
    showNotice('The microphone permission tab could not open. Try Allow microphone again.', true);
  }
}

function stopVoice(discard) {
  const voice = state.voice;
  if (voice.status === 'requesting') {
    resetVoice();
    return;
  }
  if (voice.status !== 'recording') return;
  voice.discard ||= discard;
  if (discard) {
    const recorder = voice.recorder;
    voice.discard = true;
    if (recorder?.state === 'recording') recorder.stop();
    stopVoiceTracks();
    resetVoice();
    return;
  }
  voice.status = 'stopping';
  clearVoiceTimers();
  renderVoice();
  if (voice.recorder?.state === 'recording') {
    voice.recorder.stop();
  } else {
    stopVoiceTracks();
    resetVoice();
  }
}

function finalizeVoice(recorder, generation) {
  const voice = state.voice;
  if (voice.generation !== generation || voice.recorder !== recorder) return;
  clearVoiceTimers();
  stopVoiceTracks();
  const discard = voice.discard;
  const mimeType = voice.recorder?.mimeType || 'audio/webm';
  const blob = new Blob(voice.chunks, { type: mimeType });
  const duration = Math.min(90, (performance.now() - voice.startedAt) / 1000);
  voice.recorder = null;
  voice.chunks = [];
  if (discard) {
    resetVoice();
    return;
  }
  if (!blob.size) {
    resetVoice();
    showNotice('The microphone produced an empty voice note.', true);
    return;
  }
  voice.blob = blob;
  voice.duration = duration;
  voice.previewUrl = URL.createObjectURL(blob);
  voice.status = 'ready';
  renderVoice();
}

function deleteVoice() {
  const voice = state.voice;
  voice.uploadAbort?.abort();
  if (voice.status === 'recording' || voice.status === 'requesting') return stopVoice(true);
  resetVoice();
}

function renderVoice() {
  const voice = state.voice;
  const active = ['requesting', 'recording', 'stopping'].includes(voice.status);
  const sourceActive = state.job && ['preparing', 'recording', 'uploading'].includes(state.job.status);
  if (voice.status !== 'idle') $('audio-note').open = true;
  $('audio-note-label').textContent = voice.status === 'ready' || voice.status === 'uploading' ? 'Audio note attached'
    : active ? 'Recording audio note' : 'Attach an audio note';
  $('voice-recording').classList.toggle('hidden', !active);
  $('voice-preview').classList.toggle('hidden', voice.status !== 'ready');
  $('voice-take').classList.toggle('has-voice', voice.status === 'ready');
  $('voice-record').disabled = !state.token || state.pageAccessBlocked || state.publishing || Boolean(state.publishedResult) || Boolean(dictation?.active) || Boolean(sourceActive) || active || voice.status === 'uploading';
  $('voice-record').classList.toggle('hidden', active);
  $('voice-record-label').textContent = voice.status === 'ready' ? 'Record again' : 'Record audio note';
  $('voice-stop').disabled = voice.status !== 'recording';
  $('voice-cancel').disabled = voice.status === 'stopping';
  $('voice-status').textContent = voice.status === 'requesting' ? 'Waiting for microphone…' : voice.status === 'stopping' ? 'Finishing…' : 'Recording';
  renderPublishAvailability();
  if (voice.status === 'ready' && voice.previewUrl) {
    if ($('voice-preview-audio').getAttribute('src') !== voice.previewUrl) $('voice-preview-audio').src = voice.previewUrl;
    renderVoicePlayback();
    $('voice-meta').textContent = `${formatTime(voice.duration)} audio note ready`;
  }
  renderVoiceTime();
  renderComposerVisibility();
}

function renderVoicePlayback() {
  const player = $('voice-preview-audio');
  const elapsed = Number.isFinite(player.currentTime) ? player.currentTime : 0;
  const duration = Number.isFinite(player.duration) ? player.duration : state.voice.duration;
  $('voice-play').textContent = player.paused ? '▶' : 'Ⅱ';
  $('voice-play').setAttribute('aria-label', player.paused ? 'Play audio note' : 'Pause audio note');
  $('voice-seek').max = String(duration || 90);
  $('voice-seek').value = String(elapsed);
  $('voice-seek').setAttribute('aria-valuetext', `${formatTime(elapsed)} of ${formatTime(duration || 0)}`);
  $('voice-played').style.width = `${duration ? Math.min(100, elapsed / duration * 100) : 0}%`;
  $('voice-playback-time').textContent = formatTime(player.paused && elapsed === 0 ? duration || 0 : elapsed);
}

function renderVoiceTime() {
  const voice = state.voice;
  const elapsed = voice.status === 'recording' ? (performance.now() - voice.startedAt) / 1000 : voice.duration;
  $('voice-time').textContent = `${formatTime(elapsed)} / 1:30`;
}

function clearVoiceTimers() {
  clearInterval(state.voice.timer);
  clearTimeout(state.voice.hardStop);
  state.voice.timer = null;
  state.voice.hardStop = null;
}

function stopVoiceTracks() {
  state.voice.stream?.getTracks().forEach((track) => track.stop());
  state.voice.stream = null;
}

function resetVoice() {
  const voice = state.voice;
  voice.generation += 1;
  clearVoiceTimers();
  stopVoiceTracks();
  if (voice.previewUrl) URL.revokeObjectURL(voice.previewUrl);
  voice.status = 'idle';
  voice.recorder = null;
  voice.chunks = [];
  voice.blob = null;
  voice.previewUrl = null;
  voice.duration = 0;
  voice.startedAt = 0;
  voice.discard = false;
  voice.uploadAbort = null;
  voice.mediaId = null;
  $('voice-preview-audio').removeAttribute('src');
  $('audio-note').open = false;
  renderVoice();
}

function disposeVoice() {
  const voice = state.voice;
  voice.generation += 1;
  voice.discard = true;
  voice.status = 'stopping';
  voice.uploadAbort?.abort();
  clearVoiceTimers();
  if (voice.recorder?.state === 'recording') voice.recorder.stop();
  stopVoiceTracks();
  if (voice.previewUrl) URL.revokeObjectURL(voice.previewUrl);
  syncLogo();
}

async function uploadVoice() {
  const voice = state.voice;
  if (voice.mediaId) return voice.mediaId;
  if (!voice.blob) return null;
  voice.status = 'uploading';
  voice.uploadAbort = new AbortController();
  const uploadController = voice.uploadAbort;
  renderVoice();
  try {
    const body = await uploadMedia({
      apiOrigin: API,
      mediaStorage: APP_CONFIG.mediaStorage,
      token: state.token,
      role: 'voice',
      blob: voice.blob,
      signal: uploadController.signal,
      onUnauthorized: handleUnauthorizedSession
    });
    if (uploadController.signal.aborted) throw new DOMException('The upload was cancelled.', 'AbortError');
    voice.mediaId = body.id;
    voice.status = 'ready';
    return body.id;
  } finally {
    if (voice.uploadAbort === uploadController) voice.uploadAbort = null;
    if (voice.status === 'uploading') voice.status = 'ready';
    renderVoice();
  }
}

function renderPreview(job) {
  if (job.status === 'cancelled' || !state.page || job.tabId !== state.page.tabId || job.sourceUrl !== state.page.url) return;
  const isVideo = job.mediaKind === 'video';
  $('preview-wrap').classList.remove('hidden');
  $('video-preview').classList.toggle('hidden', !isVideo);
  $('audio-preview').classList.toggle('hidden', isVideo);
  const player = isVideo ? $('video-preview') : $('audio-preview');
  const url = validatedPreviewId === job.capture.id && validatedPreviewUrl ? validatedPreviewUrl : job.capture.previewUrl;
  if (url && player.getAttribute('src') !== url) player.src = url;
  $('preview-meta').textContent = `${formatTime(job.capture.duration ?? job.duration)} · ${job.status === 'ready' ? 'Clip ready · review and publish' : job.status === 'uploading' ? 'Recorded · saving clip…' : 'Recording not saved'}`;
  if (job.status === 'ready' && job.capture.id && validatedPreviewId !== job.capture.id) loadValidatedPreview(job);
}

async function loadValidatedPreview(job) {
  const generation = ++previewGeneration;
  validatedPreviewId = job.capture.id;
  if (validatedPreviewUrl) URL.revokeObjectURL(validatedPreviewUrl);
  validatedPreviewUrl = null;
  try {
    const response = await fetch(`${API}/media/${encodeURIComponent(job.capture.id)}`, { headers: { Authorization: `Bearer ${state.token}` } });
    if (!response.ok) throw new Error('Preview unavailable');
    const blob = await response.blob();
    if (generation !== previewGeneration || state.pageAccessBlocked || state.job?.id !== job.id || state.job.status !== 'ready') return;
    validatedPreviewUrl = URL.createObjectURL(blob);
    renderPreview(state.job);
  } catch {
    if (generation === previewGeneration) {
      validatedPreviewId = null;
      if (!job.capture.previewUrl) $('preview-meta').textContent = 'Clip saved. Preview could not load; click Refresh to retry.';
    }
  }
}

function clearDraftPreview() {
  ++previewGeneration;
  validatedPreviewId = null;
  if (validatedPreviewUrl) URL.revokeObjectURL(validatedPreviewUrl);
  validatedPreviewUrl = null;
  $('preview-wrap').classList.add('hidden');
  for (const id of ['video-preview', 'audio-preview']) {
    const player = $(id);
    player.pause?.();
    player.removeAttribute('src');
  }
  $('preview-meta').textContent = '';
}

function clearPreview() {
  clearDraftPreview();
  for (const id of ['published-video', 'published-audio']) {
    const player = $(id);
    player.pause?.();
    player.removeAttribute('src');
  }
}

async function lookupSource() {
  if (!state.page || state.pageAccessBlocked) return;
  const sequence = ++lookupSequence;
  const page = state.page;
  try {
    const key = await sourceKey(page.url);
    const lookup = await api('/api/sources/lookup', { method: 'POST', body: { key }, authenticated: false });
    if (sequence !== lookupSequence || state.page !== page || state.pageAccessBlocked) return;
    state.lookup = lookup;
    renderDiscussion();
  } catch (error) {
    if (sequence === lookupSequence && state.page === page && !state.pageAccessBlocked) showNotice(`Source discussion unavailable: ${error.message}`, true);
  }
}

function renderDiscussion() {
  if (state.pageAccessBlocked) return;
  const annotations = state.lookup?.annotations || [];
  $('discussion').classList.remove('hidden');
  $('discussion-count').textContent = `${annotations.length} ${annotations.length === 1 ? 'note' : 'notes'}`;
  $('nav-page').textContent = `On this page · ${annotations.length}`;
  $('browse-feed').href = `${API}/feed`;
  const container = $('annotations');
  if (!annotations.length) {
    container.innerHTML = '<div class="empty"><h2>Nothing marked here yet.</h2><p>Be the first close reader of this page.</p><button class="button primary" type="button">Mark something</button></div>';
    container.querySelector('button').addEventListener('click', () => setPanelView('new'));
    return;
  }
  container.replaceChildren(...annotations.map(annotationNode));
}

function annotationNode(annotation) {
  const article = document.createElement('article');
  article.className = 'annotation';
  markElement(article, annotation.id);
  const head = document.createElement('div');
  head.className = 'annotation-head';
  const author = document.createElement(annotation.author?.id ? 'a' : 'span');
  author.className = 'annotation-author';
  if (annotation.author?.id) {
    author.href = `${API}/u/${encodeURIComponent(annotation.author.id)}`;
    author.target = '_blank';
    author.rel = 'noreferrer';
  }
  author.textContent = annotation.author?.name || 'Demo reader';
  const date = document.createElement('span');
  date.className = 'annotation-time';
  date.textContent = relativeDate(annotation.createdAt);
  date.title = new Date(annotation.createdAt).toLocaleString();
  const avatar = document.createElement('span');
  avatar.className = 'annotation-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = (annotation.author?.name || 'Reader').split(/\s+/).slice(0, 2).map(part => part[0]).join('');
  markElement(avatar, annotation.author?.id || annotation.id);
  head.append(avatar, author, date);
  article.append(head);
  const comment = document.createElement('p');
  comment.className = 'annotation-take';
  comment.textContent = annotation.commentary || 'Voice commentary';
  article.append(comment);
  for (const excerpt of sourceExcerpts(annotation)) article.append(quoteNode(excerpt));
  if (annotation.mediaUrl) {
    const player = document.createElement(annotation.source?.kind === 'video' ? 'video' : 'audio');
    player.className = 'source-player';
    player.src = new URL(annotation.mediaUrl, API).href;
    player.controls = true;
    player.preload = 'metadata';
    player.setAttribute('aria-label', 'Source excerpt');
    player.setAttribute('playsinline', '');
    if (annotation.source?.kind === 'video') player.addEventListener('loadedmetadata', () => fitVideo(player));
    const media = document.createElement('div');
    media.className = 'annotation-media';
    media.append(player);
    if (Number.isFinite(annotation.start) && Number.isFinite(annotation.end)) {
      const range = document.createElement('span');
      range.className = 'annotation-range';
      range.textContent = `${formatTime(annotation.start)}–${formatTime(annotation.end)}`;
      media.append(range);
    }
    article.append(media);
  }
  const links = document.createElement('div');
  links.className = 'annotation-links';
  const conversation = document.createElement('a');
  conversation.className = 'discussion-link';
  conversation.href = `${API}/a/${encodeURIComponent(annotation.id)}`;
  conversation.target = '_blank';
  conversation.rel = 'noreferrer';
  conversation.textContent = `${annotation.commentCount || 0} ${annotation.commentCount === 1 ? 'reply' : 'replies'} · Open ↗`;
  if (Number.isFinite(annotation.start)) {
    const jump = document.createElement('button');
    jump.className = 'jump';
    jump.textContent = `Jump to ${formatTime(annotation.start)}`;
    jump.addEventListener('click', () => jumpTo(annotation.start));
    links.append(jump);
  }
  links.append(conversation);
  article.append(links);
  return article;
}

function relativeDate(value) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d ago`;
  return new Date(value).toLocaleDateString();
}

async function jumpTo(time) {
  const media = selectedMedia();
  if (!media) return showNotice('No controllable media player is available on this page.', true);
  try { await sendRuntime({ type: 'ANNOTATED_SEEK_ACTIVE', mediaId: media.id, time }); }
  catch (error) { showNotice(error.message, true); }
}

async function publish() {
  clearNotice();
  if (dictation?.active) return showNotice('Stop dictation and review your take before publishing.', true);
  if (state.publishing) return;
  if (state.pageAccessBlocked) return showNotice('Reconnect the source shown in your draft before publishing.', true);
  if (!state.token) return showNotice(APP_CONFIG.mode === 'local' ? 'Choose a local demo identity first.' : 'Sign in first.', true);
  if (!state.page) return;
  if (state.job && ['preparing', 'recording', 'uploading'].includes(state.job.status)) return showNotice('Wait for the source excerpt to finish first.', true);
  if (['requesting', 'recording', 'stopping', 'uploading'].includes(state.voice.status)) return showNotice('Stop the voice recording before publishing.', true);
  const commentary = $('commentary').value.trim();
  const hasVoice = Boolean(state.voice.blob || state.voice.mediaId);
  if (!commentary && !hasVoice) return showNotice('Add text or record voice commentary before publishing.', true);
  const isArticle = state.page.kind === 'article';
  const excerpts = isArticle ? validateHighlights(sourceExcerpts(state.page)) : [];
  const excerpt = joinedHighlights(excerpts);
  if (isArticle && !excerpt) return showNotice('Highlight article text, then click Use highlighted text to attach it.', true);
  let range = { start: null, end: null };
  let mediaId = null;
  if (!isArticle) {
    if (state.job?.status !== 'ready' || !state.job.capture?.id) return showNotice('Record and validate the media excerpt before publishing.', true);
    if (state.job.tabId !== state.page.tabId || state.job.sourceUrl !== state.page.url) return showNotice('This clip belongs to a different source page. Record this source before publishing.', true);
    if (state.job.mediaId !== selectedMedia()?.id) return showNotice('The selected player changed. Record an excerpt from this player before publishing.', true);
    range = { start: state.job.start, end: state.job.end };
    mediaId = state.job.capture.id;
  }
  const publishedCaptureId = isArticle ? null : state.job.id;
  state.publishing = true;
  renderVoice();
  let cleanupError = null;
  try {
    const voiceMediaId = await uploadVoice();
    const canonical = canonicalSource(state.page.url);
    const draft = {
      source: { url: canonical.url, title: state.page.title, kind: isArticle ? 'article' : state.job.mediaKind, author: state.page.author || '', ...(state.page.publisher ? { publisher: state.page.publisher } : {}) },
      excerpt,
      excerpts,
      start: range.start,
      end: range.end,
      commentary,
      mediaId,
      voiceMediaId,
      ...(APP_CONFIG.mode === 'local' ? { isDemo: true } : {})
    };
    state.pendingPublication = publicationIdentity(state.pendingPublication, draft);
    const body = await api('/api/annotations', { method: 'POST', body: { clientId: state.pendingPublication.clientId, ...draft } });
    state.pendingPublication = null;
    $('commentary').value = '';
    resetVoice();
    await lookupSource();
    if (publishedCaptureId) {
      try {
        await discardCaptureJob(publishedCaptureId);
        clearPreview();
      } catch (error) {
        cleanupError = error;
      }
    }
    state.publishedResult = body.annotation || null;
    if (!state.publishedResult?.id) throw new Error('The published annotation did not include a shareable result.');
    if (cleanupError) showNotice(`Published, but the finished clip could not be cleared: ${cleanupError.message}`, true);
    else clearNotice();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    state.publishing = false;
    renderVoice();
    if (refreshAfterPublication) {
      refreshAfterPublication = false;
      await refresh();
    }
  }
}

function renderPublishedResult() {
  const annotation = state.publishedResult;
  if (!annotation?.id) return;
  markElement($('published-status'), annotation.id);
  const permalink = `${API}/a/${encodeURIComponent(annotation.id)}`;
  const author = annotation.author?.name || state.user?.name || 'Reader';
  $('published-take-label').textContent = `THE TAKE — ${author}`;
  $('published-take').textContent = annotation.commentary || 'Voice take';
  $('published-source-meta').textContent = annotation.source?.kind === 'article'
    ? sourceIdentity(annotation.source).publisher.toUpperCase()
    : `${String(annotation.source?.kind || 'media').toUpperCase()} · ${formatTime(annotation.start)}–${formatTime(annotation.end)}`;
  $('published-excerpt').classList.toggle('hidden', !annotation.excerpt);
  $('published-excerpt').replaceChildren(...sourceExcerpts(annotation).map(quoteNode));
  const hasRange = Number.isFinite(annotation.start) && Number.isFinite(annotation.end);
  $('published-media-range').classList.toggle('hidden', !hasRange);
  $('published-media-range').textContent = hasRange ? `Captured source · ${formatTime(annotation.start)}–${formatTime(annotation.end)}` : '';
  for (const kind of ['video', 'audio']) {
    const player = $(`published-${kind}`);
    const visible = annotation.mediaUrl && annotation.source?.kind === kind;
    player.classList.toggle('hidden', !visible);
    if (visible) {
      const url = new URL(annotation.mediaUrl, API).href;
      if (player.getAttribute('src') !== url) player.src = url;
    } else {
      player.pause?.();
      player.removeAttribute('src');
    }
  }
  $('published-source-title').textContent = annotation.source?.author
    ? `${annotation.source.title} · ${annotation.source.author}`
    : annotation.source?.title || 'Original source';
  $('open-annotation').href = permalink;
  $('post-x').href = xShareIntent(annotation, permalink);
}

async function copyPublishedLink() {
  const annotation = state.publishedResult;
  if (!annotation?.id) return;
  const permalink = `${API}/a/${encodeURIComponent(annotation.id)}`;
  try {
    await navigator.clipboard.writeText(permalink);
    $('copy-link').textContent = 'Copied';
    setTimeout(() => { $('copy-link').textContent = 'Copy link'; }, 1600);
  } catch {
    showNotice('The link could not be copied. Open the full page and copy it from the address bar.', true);
  }
}

async function startNewAnnotation() {
  const lingeringJobId = state.job?.status === 'ready' ? state.job.id : null;
  if (lingeringJobId) {
    try { await discardCaptureJob(lingeringJobId); }
    catch (error) {
      showNotice(`The finished clip could not be cleared: ${error.message}`, true);
      return;
    }
  }
  state.publishedResult = null;
  state.draftHue = nextDraftHue(state.draftHue);
  state.draftIconActive = true;
  setTakeMode('write');
  markElement($('compose'), state.draftHue);
  if (state.page?.kind === 'article') { state.page.excerpts = []; state.page.excerpt = ''; renderHighlights(); }
  clearPreview();
  renderJob();
  $('commentary').focus?.();
}

async function api(path, { method = 'GET', body, authenticated = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authenticated && state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && authenticated) await handleUnauthorizedSession();
  if (!response.ok) throw new Error(payload.error || `The service returned ${response.status}.`);
  return payload;
}

async function sendRuntime(message) {
  const response = await chrome.runtime.sendMessage({ ...message, windowId: state.windowId });
  if (!response?.ok) throw new Error(response?.error || 'The extension worker did not respond.');
  return response.result;
}

function showNotice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.remove('hidden');
  $('notice').classList.toggle('error', error);
}

function clearNotice() {
  $('notice').classList.add('hidden');
  $('notice').classList.remove('error');
  $('notice').textContent = '';
}

export const __voiceTestHooks = { initDictation, toggleDictation, openMicrophoneSetup, acceptSession, state, startVoice, deleteVoice, disposeVoice, handleUnauthorizedSession, logout, revalidateSession, rerecord, renderVoice, renderComposerStage, renderPublishAvailability, refresh, bindSourceEvents, lookupSource, publish, discardPausedDraft, record, renderJob, clearPreview, setRangeMode, updateRangeFromVisual, renderHighlights, selectPreset, editTimeline, currentRange, choosePlayhead, setTakeMode, bindEvents };
