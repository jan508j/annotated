import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_OUTPUT_BYTES, probeMedia, processMediaFile, runMedia } from '../server/media-processing.mjs';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const bundledFfmpeg = require('ffmpeg-static');
const bundledFfprobe = require('ffprobe-static').path;

async function liveWebm(file, { video = false, seconds = 2 } = {}) {
  const input = video
    ? ['-f', 'lavfi', '-i', 'testsrc2=size=320x270:rate=15', '-c:v', 'libvpx', '-b:v', '250k']
    : ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-c:a', 'libopus', '-b:a', '24k'];
  const { stdout } = await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...input,
    '-t', String(seconds), '-f', 'webm', '-live', '1', 'pipe:1'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
  await writeFile(file, stdout);
}

async function liveAudioVideoWebm(file, seconds) {
  const { stdout } = await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(seconds), '-c:v', 'libvpx', '-b:v', '200k',
    '-c:a', 'libopus', '-b:a', '24k', '-f', 'webm', '-live', '1', 'pipe:1'],
  { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
  await writeFile(file, stdout);
}

test('streaming WebM without header duration is measured from packets and normalized', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annotated-live-webm-'));
  try {
    const input = join(dir, 'recording.webm');
    const output = join(dir, 'recording.mp4');
    await liveWebm(input, { video: true });
    const header = JSON.parse(await runMedia('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=duration', '-of', 'json', input]));
    assert.equal(header.format?.duration, undefined, 'fixture has no container duration');
    assert.ok(header.streams?.every((stream) => !stream.duration), 'fixture has no stream duration');
    const before = await probeMedia(input);
    assert.ok(before.duration > 1.8 && before.duration < 2.1);
    assert.equal(before.hasVideo, true);
    const after = await processMediaFile('source-video', input, output);
    assert.ok(after.duration > 0 && after.duration <= 90);
    assert.ok(after.height <= 240);
    assert.ok((await stat(output)).size <= MAX_OUTPUT_BYTES);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('packet-measured streaming WebM over 90 seconds is rejected before normalization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annotated-long-webm-'));
  try {
    const input = join(dir, 'long.webm');
    const output = join(dir, 'long.m4a');
    await liveWebm(input, { seconds: 90.5 });
    assert.ok((await probeMedia(input)).duration > 90.02);
    await assert.rejects(processMediaFile('source-audio', input, output), /90 seconds or shorter/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a 90 second 30 fps video with Opus stays within the bounded packet scan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annotated-boundary-webm-'));
  try {
    const input = join(dir, 'boundary.webm');
    await liveAudioVideoWebm(input, 90);
    const packets = await runMedia('ffprobe', ['-v', 'error', '-show_packets',
      '-show_entries', 'packet=pts_time,dts_time,duration_time', '-of', 'compact=p=0:nk=0', input], 15_000);
    assert.ok(Buffer.byteLength(packets) < 1024 * 1024);
    const before = await probeMedia(input);
    assert.ok(before.duration > 89.9 && before.duration <= 90.02);
    assert.equal(before.hasAudio, true);
    assert.equal(before.hasVideo, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('variable-frame streaming WebM with a 1000 fps reported rate normalizes before packet validation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annotated-variable-webm-'));
  try {
    const input = join(dir, 'variable.webm');
    const output = join(dir, 'normalized.mp4');
    await exec(bundledFfmpeg, ['-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=1000:duration=37',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=37',
      '-map', '0:v:0', '-map', '1:a:0',
      '-vf', "select='eq(mod(n,101),0)+eq(mod(n,101),17)+eq(mod(n,101),65)'",
      '-fps_mode', 'passthrough', '-c:v', 'libvpx', '-b:v', '100k',
      '-c:a', 'libopus', '-b:a', '16k', '-f', 'webm', '-live', '1', input]);
    const { stdout: inputProbe } = await exec(bundledFfprobe, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate', '-of', 'json', input]);
    assert.equal(JSON.parse(inputProbe).streams[0].r_frame_rate, '1000/1');
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e',
      "import { processMediaFile } from './server/media-processing.mjs'; console.log(JSON.stringify(await processMediaFile('source-video', process.argv[1], process.argv[2])));",
      input, output], { env: { ...process.env, FFMPEG_PATH: bundledFfmpeg, FFPROBE_PATH: bundledFfprobe } });
    const normalized = JSON.parse(stdout);
    assert.ok(normalized.duration > 36.9 && normalized.duration <= 37.1);
    assert.ok(normalized.height <= 240);
    assert.ok(normalized.bytes <= MAX_OUTPUT_BYTES);
    const { stdout: outputProbe } = await exec(bundledFfprobe, ['-v', 'error', '-select_streams', 'v:0',
      '-count_packets', '-show_entries', 'stream=nb_read_packets,r_frame_rate', '-of', 'json', output]);
    const video = JSON.parse(outputProbe).streams[0];
    assert.equal(video.r_frame_rate, '30/1');
    assert.ok(Number(video.nb_read_packets) <= 30 * normalized.duration + 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('empty and malformed recordings still fail validation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annotated-invalid-webm-'));
  try {
    const empty = join(dir, 'empty.webm');
    const malformed = join(dir, 'malformed.webm');
    await writeFile(empty, Buffer.alloc(0));
    await writeFile(malformed, Buffer.from('not media'));
    await assert.rejects(probeMedia(empty), { status: 422 });
    await assert.rejects(probeMedia(malformed), { status: 422 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('audio cannot conceal a video track containing only one frame', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annotated-one-frame-'));
  try {
    const input = join(dir, 'frozen.webm');
    const output = join(dir, 'frozen.mp4');
    const frame = join(dir, 'frame.webm');
    const audio = join(dir, 'audio.webm');
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=size=320x180:rate=15:duration=0.067',
      '-frames:v', '1', '-c:v', 'libvpx', frame]);
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-c:a', 'libopus', audio]);
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-i', frame, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', input]);
    const probe = await probeMedia(input);
    assert.ok(probe.duration > 2.9);
    assert.equal(probe.hasVideo, true);
    assert.equal(probe.hasAudio, true);
    await assert.rejects(processMediaFile('source-video', input, output), /too few video frames/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unchanging picture remains valid when video frames span its duration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annotated-static-video-'));
  try {
    const input = join(dir, 'static.webm');
    const output = join(dir, 'static.mp4');
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=size=320x180:rate=15:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libvpx', '-c:a', 'libopus', input]);
    const result = await processMediaFile('source-video', input, output);
    assert.ok(result.duration > 1.9);
    assert.ok(result.height <= 240);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
