import { isCurrentCapture, normalizeRange, offscreenStartMessage } from './helpers.mjs';
import { sessionStorageKey } from './config.mjs';
import { createActionIconUpdater } from './action-icon.mjs';
import { markerIndex } from './marker.mjs';

const SESSION_KEY = sessionStorageKey();

const OFFSCREEN_PATH = 'offscreen.html';
const WORKER_MESSAGES = new Set([
  'ANNOTATED_PANEL_BOOTSTRAP', 'ANNOTATED_REFRESH_PAGE', 'ANNOTATED_START_CAPTURE',
  'ANNOTATED_SET_DRAFT_ICON',
  'ANNOTATED_CANCEL_CAPTURE', 'ANNOTATED_DISCARD_CAPTURE', 'ANNOTATED_SEEK_ACTIVE',
  'ANNOTATED_CAPTURE_READY', 'ANNOTATED_CAPTURE_PROGRESS', 'ANNOTATED_CAPTURE_STOPPING',
  'ANNOTATED_CAPTURE_PREVIEW', 'ANNOTATED_CAPTURE_COMPLETE', 'ANNOTATED_CAPTURE_FAILED',
  'ANNOTATED_RANGE_ENDED', 'ANNOTATED_SOURCE_LOST'
]);
let jobMutationTail = Promise.resolve();
const updateActionIcon = createActionIconUpdater();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

// The toolbar action grants activeTab. Opening the panel ourselves keeps an
// already-open panel visible and lets it read the newly authorized source.
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId })
    .then(() => chrome.runtime.sendMessage({ type: 'ANNOTATED_PAGE_ACCESS_GRANTED', windowId: tab.windowId }))
    .catch(() => {}); // A newly opened panel also discovers the page on init.
});

chrome.tabs.onRemoved.addListener((tabId) => cancelIfTab(tabId, 'The source tab was closed.').catch(() => {}));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' || change.url) cancelIfTab(tabId, 'The source page changed.').catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!WORKER_MESSAGES.has(message?.type)) return false;
  handleMessage(message, sender).then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'ANNOTATED_SET_DRAFT_ICON':
      return updateActionIcon(message.tabId, message.hue);
    case 'ANNOTATED_PANEL_BOOTSTRAP':
      return { page: await discoverActivePage(message.windowId), job: await getJob() };
    case 'ANNOTATED_REFRESH_PAGE':
      return discoverActivePage(message.windowId);
    case 'ANNOTATED_START_CAPTURE':
      return startCapture(message);
    case 'ANNOTATED_CANCEL_CAPTURE':
      return cancelCapture('Recording cancelled.');
    case 'ANNOTATED_DISCARD_CAPTURE':
      return discardCapture(message.jobId);
    case 'ANNOTATED_SEEK_ACTIVE': {
      const tab = await activeTab(message.windowId);
      return sendTab(tab.id, { type: 'ANNOTATED_SEEK', mediaId: message.mediaId, time: message.time });
    }
    case 'ANNOTATED_CAPTURE_READY':
      return captureReady(message.jobId);
    case 'ANNOTATED_CAPTURE_PROGRESS':
      return updateActiveJob(message.jobId, ['recording'], { elapsed: message.elapsed });
    case 'ANNOTATED_CAPTURE_STOPPING':
      return updateActiveJob(message.jobId, ['preparing', 'recording'], { status: 'uploading' });
    case 'ANNOTATED_CAPTURE_PREVIEW':
      return updateActiveJob(message.jobId, ['recording', 'uploading'], {
        status: 'uploading', capture: message.capture
      });
    case 'ANNOTATED_CAPTURE_COMPLETE':
      return completeCapture(message);
    case 'ANNOTATED_CAPTURE_FAILED':
      return failCapture(message.error || 'Recording failed.', message.jobId);
    case 'ANNOTATED_RANGE_ENDED':
      return stopOffscreen(message.jobId, sender.tab?.id);
    case 'ANNOTATED_SOURCE_LOST':
      return cancelSourceCapture(message.jobId, sender.tab?.id, message.detail || 'The source was lost.');
    default:
      return undefined;
  }
}

