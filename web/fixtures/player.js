const media = document.querySelector('video, audio');
const output = document.querySelector('#time');
media.addEventListener('timeupdate', () => {
  const time = media.currentTime;
  output.textContent = `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2,'0')}.${String(Math.floor(time % 1 * 1000)).padStart(3,'0')}`;
});
document.querySelectorAll('[data-seek]').forEach(button => button.addEventListener('click', () => { media.currentTime = Number(button.dataset.seek); }));
document.querySelector('#theater')?.addEventListener('click', () => {
  const main = document.querySelector('main');
  main.style.maxWidth = main.style.maxWidth ? '' : '1200px';
});
document.querySelector('#secondary')?.addEventListener('click', (event) => {
  const extra = document.createElement('audio');extra.controls=true;extra.src='timing.wav';
  document.querySelector('#secondary-player').append(extra);event.target.disabled=true;
});
