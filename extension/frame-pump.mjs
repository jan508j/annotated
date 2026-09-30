// Offscreen documents are hidden, so requestAnimationFrame may never run.
export function startFramePump({ canvas, video, source, track, onError, timers = globalThis }) {
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const draw = () => {
    context.drawImage(video, source.x, source.y, source.width, source.height, 0, 0, canvas.width, canvas.height);
    track.requestFrame?.();
  };
  draw();
  const interval = timers.setInterval(() => {
    try { draw(); }
    catch (error) {
      timers.clearInterval(interval);
      onError(error);
    }
  }, 1000 / 30);
  return () => timers.clearInterval(interval);
}