async function activeTab(windowId) {
  const context = Number.isInteger(windowId) && windowId >= 0 ? { windowId } : { currentWindow: true };
  const [tab] = await chrome.tabs.query({ active: true, ...context });
  if (!tab?.id) throw new Error('Open a normal web page to annotate.');
  if (!tab.url) throw new Error('Connect this page: click the Annotated icon in Chrome’s toolbar, beside the address bar. Do this on each new tab or website.');
  if (!/^https?:/.test(tab.url)) throw new Error('This Chrome or local-file page cannot be annotated. Open an article, video or podcast on an http or https website, then click the Annotated icon.');
  return tab;
}

async function ensureContent(tabId) {
  try {
    await sendTab(tabId, { type: 'ANNOTATED_DISCOVER' });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] });
    } catch {
      throw new Error('Chrome did not allow access to this page. Click the Annotated icon beside the address bar to reconnect. Chrome’s protected pages cannot be annotated.');
    }
  }
}

async function discoverActivePage(windowId) {
  const tab = await activeTab(windowId);
  await ensureContent(tab.id);
  const page = await sendTab(tab.id, { type: 'ANNOTATED_DISCOVER' });
  return { ...page, tabId: tab.id };
}

async function sendTab(tabId, message) {
  const response = await chrome.tabs.sendMessage(tabId, message);
  if (!response?.ok) throw new Error(response?.error || 'The source page did not respond.');
  return response.result;
}

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (!contexts.length) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA'],
      justification: 'Record the user-selected tab media excerpt after an explicit click.'
    });
  }
}

async function startCapture(message) {
  const existing = await getJob();
  if (existing && ['preparing', 'recording', 'uploading'].includes(existing.status)) throw new Error('A source excerpt is already being recorded.');
  const tab = await activeTab(message.windowId);
  if (tab.id !== message.tabId) throw new Error('Return to the source tab before recording.');
  // Request the one-time stream ID promptly while the panel's Record click still
  // carries user activation. Preparing and seeking the page can take seconds.
  const streamIdPromise = chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  streamIdPromise.catch(() => {});
  const tokenPromise = chrome.storage.local.get(SESSION_KEY);
  await ensureContent(tab.id);
  const jobId = crypto.randomUUID();
  const mediaState = await sendTab(tab.id, { type: 'ANNOTATED_READ_MEDIA', mediaId: message.mediaId });
  const range = normalizeRange({
    mode: message.rangeMode,
    start: message.start,
    end: message.end,
    currentTime: mediaState.currentTime,
    duration: mediaState.duration ?? Infinity
  });
  const prepared = await sendTab(tab.id, {
    type: 'ANNOTATED_PREPARE_CAPTURE',
    jobId,
    mediaId: message.mediaId,
    start: range.start,
    end: range.end
  });
  const job = {
    id: jobId,
    tabId: tab.id,
    mediaId: message.mediaId,
    mediaKind: prepared.mediaKind,
    start: range.start,
    end: range.end,
    duration: range.duration,
    status: 'preparing',
    draftHue: message.draftHue,
    elapsed: 0,
    error: null,
    sourceUrl: tab.url,
    crop: { rect: prepared.rect, viewport: prepared.viewport }
  };
  await setJob(job);
  try {
    await ensureOffscreen();
    const streamId = await streamIdPromise;
    const saved = await tokenPromise;
    const response = await chrome.runtime.sendMessage(offscreenStartMessage(streamId, job, saved[SESSION_KEY]?.token));
    if (!response?.ok) throw new Error(response?.error || 'The recorder could not start.');
    return getJob();
  } catch (error) {
    await sendTab(tab.id, { type: 'ANNOTATED_CANCEL_PAGE' }).catch(() => {});
    const current = await getJob();
    if (current?.id === job.id && current.status !== 'cancelled') await failCapture(error.message, job.id);
    throw error;
  }
}

async function captureReady(jobId) {
  const job = await updateActiveJob(jobId, ['preparing'], { status: 'recording' });
  if (!job || job.id !== jobId || job.status !== 'recording') throw new Error('The recording request is no longer active.');
  try {
    const begin = await chrome.runtime.sendMessage({ type: 'ANNOTATED_OFFSCREEN_BEGIN', jobId });
    if (!begin?.ok) throw new Error(begin?.error || 'The recorder could not begin.');
    await sendTab(job.tabId, { type: 'ANNOTATED_PLAY_RANGE' });
  } catch (error) {
    await cancelCapture(error.message);
    throw error;
  }
  return { ok: true };
}

