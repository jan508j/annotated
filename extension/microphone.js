function stopTracks(stream) {
  for (const track of stream.getTracks()) track.stop();
}

function problemFor(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return {
        status: 'Microphone access was not granted.',
        help: 'In Chrome, open Settings → Privacy and security → Site settings → Microphone, and allow this extension if it is blocked. On a Mac, also check System Settings → Privacy & Security → Microphone for Google Chrome. Then try again.'
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        status: 'Chrome could not find a microphone.',
        help: 'Connect or enable a microphone, then check the selected device in Chrome Settings → Privacy and security → Site settings → Microphone.'
      };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return {
        status: 'Chrome could not start the microphone.',
        help: 'Check that the microphone is connected and available to Chrome. On a Mac, check System Settings → Privacy & Security → Microphone for Google Chrome, then try again.'
      };
    default:
      return {
        status: 'Microphone setup could not finish.',
        help: 'Check Chrome Settings → Privacy and security → Site settings → Microphone and your computer’s microphone settings, then try again.'
      };
  }
}

export function createMicrophoneSetup({ document, window, navigator, chrome }) {
  const enable = document.getElementById('enable-microphone');
  const returnButton = document.getElementById('return-to-source');
  const status = document.getElementById('microphone-status');
  const help = document.getElementById('microphone-help');
  const params = new URLSearchParams(window.location?.search || '');
  const sourceParam = params.get('sourceTab');
  const sourceTab = /^\d+$/.test(sourceParam || '') && Number.isSafeInteger(Number(sourceParam)) ? Number(sourceParam) : null;
  const returnAfterGrant = params.get('returnAfterGrant') === '1';
  let requestId = 0;
  let disposed = false;
  let permissionGranted = false;

  function show(message, guidance = '', isError = false) {
    status.textContent = message;
    status.classList.remove('hidden');
    status.classList.toggle('error', isError);
    help.textContent = guidance;
    help.classList.toggle('hidden', !guidance);
  }

  async function request() {
    if (disposed || enable.disabled) return;
    const id = ++requestId;
    enable.disabled = true;
    show('Waiting for Chrome’s microphone permission…');
    try {
      if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
        throw new TypeError('Microphone access is unavailable');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stopTracks(stream);
      if (disposed || id !== requestId) return;
      permissionGranted = true;
      show('Microphone access is allowed. The microphone is off.', 'Return to your source and click the microphone beside your take. Keep this tab open if you chose “Allow this time”; closing it can end temporary permission.');
      enable.classList.add('hidden');
      returnButton.textContent = 'Return to source';
      if (returnAfterGrant && sourceTab !== null) await returnToSource();
    } catch (error) {
      if (disposed || id !== requestId) return;
      const problem = problemFor(error);
      show(problem.status, problem.help, true);
      enable.disabled = false;
      enable.textContent = 'Try again';
    }
  }

  function dispose() {
    disposed = true;
    ++requestId;
  }

  async function returnToSource() {
    dispose();
    try {
      const current = await chrome.tabs.getCurrent();
      const id = sourceTab ?? current?.openerTabId;
      if (!Number.isInteger(id) || id < 0) throw new Error('No source tab');
      const source = await chrome.tabs.get(id);
      await chrome.tabs.update(source.id, { active: true });
      if (Number.isInteger(source.windowId)) await chrome.windows.update(source.windowId, { focused: true });
      // Keep the permission origin open: Chrome can revoke an "Allow this
      // time" grant when its last tab closes. This page holds no audio tracks.
      if (!permissionGranted && Number.isInteger(current.id)) await chrome.tabs.remove(current.id);
    } catch {
      show('Switch back to your source tab to continue.', permissionGranted
        ? 'Keep this tab open if you chose “Allow this time”, then click the microphone beside your take.'
        : 'You can close this permission tab.', false);
    }
  }

  enable.addEventListener('click', request);
  returnButton.addEventListener('click', returnToSource);
  window.addEventListener('pagehide', dispose);
  return { request, dispose, returnToSource };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  createMicrophoneSetup({ document, window, navigator, chrome });
}
