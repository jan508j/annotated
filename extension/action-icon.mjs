export const ICON_HUES = ['coral', 'citrus', 'mint', 'sky', 'lilac'];

export function iconPaths(hue = 'citrus') {
  const name = Number.isInteger(hue) ? ICON_HUES[hue] : hue;
  const directory = [...ICON_HUES, 'recording'].includes(name) ? name : 'citrus';
  return Object.fromEntries([16, 32, 48, 128].map(size => [size, `icons/${directory}/icon-${size}.png`]));
}

// Icon updates are ordered, best-effort presentation; they never hold up capture.
// Progress events reuse the same icon instead of decoding PNGs every frame.
export function createActionIconUpdater() {
  const requested = new Map();
  let tail = Promise.resolve();
  return (tabId, hue) => {
    if (!Number.isInteger(tabId) || tabId < 0) return Promise.resolve();
    const path = iconPaths(hue);
    const key = path[16];
    if (requested.get(tabId) === key) return tail;
    requested.set(tabId, key);
    tail = tail.then(() => chrome.action.setIcon({ tabId, path })).catch(() => {
      // A closed tab or an unavailable action must not break the draft/recorder.
      if (requested.get(tabId) === key) requested.delete(tabId);
    });
    return tail;
  };
}
