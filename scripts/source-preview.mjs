// Original, silent test graphics for a redistributable source-code demonstration.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = `${root}web/media/`;
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'annotated-preview-'));
const label = join(temp, 'label.png');
GlobalFonts.registerFromPath(`${root}extension/fonts/instrument-sans.ttf`, 'Instrument Sans');
const canvas = createCanvas(640, 360), context = canvas.getContext('2d');
context.fillStyle = '#16161a';
context.fillRect(0, 0, 640, 76);
context.fillStyle = '#ffffff';
context.font = '22px "Instrument Sans"';
context.textAlign = 'center';
context.fillText('ANNOTATED - GENERATED TEST FOOTAGE', 320, 45);
writeFileSync(label, canvas.toBuffer('image/png'));
function run(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'Install FFmpeg with H.264 and VP9 support.');
}
try {
const source = ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=8', '-loop', '1', '-i', label, '-filter_complex', '[0:v][1:v]overlay=0:0:shortest=1', '-t', '8', '-an'];
run([...source, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${output}marker-preview.mp4`]);
run([...source, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38', '-row-mt', '1', `${output}marker-preview.webm`]);
run(['-i', `${output}marker-preview.mp4`, '-frames:v', '1', '-update', '1', `${output}marker-poster.jpg`]);
console.log('Generated original 8-second home preview in web/media/.');
} finally { rmSync(temp, { recursive: true, force: true }); }
