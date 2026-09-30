import { captureSize } from './helpers.mjs';
import { APP_CONFIG } from './config.mjs';
import { uploadMedia } from './upload-media.mjs';
import { startFramePump } from './frame-pump.mjs';

const API = APP_CONFIG.apiOrigin;
let recording = null;
let upload = null;
let lastPreviewUrl = null;
let startingJobId = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'ANNOTATED_OFFSCREEN_START') {
    start(message).then(() => sendResponse({ ok: true })).catch((error) => {
      if (error.name !== 'AbortError') chrome.runtime.sendMessage({ type: 'ANNOTATED_CAPTURE_FAILED', jobId: message.job.id, error: error.message }).catch(() => {});
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }
  if (message.type === 'ANNOTATED_OFFSCREEN_STOP') {
    stop(false);
    sendResponse({ ok: true });
  }
  if (message.type === 'ANNOTATED_OFFSCREEN_BEGIN') {
    try {
      beginRecording(message.jobId);
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  }
  if (message.type === 'ANNOTATED_OFFSCREEN_CANCEL') {
    startingJobId = null;
    if (upload) {
      upload.discarded = true;
      upload.abort?.abort();
    }
    stop(true);
    sendResponse({ ok: true });
  }
});

async function start({ streamId, job, token }) {
  if (recording) throw new Error('The recorder is already active.');
  startingJobId = job.id;
  const sourceStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: job.mediaKind === 'video' ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } : false
  });
  if (startingJobId !== job.id) {
    sourceStream.getTracks().forEach((track) => track.stop());
    throw new DOMException('Recording cancelled.', 'AbortError');
  }
  const owner = recording = {
    job,
    token,
    sourceStream,
    outputStream: new MediaStream(),
    audioContext: null,
    audioRelay: null,
    stopFramePump: null,
    video: null,
    canvasStream: null,
    recorder: null,
    progressTimer: null,
    watchdog: null,
    cancelled: false,
    rangeConfirmed: false,
    outputSize: null,
    startedAt: null
  };
  startingJobId = null;
  for (const track of sourceStream.getTracks()) {
    track.addEventListener('ended', () => failRecording(owner, 'The source tab capture ended.'), { once: true });
  }
  try {
  const audioTrack = sourceStream.getAudioTracks()[0];
  if (audioTrack) {
    owner.outputStream.addTrack(audioTrack);
    owner.audioContext = new AudioContext();
    owner.audioRelay = owner.audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
    owner.audioRelay.connect(owner.audioContext.destination);
    await owner.audioContext.resume();
    assertOwner(owner);
  }

  if (job.mediaKind === 'video') {
    owner.video = document.createElement('video');
    owner.video.muted = true;
    owner.video.playsInline = true;
    owner.video.srcObject = sourceStream;
    await owner.video.play();
    await waitForDimensions(owner.video);
    assertOwner(owner);
    const dimensions = captureSize(job.crop.rect, owner.video.videoWidth, owner.video.videoHeight, job.crop.viewport.width, job.crop.viewport.height);
    owner.outputSize = dimensions.output;
    const canvas = document.createElement('canvas');
    canvas.width = owner.outputSize.width;
    canvas.height = owner.outputSize.height;
    owner.canvasStream = canvas.captureStream(30);
    const videoTrack = owner.canvasStream.getVideoTracks()[0];
    owner.outputStream.addTrack(videoTrack);
    owner.stopFramePump = startFramePump({
      canvas, video: owner.video, source: dimensions.source, track: videoTrack,
      onError: () => failRecording(owner, 'The source video could not be recorded.')
    });
  }
  if (!owner.outputStream.getTracks().length) throw new Error('The selected tab did not provide a recordable media track.');
  assertOwner(owner);

  const mimeType = chooseMime(job.mediaKind);
  owner.recorder = new MediaRecorder(owner.outputStream, mimeType ? { mimeType, videoBitsPerSecond: 900_000, audioBitsPerSecond: 96_000 } : undefined);
  const chunks = [];
  owner.recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
  owner.recorder.addEventListener('stop', () => finish(owner, chunks).catch((error) => reportFailure(error, job.id)), { once: true });
  const readyResponse = await chrome.runtime.sendMessage({ type: 'ANNOTATED_CAPTURE_READY', jobId: job.id });
  if (!readyResponse?.ok) throw new DOMException(readyResponse?.error || 'Recording cancelled.', 'AbortError');
  if (recording !== owner) {
    if (owner.cancelled) throw new DOMException('Recording cancelled.', 'AbortError');
    return;
  }
  owner.startedAt = performance.now();
  owner.progressTimer = setInterval(() => {
    const elapsed = Math.min(job.duration, (performance.now() - owner.startedAt) / 1000);
    chrome.runtime.sendMessage({ type: 'ANNOTATED_CAPTURE_PROGRESS', jobId: job.id, elapsed }).catch(() => {});
  }, 500);
  owner.watchdog = setTimeout(
    () => failRecording(owner, 'The source player did not reach the selected end time.'),
    Math.ceil((job.duration + 5) * 1000)
  );
  } catch (error) {
    cleanup(owner);
    throw error;
  }
}

function beginRecording(jobId) {
  const current = recording;
  if (!current || current.job.id !== jobId || !current.recorder || current.recorder.state !== 'inactive') {
    throw new Error('The recorder is no longer ready for this excerpt.');
  }
  current.recorder.start(500);
  current.recordStartedAt = performance.now();
}

