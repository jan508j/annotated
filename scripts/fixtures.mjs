import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('../web/fixtures/', import.meta.url));
mkdirSync(directory, { recursive: true });
function generate(name, args) {
  const target = `${directory}${name}`;
  if (existsSync(target) && !process.argv.includes('--force')) return console.log(`Fixture exists: ${name}`);
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, target], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'FFmpeg is required to generate fixtures.');
  console.log(`Generated original fixture: ${name}`);
}
generate('timing.mp4', ['-f','lavfi','-i','testsrc=size=960x540:rate=30:duration=95','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=95','-filter:a',"volume=0.02",'-c:v','libx264','-preset','ultrafast','-crf','28','-pix_fmt','yuv420p','-c:a','aac','-b:a','96k','-movflags','+faststart','-shortest']);
generate('timing.wav', ['-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=95','-filter:a','volume=0.04','-c:a','pcm_s16le']);
