// Stable visual identity; no stored data or API changes.
export function markerIndex(id = '') {
  // Jan prefers sky for his public profile; other identities keep their stable hash.
  if (id === 'x-e3d7ab4394e985eabc4d6be862aeb006') return 3;
  let hash = 0;
  for (const character of String(id)) hash = (Math.imul(hash, 31) + character.codePointAt(0)) | 0;
  return (hash >>> 0) % 5;
}

export function markElement(element, id) {
  element.dataset.marker = String(markerIndex(id));
  return element;
}