async function stopOffscreen(jobId, tabId) {
  const job = await getJob();
  if (!isCurrentCapture(job, jobId, tabId, ['recording'])) return { ok: true };
  const stopping = await updateActiveJob(jobId, ['recording'], { status: 'uploading', elapsed: job.duration });
  if (stopping?.status !== 'uploading') return { ok: true };
  await chrome.runtime.sendMessage({ type: 'ANNOTATED_OFFSCREEN_STOP' });
  await sendTab(job.tabId, { type: 'ANNOTATED_CANCEL_PAGE' }).catch(() => {});
  return { ok: true };
}

async function cancelSourceCapture(jobId, tabId, reason) {
  const job = await getJob();
  if (!isCurrentCapture(job, jobId, tabId, ['preparing', 'recording'])) return { ok: true };
  return cancelCapture(reason);
}

async function completeCapture(message) {
  const result = await updateActiveJob(message.jobId, ['recording', 'uploading'], {
    status: 'ready', elapsed: message.duration, capture: message.capture, error: null
  });
  if (result?.id === message.jobId) await sendTab(result.tabId, { type: 'ANNOTATED_CANCEL_PAGE' }).catch(() => {});
  return result;
}

async function cancelCapture(reason) {
  const job = await getJob();
  if (!job || !['preparing', 'recording', 'uploading'].includes(job.status)) return { ok: true };
  const cancelled = await updateActiveJob(job.id, ['preparing', 'recording', 'uploading'], { status: 'cancelled', error: reason });
  if (cancelled?.status !== 'cancelled') return { ok: true };
  await chrome.runtime.sendMessage({ type: 'ANNOTATED_OFFSCREEN_CANCEL', reason }).catch(() => {});
  await sendTab(job.tabId, { type: 'ANNOTATED_CANCEL_PAGE' }).catch(() => {});
  return { ok: true };
}

export async function discardCapture(jobId) {
  if (!jobId) throw new Error('A capture ID is required to discard an excerpt.');
  return mutateJob(async (job) => {
    if (!job) return { value: { discarded: false } };
    if (job.id !== jobId) throw new Error('A newer captured excerpt is now attached.');
    if (job.status !== 'ready') throw new Error('An active capture cannot be discarded.');
    return { job: null, value: { discarded: true, jobId } };
  });
}

async function failCapture(error, jobId = null) {
  const job = await getJob();
  if (!job || (jobId && job.id !== jobId) || !['preparing', 'recording', 'uploading'].includes(job.status)) return job;
  const failed = await updateActiveJob(job.id, ['preparing', 'recording', 'uploading'], { status: 'failed', error });
  if (failed?.status === 'failed' && failed.tabId) await sendTab(failed.tabId, { type: 'ANNOTATED_CANCEL_PAGE' }).catch(() => {});
  return failed;
}

async function cancelIfTab(tabId, reason) {
  const job = await getJob();
  if (job?.tabId === tabId && ['preparing', 'recording', 'uploading'].includes(job.status)) await cancelCapture(reason);
}

async function getJob() {
  await jobMutationTail;
  return readStoredJob();
}

async function setJob(job) {
  return mutateJob(() => ({ job, value: job }));
}

async function readStoredJob() {
  return (await chrome.storage.session.get('captureJob')).captureJob || null;
}

async function updateActiveJob(jobId, statuses, patch) {
  return mutateJob((current) => {
    if (!current || current.id !== jobId || !statuses.includes(current.status)) return { value: current };
    const job = { ...current, ...patch };
    return { job, value: job };
  });
}

function mutateJob(change) {
  const mutation = jobMutationTail.then(async () => {
    const current = await readStoredJob();
    const { job, value } = await change(current);
    if (job !== undefined) {
      if (job === null) await chrome.storage.session.remove('captureJob');
      else await chrome.storage.session.set({ captureJob: job });
      if (current && current.tabId !== job?.tabId) void updateActionIcon(current.tabId, 'citrus');
      if (job) void updateActionIcon(job.tabId, job.status === 'recording' ? 'recording'
        : job.draftHue ? markerIndex(job.draftHue) : 'citrus');
      broadcast(job);
    }
    return value;
  });
  jobMutationTail = mutation.catch(() => {});
  return mutation;
}

function broadcast(job) {
  chrome.runtime.sendMessage({ type: 'ANNOTATED_JOB_UPDATE', job }).catch(() => {});
}