function stop(cancelled) {
  const current = recording;
  if (!current) return;
  current.cancelled ||= cancelled;
  if (!cancelled) {
    current.rangeConfirmed = true;
    chrome.runtime.sendMessage({ type: 'ANNOTATED_CAPTURE_STOPPING', jobId: current.job.id }).catch(() => {});
  }
  if (current.recorder?.state && current.recorder.state !== 'inactive') current.recorder.stop();
  else cleanup();
}

async function finish(current, chunks) {
  const cancelled = current.cancelled;
  const mimeType = current.recorder.mimeType || (current.job.mediaKind === 'video' ? 'video/webm' : 'audio/webm');
  const blob = new Blob(chunks, { type: mimeType });
  const duration = current.startedAt ? Math.min(current.job.duration, (performance.now() - current.startedAt) / 1000) : 0;
  const outputSize = current.outputSize;
  cleanup(current);
  if (cancelled) return;
  if (!current.rangeConfirmed) throw new Error('The tab capture ended before the source reached the selected end time.');
  if (!blob.size) throw new Error('The recorder produced an empty clip.');
  const uploader = { jobId: current.job.id, abort: null, discarded: false, previewUrl: null };
  upload = uploader;
  if (uploader.discarded) return finishDiscardedUpload(uploader);
  if (!current.token) throw new Error('Your session ended before the clip could be uploaded.');
  const role = current.job.mediaKind === 'video' ? 'source-video' : 'source-audio';
  if (lastPreviewUrl) URL.revokeObjectURL(lastPreviewUrl);
  const previewUrl = URL.createObjectURL(blob);
  lastPreviewUrl = previewUrl;
  uploader.previewUrl = previewUrl;
  const previewResponse = await chrome.runtime.sendMessage({
    type: 'ANNOTATED_CAPTURE_PREVIEW',
    jobId: current.job.id,
    capture: { previewUrl, duration, role, width: outputSize?.width ?? null, height: outputSize?.height ?? null }
  });
  if (!previewResponse?.ok) throw new Error(previewResponse?.error || 'The recorded preview could not be attached.');
  if (uploader.discarded) return finishDiscardedUpload(uploader);
  uploader.abort = new AbortController();
  let body;
  try {
    body = await uploadMedia({
      apiOrigin: API,
      mediaStorage: APP_CONFIG.mediaStorage,
      token: current.token,
      role,
      blob,
      signal: uploader.abort.signal,
      onUnauthorized: () => chrome.runtime.sendMessage({ type: 'ANNOTATED_AUTH_REQUIRED' }).catch(() => {})
    });
  } catch (error) {
    if (uploader.discarded && error.name === 'AbortError') return finishDiscardedUpload(uploader);
    throw error;
  } finally {
    uploader.abort = null;
  }
  if (uploader.discarded) return finishDiscardedUpload(uploader);
  if (upload === uploader) upload = null;
  await chrome.runtime.sendMessage({
    type: 'ANNOTATED_CAPTURE_COMPLETE',
    jobId: current.job.id,
    duration: body.duration ?? duration,
    capture: { ...body, previewUrl, role, width: body.width ?? outputSize?.width ?? null, height: body.height ?? outputSize?.height ?? null }
  });
}

function cleanup(owner = recording) {
  if (!owner) return;
  if (recording === owner) recording = null;
  clearInterval(owner.progressTimer);
  clearTimeout(owner.watchdog);
  owner.stopFramePump?.();
  if (owner.recorder?.state && owner.recorder.state !== 'inactive') {
    owner.cancelled = true;
    owner.recorder.stop();
  }
  owner.video?.pause();
  if (owner.video) owner.video.srcObject = null;
  for (const track of new Set([...owner.sourceStream.getTracks(), ...owner.outputStream.getTracks(), ...(owner.canvasStream?.getTracks() || [])])) track.stop();
  owner.audioContext?.close().catch(() => {});
}

function chooseMime(kind) {
  const candidates = kind === 'video'
    ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['audio/webm;codecs=opus', 'audio/webm'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function waitForDimensions(video) {
  if (video.videoWidth && video.videoHeight) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The tab video stream did not become ready.')), 5000);
    video.addEventListener('loadedmetadata', () => { clearTimeout(timeout); resolve(); }, { once: true });
  });
}

function reportFailure(error, jobId) {
  if (upload?.jobId === jobId && upload.discarded) return finishDiscardedUpload(upload);
  if (upload?.jobId === jobId) releasePreview(upload);
  if (upload?.jobId === jobId) upload = null;
  chrome.runtime.sendMessage({ type: 'ANNOTATED_CAPTURE_FAILED', jobId, error: error.message }).catch(() => {});
}

function finishDiscardedUpload(owner) {
  releasePreview(owner);
  if (upload === owner) upload = null;
}

function releasePreview(owner) {
  if (owner.previewUrl && lastPreviewUrl === owner.previewUrl) {
    URL.revokeObjectURL(owner.previewUrl);
    lastPreviewUrl = null;
  }
}

function assertOwner(owner) {
  if (recording !== owner) throw new DOMException('Recording cancelled.', 'AbortError');
}

function failRecording(owner, message) {
  if (recording !== owner) return;
  owner.cancelled = true;
  chrome.runtime.sendMessage({ type: 'ANNOTATED_CAPTURE_FAILED', jobId: owner.job.id, error: message }).catch(() => {});
  stop(true);
}
