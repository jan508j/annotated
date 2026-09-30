const TEXT_LIMIT = 2000;
const STOP_GRACE_MS = 1500;
const START_TIMEOUT_MS = 15_000;

const ERROR_MESSAGES = {
  'audio-capture': 'Chrome could not access a microphone. Check your input device and microphone permissions.',
  network: 'Speech recognition lost its network connection. Try again when Chrome is online.',
  'no-speech': 'No speech was detected. Check Chrome’s selected microphone, then try speaking closer to it.',
  'no-match': 'Chrome heard audio but could not recognize the words. Check the dictation language and selected microphone, then try again.',
  'no-transcript': 'Dictation ended without final text. Check the dictation language and Chrome’s selected microphone, then try again.',
  'start-timeout': 'Chrome did not start dictation. Check microphone access and your connection, then click the microphone to try again.',
  'language-not-supported': 'Speech recognition is unavailable for the selected language.',
  'not-allowed': 'Allow microphone access in Chrome to dictate commentary.',
  'service-not-allowed': 'Chrome did not allow this speech recognition service.'
};

function insertAtCaret(textarea, spoken) {
  const value = String(textarea.value ?? '');
  const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : value.length;
  const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : start;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const words = spoken.trim();
  if (!words) return false;

  const prefix = before && !/(?:\s|[([{])$/.test(before) ? ' ' : '';
  const suffix = after && !/^[\s.,!?;:)\]}]/.test(after) ? ' ' : '';
  const insertion = `${prefix}${words}${suffix}`;
  const maxLength = textarea.maxLength > 0 ? Math.min(TEXT_LIMIT, textarea.maxLength) : TEXT_LIMIT;
  const available = Math.max(0, maxLength - before.length - after.length);
  const accepted = insertion.slice(0, available);
  const truncated = accepted.length < insertion.length;

  if (accepted.trim()) {
    textarea.value = before + accepted + after;
    const caret = before.length + accepted.length;
    textarea.setSelectionRange?.(caret, caret);
    textarea.dispatchEvent?.(new Event('input', { bubbles: true }));
  }
  return truncated;
}

export function createDictation({
  Recognition,
  textarea,
  onState = () => {},
  onError = () => {},
  onPermissionNeeded = () => {},
  lang = 'en-US',
  maxDurationMs = 90_000,
  startTimeoutMs = START_TIMEOUT_MS
}) {
  let session = null;
  let generation = 0;

  function report(status, interim = '') {
    onState({ status, interim });
  }

  function clearSession(current) {
    if (session !== current) return;
    clearTimeout(current.durationTimer);
    clearTimeout(current.stopTimer);
    clearTimeout(current.startTimer);
    session = null;
    generation += 1;
    report('idle');
  }

  function finish(current) {
    if (session !== current) return;
    const needsFeedback = !current.hadFinalTranscript && !current.feedbackProvided;
    clearSession(current);
    if (needsFeedback) onError({ code: 'no-transcript', message: ERROR_MESSAGES['no-transcript'] });
  }

  function fail(error, current) {
    if (session !== current) return;
    const rawCode = typeof error === 'string' ? error : error?.error || error?.name || 'unknown';
    const code = rawCode === 'NotAllowedError' || rawCode === 'PermissionDeniedError' ? 'not-allowed'
      : rawCode === 'Error' ? 'start-failed' : rawCode;
    const message = ERROR_MESSAGES[code] || 'Speech recognition stopped unexpectedly. Try again.';
    clearSession(current);
    try { current.recognition.abort(); } catch { /* The service has already stopped. */ }
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      onPermissionNeeded({ code, message });
    } else {
      onError({ code, message });
    }
  }

  function start() {
    if (session) return false;
    if (typeof Recognition !== 'function') {
      onError({ code: 'unsupported', message: 'Speech recognition is unavailable in this browser.' });
      return false;
    }

    let recognition;
    try {
      recognition = new Recognition();
      recognition.lang = typeof lang === 'function' ? lang() : lang;
      recognition.continuous = true;
      recognition.interimResults = true;
    } catch (error) {
      onError({ code: 'start-failed', message: error?.message || 'Speech recognition could not start.' });
      return false;
    }

    const current = {
      recognition, generation: ++generation, committed: new Set(),
      started: false, hadFinalTranscript: false, feedbackProvided: false,
      durationTimer: null, stopTimer: null, startTimer: null
    };
    session = current;
    recognition.onstart = () => {
      if (session !== current || current.generation !== generation) return;
      current.started = true;
      clearTimeout(current.startTimer);
      report('listening');
    };
    recognition.onresult = (event) => {
      if (session !== current || current.generation !== generation) return;
      current.started = true;
      clearTimeout(current.startTimer);
      const interim = [];
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript || '';
        if (result?.isFinal) {
          if (current.committed.has(index)) continue;
          current.committed.add(index);
          if (transcript.trim()) current.hadFinalTranscript = true;
          if (insertAtCaret(textarea, transcript)) {
            onError({ code: 'max-length', message: 'Commentary reached its 2,000-character limit.' });
            if (session !== current) return;
          }
        } else if (transcript.trim()) {
          interim.push(transcript.trim());
        }
      }
      if (session === current) report(current.stopTimer ? 'stopping' : 'listening', interim.join(' '));
    };
    recognition.onerror = (event) => fail(event, current);
    recognition.onnomatch = () => fail('no-match', current);
    recognition.onend = () => finish(current);

    report('starting');
    try {
      recognition.start();
      if (session === current) {
        if (!current.started) {
          current.startTimer = setTimeout(() => fail('start-timeout', current), Math.max(1, startTimeoutMs));
          current.startTimer.unref?.();
        }
        current.durationTimer = setTimeout(() => {
          if (session !== current) return;
          current.feedbackProvided = true;
          onError({ code: 'time-limit', message: 'Dictation reached the 90-second limit.' });
          stop();
        }, Math.max(1, maxDurationMs));
        current.durationTimer.unref?.();
      }
      return true;
    } catch (error) {
      fail({ error: error?.name || 'start-failed' }, current);
      return false;
    }
  }

  function stop() {
    if (!session || session.stopTimer) return false;
    const current = session;
    clearTimeout(current.durationTimer);
    clearTimeout(current.startTimer);
    report('stopping');
    try {
      current.recognition.stop();
    } catch (error) {
      fail({ error: error?.name === 'NotAllowedError' ? error.name : 'stop-failed' }, current);
      return false;
    }
    if (session === current) {
      current.stopTimer = setTimeout(() => {
        if (session !== current) return;
        finish(current);
        try { current.recognition.abort(); } catch { /* The service has already stopped. */ }
      }, STOP_GRACE_MS);
      current.stopTimer.unref?.();
    }
    return true;
  }

  function abort() {
    if (!session) return false;
    const current = session;
    clearSession(current);
    try { current.recognition.abort(); } catch { /* The service has already stopped. */ }
    return true;
  }

  return {
    supported: typeof Recognition === 'function',
    get active() { return session !== null; },
    start,
    stop,
    abort
  };
}
