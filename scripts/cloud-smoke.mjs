import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { del } from '@vercel/blob';
import { put } from '@vercel/blob/client';
import { createServer } from '../server/index.mjs';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = join(ROOT, 'artifacts', 'cloud-qa');
const HOST = 'annotated-smoke.example.test';
const ORIGIN = `https://${HOST}`;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in ignored local environment.`);
  return value;
}

async function request(base, path, { method = 'GET', headers = {}, json, body } = {}) {
  const payload = json === undefined ? body : Buffer.from(JSON.stringify(json));
  const response = await new Promise((resolve, reject) => {
    const call = http.request(new URL(path, base), {
      method,
      headers: { Host: HOST, ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    }, result => {
      const chunks = [];
      result.on('data', chunk => chunks.push(chunk));
      result.on('end', () => resolve({ status: result.statusCode, headers: result.headers, bytes: Buffer.concat(chunks) }));
    });
    call.on('error', reject);
    call.end(payload);
  });
  response.json = () => JSON.parse(response.bytes.toString('utf8'));
  return response;
}

function status(response, expected, stage) {
  assert.equal(response.status, expected, `${stage}: HTTP ${response.status}, expected ${expected}`);
}

async function probe(path) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,width,height', '-of', 'json', path], { timeout: 20_000 });
  const result = JSON.parse(stdout);
  const video = result.streams.find(stream => stream.width && stream.height);
  return { duration: Number(result.format.duration), bytes: Number(result.format.size), codec: video?.codec_name || result.streams[0]?.codec_name, width: video?.width ?? null, height: video?.height ?? null };
}

async function main() {
  const direct = new URL(required('DATABASE_URL_UNPOOLED'));
  assert.match(direct.protocol, /^postgres(?:ql)?:$/);
  assert.ok(!direct.hostname.includes('-pooler'), 'Temporary schema requires a direct Neon connection.');
  assert.ok(!direct.searchParams.has('options'), 'Database URL already sets session options.');
  const blobToken = required('BLOB_READ_WRITE_TOKEN');
  const schema = `cloud_smoke_${randomBytes(8).toString('hex')}`;
  const dataDir = await mkdtemp(join(tmpdir(), 'annotated-cloud-smoke-'));
  const admin = new Client({ connectionString: direct.toString() });
  const paths = new Set();
  let server;
  let schemaCreated = false;
  let stage = 'connect';
  const evidence = { date: new Date().toISOString(), status: 'running', stages: {}, cleanup: {} };
  try {
    await admin.connect();
    stage = 'create-schema';
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const scoped = new URL(direct);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    const verification = new Client({ connectionString: scoped.toString() });
    try {
      await verification.connect();
      const result = await verification.query('SELECT current_schema() AS name');
      assert.equal(result.rows[0].name, schema, 'Application connection must stay in its isolated schema.');
    } finally { await verification.end().catch(() => {}); }

    stage = 'start-server';
    server = createServer({
      mode: 'production', baseUrl: ORIGIN, host: '127.0.0.1', dataDir,
      databaseUrl: scoped.toString(), mediaStorage: 'blob', blobToken,
      cronSecret: 'smoke-only-cron-secret-000000000000000000000',
      googleClientId: 'smoke-only.apps.googleusercontent.com', googleClientSecret: 'smoke-only-secret',
      extensionIds: ['abcdefghijklmnopabcdefghijklmnop'], adminEmails: ['smoke-only@example.test'],
      googleProvider: {
        authorizationUrl({ state, nonce }) { return `https://accounts.example.test/authorize?state=${encodeURIComponent(state)}&nonce=${encodeURIComponent(nonce)}`; },
        async authenticate({ nonce }) { return { subject: `smoke-${schema}`, email: 'smoke-only@example.test', emailVerified: true, name: 'Cloud Smoke Test', nonce }; },
      },
      seed: false,
    });
    await server.ready;
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await request(base, '/api/health');
    status(health, 200, stage);
    assert.equal(health.json().mode, 'production');
    evidence.stages.server = 'production config on loopback, isolated Neon schema';

    stage = 'test-auth';
    const begin = await request(base, '/auth/google/start');
    status(begin, 302, stage);
    const auth = new URL(begin.headers.location);
    const oauthCookie = begin.headers['set-cookie'].find(value => value.startsWith('annotated_oauth=')).split(';')[0];
    const callback = await request(base, `/auth/google/callback?state=${encodeURIComponent(auth.searchParams.get('state'))}&code=smoke-only-code`, { headers: { Cookie: oauthCookie } });
    status(callback, 302, stage);
    const sessionCookie = callback.headers['set-cookie'].find(value => value.startsWith('annotated_session=')).split(';')[0];
    const signed = { Cookie: sessionCookie, Origin: ORIGIN };
    const session = await request(base, '/api/session', { headers: signed });
    status(session, 200, stage);
    assert.equal(session.json().user.isDemo, false);
    evidence.stages.auth = 'test-only OAuth provider created a non-demo session in temporary schema';

    stage = 'generate-input';
    const videoInput = join(dataDir, 'synthetic-video.webm');
    const audioInput = join(dataDir, 'synthetic-audio.webm');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=2', '-t', '90', '-an', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '250k', videoInput], { timeout: 90_000 });
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '3', '-c:a', 'libopus', audioInput], { timeout: 30_000 });
    const inputVideo = await probe(videoInput);
    assert.ok(inputVideo.duration <= 90.02 && inputVideo.duration >= 89.9);
    evidence.input = { video: inputVideo, audio: await probe(audioInput) };

    async function upload(role, file, contentType) {
      const bytes = await readFile(file);
      const reserve = await request(base, '/api/media/uploads', { method: 'POST', headers: signed, json: { role, contentType, size: bytes.length } });
      status(reserve, 201, `${role}-reserve`);
      const reservation = reserve.json();
      assert.match(reservation.pathname, /^drafts\/media_[a-f0-9]{32}\.upload$/);
      paths.add(reservation.pathname);
      paths.add(`media/${reservation.id}${role === 'source-video' ? '.mp4' : '.m4a'}`);
      await put(reservation.pathname, new Blob([bytes], { type: contentType }), {
        access: 'private', token: reservation.clientToken, contentType, multipart: false,
      });
      const complete = await request(base, `/api/media/uploads/${reservation.id}/complete`, { method: 'POST', headers: signed, json: {} });
      status(complete, 201, `${role}-complete`);
      assert.equal(complete.json().id, reservation.id);
      return complete.json();
    }

    stage = 'video-upload';
    const video = await upload('source-video', videoInput, 'video/webm');
    const anonymousDraft = await request(base, video.url);
    status(anonymousDraft, 404, 'anonymous-draft-video');
    const ownerDraft = await request(base, video.url, { headers: signed });
    status(ownerDraft, 200, 'owner-draft-video');
    evidence.stages.privateBeforePublish = true;

    stage = 'voice-upload';
    const voice = await upload('voice', audioInput, 'audio/webm');
    stage = 'audio-upload';
    const audio = await upload('source-audio', audioInput, 'audio/webm');
    evidence.stages.uploads = ['source-video', 'voice', 'source-audio'];

    stage = 'publish-video';
    const publication = await request(base, '/api/annotations', { method: 'POST', headers: signed, json: {
      clientId: `cloud-smoke-${schema}-video`, source: { url: `https://example.com/cloud-smoke/${schema}/video`, title: 'Synthetic cloud smoke video', kind: 'video', author: 'Smoke fixture' },
      excerpt: '', start: 0, end: video.duration, commentary: 'Synthetic test commentary in an isolated temporary schema.', mediaId: video.id, voiceMediaId: voice.id,
    } });
    status(publication, 201, stage);
    const annotationId = publication.json().annotation.id;
    const publicVideo = await request(base, video.url);
    status(publicVideo, 200, 'public-video');
    const range = await request(base, video.url, { headers: { Range: 'bytes=0-1023' } });
    status(range, 206, 'public-video-range');
    assert.equal(range.bytes.length, 1024);
    assert.equal(range.headers['content-range'], `bytes 0-1023/${publicVideo.bytes.length}`);
    const publicVoice = await request(base, voice.url);
    status(publicVoice, 200, 'public-voice');

    stage = 'validate-output';
    await mkdir(EVIDENCE, { recursive: true });
    const videoOutput = join(EVIDENCE, 'cloud-smoke-video.mp4');
    await writeFile(videoOutput, publicVideo.bytes);
    const output = await probe(videoOutput);
    assert.equal(output.codec, 'h264');
    assert.ok(output.duration <= 90 && output.height <= 240);
    evidence.video = output;
    evidence.voice = { bytes: publicVoice.bytes.length };
    evidence.range = { status: range.status, bytes: range.bytes.length, contentRange: range.headers['content-range'] };

    stage = 'share-card';
    const card = await request(base, `/api/annotations/${annotationId}/share-card.png`);
    status(card, 200, stage);
    assert.equal(card.bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const cardPath = join(EVIDENCE, 'cloud-smoke-share-card.png');
    await writeFile(cardPath, card.bytes);
    evidence.shareCard = { bytes: card.bytes.length, width: card.bytes.readUInt32BE(16), height: card.bytes.readUInt32BE(20) };

    stage = 'publish-audio';
    const audioPublication = await request(base, '/api/annotations', { method: 'POST', headers: signed, json: {
      clientId: `cloud-smoke-${schema}-audio`, source: { url: `https://example.com/cloud-smoke/${schema}/audio`, title: 'Synthetic cloud smoke audio', kind: 'audio', author: 'Smoke fixture' },
      excerpt: '', start: 0, end: audio.duration, commentary: 'Synthetic audio test commentary.', mediaId: audio.id,
    } });
    status(audioPublication, 201, stage);
    const audioAnnotationId = audioPublication.json().annotation.id;
    status(await request(base, audio.url), 200, 'public-audio');
    evidence.audio = { duration: audio.duration };

    stage = 'delete';
    status(await request(base, `/api/annotations/${annotationId}`, { method: 'DELETE', headers: signed }), 200, stage);
    status(await request(base, `/api/annotations/${audioAnnotationId}`, { method: 'DELETE', headers: signed }), 200, stage);
    status(await request(base, video.url), 404, 'deleted-video');
    status(await request(base, voice.url), 404, 'deleted-voice');
    status(await request(base, audio.url), 404, 'deleted-audio');
    status(await request(base, `/api/annotations/${annotationId}/share-card.png`), 404, 'deleted-share-card');
    evidence.stages.deleted = 'all published media and share card inaccessible';
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.failedStage = stage;
    evidence.failure = error instanceof assert.AssertionError ? error.message : error?.name || 'Error';
  } finally {
    if (server?.listening) await new Promise(resolveClose => server.close(() => resolveClose()));
    const deleted = [];
    const failed = [];
    for (const path of paths) {
      try { await del(path, { token: blobToken }); deleted.push(path.startsWith('drafts/') ? 'draft' : 'media'); }
      catch { failed.push(path.startsWith('drafts/') ? 'draft' : 'media'); }
    }
    evidence.cleanup.blob = { attempted: paths.size, deleted: deleted.length, failed: failed.length };
    if (schemaCreated) {
      try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); evidence.cleanup.schema = 'dropped'; }
      catch { evidence.cleanup.schema = 'failed'; }
    }
    await admin.end().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
    await mkdir(EVIDENCE, { recursive: true });
    await writeFile(join(EVIDENCE, 'cloud-smoke.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
  if (evidence.status !== 'passed' || evidence.cleanup.blob.failed || evidence.cleanup.schema !== 'dropped') {
    console.error(`Cloud smoke failed at ${evidence.failedStage || 'cleanup'}; see sanitized artifacts/cloud-qa/cloud-smoke.json.`);
    process.exitCode = 1;
  } else console.log('Cloud smoke passed; temporary Blob objects and Neon schema removed.');
}

await main();
