import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { stat } from 'node:fs/promises';

const require = createRequire(import.meta.url);
export const MAX_MEDIA_BYTES = 30 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 12 * 1024 * 1024;
const MAX_SECONDS = 90;
const INPUT_PADDING_SECONDS = 0.02;
const INPUT_FLAGS = ['-protocol_whitelist', 'file,pipe', '-protocol_blacklist', 'http,https,tcp,tls,udp,rtp,ftp', '-format_whitelist', 'mov,matroska,webm,wav,ogg,mp3,aac'];

export class MediaError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function mediaType(role) {
  if (role === 'source-video') return { extension: '.mp4', contentType: 'video/mp4', kind: 'video' };
  if (role === 'source-audio' || role === 'voice') return { extension: '.m4a', contentType: 'audio/mp4', kind: 'audio' };
  throw new MediaError(400, 'Choose a source clip or voice commentary.');
}

export function mediaBinary(name) {
  const override = process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'];
  if (override) return override;
  if (!process.env.VERCEL) return name;
  return name === 'ffmpeg' ? require('ffmpeg-static') : require('ffprobe-static').path;
}

export function runMedia(name, args, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(mediaBinary(name), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= 1024 * 1024) output.push(chunk);
      else child.kill('SIGKILL');
    });
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); reject(new MediaError(503, 'Media processing is unavailable.')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(output).toString('utf8'));
      else reject(new MediaError(422, 'This recording could not be processed. Please record it again.'));
    });
  });
}

export async function probeMedia(file) {
  const output = await runMedia('ffprobe', ['-v', 'error', ...INPUT_FLAGS, '-show_entries', 'format=duration:stream=codec_type,width,height,duration', '-of', 'json', file], 15_000);
  let result;
  try { result = JSON.parse(output); } catch { throw new MediaError(422, 'The recording is not valid media.'); }
  const streams = Array.isArray(result.streams) ? result.streams : [];
  const durations = [result.format?.duration, ...streams.map(s => s.duration)].map(Number).filter(Number.isFinite);
  const duration = durations.length ? Math.max(...durations) : await packetDuration(file);
  if (!Number.isFinite(duration) || duration <= 0) throw new MediaError(422, 'The recording has no measurable duration.');
  const video = streams.find(s => s.codec_type === 'video');
  return { duration, width: video?.width ?? null, height: video?.height ?? null, hasVideo: Boolean(video), hasAudio: streams.some(s => s.codec_type === 'audio') };
}

async function packetDuration(file, videoOnly = false) {
  // MediaRecorder's streaming WebM often has no header duration. ffprobe still
  // reports timestamps for its recorded packets. runMedia bounds
  // this scan to 15 seconds and 1 MiB of output.
  const output = await runMedia('ffprobe', ['-v', 'error', ...INPUT_FLAGS, ...(videoOnly ? ['-select_streams', 'v:0'] : []), '-show_packets', '-show_entries', 'packet=pts_time,dts_time,duration_time', '-of', 'compact=p=0:nk=0', file], 15_000);
  let start = Infinity;
  let end = -Infinity;
  let firstTimestamp = null;
  let multipleTimestamps = false;
  let positiveDuration = false;
  for (const line of output.split('\n')) {
    const fields = Object.fromEntries([...line.matchAll(/(?:^|\|)(pts_time|dts_time|duration_time)=([^|]*)/g)].map((match) => [match[1], match[2]]));
    const pts = Number(fields.pts_time);
    const timestamp = Number.isFinite(pts) ? pts : Number(fields.dts_time);
    if (!Number.isFinite(timestamp)) continue;
    if (firstTimestamp === null) firstTimestamp = timestamp;
    else if (timestamp !== firstTimestamp) multipleTimestamps = true;
    start = Math.min(start, timestamp);
    const duration = Number(fields.duration_time);
    if (Number.isFinite(duration) && duration > 0) positiveDuration = true;
    end = Math.max(end, timestamp + (Number.isFinite(duration) && duration > 0 ? duration : 0));
  }
  return positiveDuration || multipleTimestamps ? end - Math.max(0, start) : NaN;
}

async function assertVideoCoverage(file, duration) {
  // Audio can keep a container alive after canvas capture has produced just one frame.
  const videoDuration = await packetDuration(file, true);
  if (!Number.isFinite(videoDuration) || videoDuration + Math.max(0.2, duration * 0.1) < duration) {
    throw new MediaError(422, 'The recording has too few video frames for its duration. Please record it again.');
  }
}

export async function processMediaFile(role, input, output) {
  const target = mediaType(role);
  const before = await probeMedia(input);
  if (before.duration > MAX_SECONDS + INPUT_PADDING_SECONDS) throw new MediaError(422, 'Media clips must be 90 seconds or shorter.');
  if (target.kind === 'video' && (!before.hasVideo || before.width > 4096 || before.height > 4096)) throw new MediaError(422, 'Use a video recording no larger than 4096 pixels per side.');
  if (target.kind === 'audio' && (!before.hasAudio || before.hasVideo)) throw new MediaError(422, 'Audio and voice recordings must contain only audio.');
  if (target.kind === 'video') await assertVideoCoverage(input, before.duration);
  const args = ['-v', 'error', '-nostdin', '-threads', '1', ...INPUT_FLAGS, '-i', input, '-t', String(MAX_SECONDS - INPUT_PADDING_SECONDS)];
  if (target.kind === 'video') {
    // Chrome's variable-frame WebM can report a 1000 fps rate from millisecond timestamps.
    args.push('-map', '0:v:0', '-map', '0:a:0?', '-vf', "fps=30,scale='trunc(iw*min(1,240/ih)/2)*2':'trunc(ih*min(1,240/ih)/2)*2'", '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-crf', '25', '-maxrate', '850k', '-bufsize', '1700k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k');
  } else args.push('-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', role === 'voice' ? '48k' : '80k');
  await runMedia('ffmpeg', [...args, '-movflags', '+faststart', output]);
  const after = await probeMedia(output);
  if (target.kind === 'video') await assertVideoCoverage(output, after.duration);
  const bytes = (await stat(output)).size;
  if (after.duration > MAX_SECONDS || (target.kind === 'video' && after.height > 240) || bytes > MAX_OUTPUT_BYTES) throw new MediaError(422, 'The processed recording exceeds the publishing limits.');
  return { ...after, bytes, ...target };
}
