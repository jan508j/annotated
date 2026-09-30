export const MAX_CLIP_SECONDS = 90;
export const MAX_VOICE_RECORDING_MS = 89_500;

export function normalizeRange({ mode = 'manual', start, end, currentTime = 0, duration = Infinity }) {
  const finiteDuration = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : Infinity;
  let rangeEnd = mode === 'previous30' ? Number(currentTime) : Number(end);
  let rangeStart = mode === 'previous30' ? rangeEnd - 30 : Number(start);
  if (!Number.isFinite(rangeStart)) rangeStart = 0;
  if (!Number.isFinite(rangeEnd)) throw new Error('Choose an end time for the excerpt.');
  rangeStart = Math.max(0, rangeStart);
  rangeEnd = Math.min(finiteDuration, rangeEnd);
  if (rangeEnd <= rangeStart) throw new Error('The end time must be after the start time.');
  if (rangeEnd - rangeStart > MAX_CLIP_SECONDS + 0.001) throw new Error('Source clips can be at most 90 seconds.');
  return { start: roundTime(rangeStart), end: roundTime(rangeEnd), duration: roundTime(rangeEnd - rangeStart) };
}

export function adjustVisualRange({ boundary, value, start, end, duration }) {
  const mediaDuration = Number(duration);
  if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) throw new Error('A finite media duration is required.');
  if (!['start', 'end'].includes(boundary)) throw new Error('Choose a start or end boundary.');
  const clamp = number => roundTime(Math.max(0, Math.min(mediaDuration, Number(number) || 0)));
  // Editing can temporarily form an invalid pair; normalizeRange gates recording.
  // Never move the endpoint that the reader did not touch.
  return { start: clamp(boundary === 'start' ? value : start), end: clamp(boundary === 'end' ? value : end) };
}

export function parseTimestamp(value) {
  const parts = String(value).trim().split(':');
  if (parts.length > 3 || parts.some(part => !/^\d+(?:\.\d+)?$/.test(part))) throw new Error('Use a time such as 6:15 or 1:02:30.');
  if (parts.slice(1).some(part => Number(part) >= 60)) throw new Error('Minutes and seconds after a colon must be below 60.');
  return parts.reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

export function roundTime(value) {
  return Math.round(Number(value) * 100) / 100;
}

export function boundedExcerpt(value, maxWords = 100, maxChars = 2000) {
  const words = String(value || '').trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  return words.slice(0, maxWords).join(' ').slice(0, maxChars).trim();
}

export function captureSize(rect, streamWidth, streamHeight, viewportWidth, viewportHeight) {
  if (!rect || rect.width < 2 || rect.height < 2) throw new Error('The media player is not visible enough to record.');
  const scaleX = streamWidth / Math.max(1, viewportWidth);
  const scaleY = streamHeight / Math.max(1, viewportHeight);
  const source = {
    x: Math.max(0, Math.round(rect.x * scaleX)),
    y: Math.max(0, Math.round(rect.y * scaleY)),
    width: Math.max(2, Math.min(streamWidth, Math.round(rect.width * scaleX))),
    height: Math.max(2, Math.min(streamHeight, Math.round(rect.height * scaleY)))
  };
  source.width = Math.min(source.width, streamWidth - source.x);
  source.height = Math.min(source.height, streamHeight - source.y);
  const outputHeight = Math.max(2, Math.min(240, Math.round(source.height)));
  const outputWidth = Math.max(2, Math.round(outputHeight * source.width / source.height));
  return { source, output: { width: even(outputWidth), height: even(outputHeight) } };
}

export function isCurrentCapture(job, jobId, tabId, statuses) {
  return Boolean(job && job.id === jobId && job.tabId === tabId && statuses.includes(job.status));
}

export function offscreenStartMessage(streamId, job, token) {
  if (!streamId || !job?.id || !token) throw new Error('The recorder needs a stream, job and local session.');
  return { type: 'ANNOTATED_OFFSCREEN_START', streamId, job, token };
}

export function publicationIdentity(pending, payload, createId = () => crypto.randomUUID()) {
  const fingerprint = JSON.stringify(payload);
  if (pending?.fingerprint === fingerprint) return pending;
  return { fingerprint, clientId: createId() };
}

export function randomPkceVerifier(randomValues = (bytes) => crypto.getRandomValues(bytes)) {
  return base64Url(randomValues(new Uint8Array(32)));
}

export async function pkceChallenge(verifier, digest = (bytes) => crypto.subtle.digest('SHA-256', bytes)) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new Error('The sign-in verifier is invalid.');
  return base64Url(new Uint8Array(await digest(new TextEncoder().encode(verifier))));
}

export function oauthCallbackCode(callbackUrl, expectedRedirectUrl) {
  let callback;
  let expected;
  try {
    callback = new URL(callbackUrl);
    expected = new URL(expectedRedirectUrl);
  } catch {
    throw new Error('The sign-in callback URL is invalid.');
  }
  if (expected.protocol !== 'https:' || !expected.hostname.endsWith('.chromiumapp.org')) {
    throw new Error('The extension redirect URL is invalid.');
  }
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.hash) {
    throw new Error('The sign-in callback did not match this extension.');
  }
  const providerError = callback.searchParams.get('error');
  if (providerError) throw new Error('Google sign-in was cancelled or declined.');
  const codes = callback.searchParams.getAll('code');
  if (codes.length !== 1 || !codes[0]) throw new Error('The sign-in callback did not include a valid code.');
  return codes[0];
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function even(value) {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}
