function assertActive(signal) {
  if (signal?.aborted) throw new DOMException('The upload was cancelled.', 'AbortError');
}

async function postMedia(url, { token, body, contentType, role, signal, onUnauthorized, fetchImpl }) {
  assertActive(signal);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
      ...(role ? { 'X-Media-Role': role } : {})
    },
    body,
    signal
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) await onUnauthorized?.();
  if (!response.ok) throw new Error(payload.error || `The media upload failed (${response.status}).`);
  return payload;
}

export async function uploadMedia({ apiOrigin, mediaStorage, token, role, blob, signal, onUnauthorized, fetchImpl = fetch, putBlob }) {
  if (!token || !blob || !Number.isFinite(blob.size) || blob.size <= 0) throw new Error('A signed-in, nonempty recording is required.');
  const contentType = blob.type || (role === 'source-video' ? 'video/webm' : 'audio/webm');
  if (mediaStorage !== 'blob') {
    return postMedia(`${apiOrigin}/api/media`, { token, body: blob, contentType, role, signal, onUnauthorized, fetchImpl });
  }

  const reservation = await postMedia(`${apiOrigin}/api/media/uploads`, {
    token,
    body: JSON.stringify({ role, contentType, size: blob.size }),
    contentType: 'application/json',
    signal,
    onUnauthorized,
    fetchImpl
  });
  if (!reservation.id || !reservation.pathname || !reservation.clientToken || !reservation.contentType) {
    throw new Error('The media upload reservation was incomplete.');
  }
  assertActive(signal);
  try {
    const put = putBlob || (await import('./blob-client.mjs')).put;
    await put(reservation.pathname, blob, {
      access: 'private',
      token: reservation.clientToken,
      contentType: reservation.contentType,
      abortSignal: signal,
      multipart: false
    });
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error;
    throw new Error('The media upload could not be completed. Try again.');
  }
  assertActive(signal);
  return postMedia(`${apiOrigin}/api/media/uploads/${encodeURIComponent(reservation.id)}/complete`, {
    token,
    body: '{}',
    contentType: 'application/json',
    signal,
    onUnauthorized,
    fetchImpl
  });
}
