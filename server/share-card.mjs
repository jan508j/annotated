import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mediaBinary } from './media-processing.mjs';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { formatTime } from '../shared/source.mjs';
import { displaySourceTitle, sourceExcerpts, sourceIdentity } from '../shared/source-identity.mjs';
import { markerIndex } from '../shared/marker.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORMATS = Object.freeze({ wide: { width: 1200, height: 630 }, tall: { width: 1080, height: 1350 } });
const SCALE = 2;
const HUES = Object.freeze([
  { mark: '#ffb5ac', ink: '#a5473d' },
  { mark: '#f8ce73', ink: '#866300' },
  { mark: '#99ebaa', ink: '#326f40' },
  { mark: '#96daff', ink: '#326a91' },
  { mark: '#ecbeff', ink: '#814b91' },
]);
const INK = '#16161a';
const MUTED = '#6b6a64';
const MAX_CACHE_ENTRIES = 32;
const MAX_PENDING_RENDERS = 16;
const MAX_CONCURRENT_RENDERS = 2;
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 8_000;

for (const [file, family] of [
  ['instrument-sans.ttf', 'Instrument Sans'],
  ['instrument-serif-italic.ttf', 'Instrument Serif Italic'],
  ['jetbrains-mono.ttf', 'JetBrains Mono'],
]) {
  if (!GlobalFonts.registerFromPath(join(ROOT, 'extension', 'fonts', file), family)) {
    throw new Error(`Could not load bundled ${family}.`);
  }
}

const measure = createCanvas(1, 1).getContext('2d');
const cache = new Map();
const inflight = new Map();
const queue = [];
let activeRenders = 0;

export class ShareCardBusyError extends Error {}

function cleanText(value) {
  return String(value ?? '').normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/gu, ' ').trim();
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

function graphemes(value) {
  return typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map((item) => item.segment)
    : Array.from(value);
}

function font(family, size, weight = 400) {
  return `${weight} ${size}px "${family}"`;
}

function width(value, family, size, weight = 400) {
  measure.font = font(family, size, weight);
  return measure.measureText(value).width;
}

function ellipsize(value, maxWidth, family, size, weight = 400) {
  const units = graphemes(value.replace(/[\s.,;:!?…]+$/u, ''));
  while (units.length && width(`${units.join('')}…`, family, size, weight) > maxWidth) units.pop();
  return `${units.join('').trimEnd()}…`;
}

function wrap(value, maxWidth, maxLines, family, size, weight = 400) {
  const words = cleanText(value).split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  let truncated = false;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const candidate = line ? `${line} ${word}` : word;
    if (width(candidate, family, size, weight) <= maxWidth) { line = candidate; continue; }
    if (line) { lines.push(line); line = ''; }
    if (lines.length >= maxLines) { truncated = true; break; }
    if (width(word, family, size, weight) > maxWidth) {
      let piece = '';
      for (const unit of graphemes(word)) {
        if (piece && width(piece + unit, family, size, weight) > maxWidth) {
          lines.push(piece);
          piece = '';
          if (lines.length >= maxLines) { truncated = true; break; }
        }
        piece += unit;
      }
      if (truncated) break;
      line = piece;
    } else line = word;
  }
  if (!truncated && line) lines.push(line);
  if (lines.length > maxLines) { lines.length = maxLines; truncated = true; }
  if (truncated && lines.length) lines[lines.length - 1] = ellipsize(lines[lines.length - 1], maxWidth, family, size, weight);
  return lines;
}

function textNode(value, x, y, size, family = 'Instrument Sans', options = {}) {
  const { weight = 400, fill = INK, anchor = 'start', spacing = 0, strokeWidth = 0 } = options;
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="${xml(family)}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}"${spacing ? ` letter-spacing="${spacing}"` : ''}${strokeWidth ? ` stroke="${fill}" stroke-width="${strokeWidth}" paint-order="stroke fill" stroke-linejoin="round"` : ''}>${xml(value)}</text>`;
}

function logo(x, y, size, hue) {
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="${INK}"/><path d="M46 30H30V98H46M82 30H98V98H82" fill="none" stroke="${hue.mark}" stroke-width="14"/><circle cx="64" cy="64" r="13" fill="${hue.mark}"/></svg>`;
}

function sourceMeta(card, identity, x, baseline, maxWidth, size, rightX) {
  const badgeSize = size === 16 ? 27 : 22;
  const label = [identity.publisher, card.sourceKind === 'article' ? (identity.platform === 'x' ? 'Post' : 'Text') : card.sourceKind, identity.author ? (identity.author.startsWith('@') ? identity.author : `@${identity.author}`) : ''].filter(Boolean).join(' · ').toUpperCase();
  const domain = cleanText(card.siteDomain || 'annotated');
  const domainWidth = width(domain, 'Instrument Sans', size, 500);
  const labelWidth = Math.max(80, maxWidth - domainWidth - badgeSize - 28);
  const fitted = width(label, 'JetBrains Mono', size, 600) > labelWidth ? ellipsize(label, labelWidth, 'JetBrains Mono', size, 600) : label;
  const symbol = identity.platform === 'youtube'
    ? `<path d="M8 6L18 12L8 18Z" fill="#fff" transform="translate(${x} ${baseline - badgeSize + 2}) scale(${badgeSize / 24})"/>`
    : textNode(identity.badge, x + badgeSize / 2, baseline - badgeSize / 2 + size / 3 + 2, Math.round(size * .85), 'Instrument Sans', { weight: 700, fill: '#fff', anchor: 'middle' });
  return `<circle cx="${x + badgeSize / 2}" cy="${baseline - badgeSize / 2 + 2}" r="${badgeSize / 2}" fill="${INK}"/>${symbol}${textNode(fitted, x + badgeSize + 11, baseline, size, 'JetBrains Mono', { weight: 600, fill: MUTED, spacing: .35 })}${textNode(domain, rightX, baseline, size, 'Instrument Sans', { weight: 500, anchor: 'end' })}`;
}

function markedExcerpt(value, x, top, availableWidth, maxLines, size, lineHeight, hue, more = 0) {
  const bracketWidth = width('[', 'Instrument Sans', size, 700);
  const lines = wrap(value, availableWidth - 2 * bracketWidth - 12, maxLines, 'Instrument Sans', size);
  let svg = '';
  lines.forEach((line, index) => {
    const baseline = top + size + index * lineHeight;
    const highlightWidth = width(line, 'Instrument Sans', size);
    const lineX = x + bracketWidth + 3;
    svg += `<rect x="${lineX - 3}" y="${baseline - size + 2}" width="${highlightWidth + 7}" height="${size + 5}" rx="4" fill="${hue.mark}"/>`;
    if (index === 0) svg += textNode('[', x, baseline, size, 'Instrument Sans', { weight: 700, fill: hue.ink });
    svg += textNode(line, lineX, baseline, size);
    if (index === lines.length - 1) svg += textNode(']', lineX + highlightWidth + 6, baseline, size, 'Instrument Sans', { weight: 700, fill: hue.ink });
  });
  if (more) svg += textNode(`+${more} more`, x, top + size + lines.length * lineHeight + 6, Math.max(15, Math.round(size * .6)), 'JetBrains Mono', { weight: 600, fill: MUTED });
  return { svg, height: Math.max(size + 6, lines.length * lineHeight + (more ? 26 : 0)) };
}

function runBinary(command, args, { timeout = RENDER_TIMEOUT_MS, maxBytes = MAX_THUMBNAIL_BYTES } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(mediaBinary(command), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(output);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Thumbnail generation timed out.')); }, timeout);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { child.kill('SIGKILL'); finish(new Error('Thumbnail output exceeded its size limit.')); }
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.reduce((size, part) => size + part.length, 0) < 32 * 1024) stderr.push(chunk);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (code === 0) finish(null, Buffer.concat(stdout));
      else finish(new Error(`ffmpeg thumbnail failed (${signal || code}): ${Buffer.concat(stderr).toString('utf8').slice(-500)}`));
    });
  });
}

async function videoThumbnail(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return await runBinary('ffmpeg', [
      '-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
      '-protocol_blacklist', 'http,https,tcp,tls,udp,rtp,ftp',
      '-ss', '0', '-i', path, '-frames:v', '1',
      '-vf', 'scale=936:527:force_original_aspect_ratio=increase,crop=936:527',
      '-f', 'image2pipe', '-c:v', 'png', 'pipe:1',
    ]);
  } catch { return null; }
}

function takeSize(card, format) {
  const length = graphemes(card.commentary).length;
  return format === 'wide' ? (length <= 80 ? 68 : length <= 140 ? 56 : 46)
    : (length <= 80 ? 92 : length <= 140 ? 76 : 62);
}

function balancedTake(lines, maxWidth, size) {
  if (lines.length !== 2) return lines;
  const words = lines.join(' ').split(' ');
  let best = lines;
  let bestDifference = Math.abs(width(lines[0], 'Instrument Serif Italic', size) - width(lines[1], 'Instrument Serif Italic', size));
  for (let split = 1; split < words.length; split += 1) {
    const candidate = [words.slice(0, split).join(' '), words.slice(split).join(' ')];
    const widths = candidate.map(line => width(line, 'Instrument Serif Italic', size));
    if (widths.some(lineWidth => lineWidth > maxWidth)) continue;
    const difference = Math.abs(widths[0] - widths[1]);
    if (difference < bestDifference) { best = candidate; bestDifference = difference; }
  }
  return best;
}

function takeLines(card, format, maxHeight, maxWidth) {
  let size = takeSize(card, format);
  const text = card.commentary || 'Voice take';
  const family = card.commentary ? 'Instrument Serif Italic' : 'Instrument Sans';
  while (size > 34) {
    const lineHeight = Math.round(size * 1.03);
    const naturalLines = wrap(text, maxWidth, 100, family, size);
    const maxLines = Math.min(4, naturalLines.length);
    if (naturalLines.length <= 4 && maxLines * lineHeight <= maxHeight) {
      const lines = balancedTake(naturalLines, maxWidth, size);
      return { lines, size, family, lineHeight };
    }
    if (naturalLines.length > 4 && 4 * lineHeight <= maxHeight) {
      return { lines: wrap(text, maxWidth, 4, family, size), size, family, lineHeight };
    }
    size -= 2;
  }
  const lineHeight = Math.round(size * 1.03);
  return { lines: wrap(text, maxWidth, Math.min(4, Math.max(1, Math.floor(maxHeight / lineHeight))), family, size), size, family, lineHeight };
}

async function cardSvg(card, format) {
  const tall = format === 'tall';
  const { width: W, height: H } = FORMATS[format];
  const hue = HUES[markerIndex(card.id)];
  const identity = sourceIdentity({ url: card.sourceUrl, title: card.sourceTitle, author: card.sourceAuthor, publisher: card.sourcePublisher });
  const pad = tall ? 72 : 64;
  const top = tall ? 72 : 56;
  const logoSize = tall ? 52 : 40;
  const metaSize = tall ? 17 : 14;
  const innerW = W - 2 * pad;
  const excerpts = sourceExcerpts(card);
  const excerpt = excerpts[0] || '';
  const additionalHighlights = Math.max(0, excerpts.length - 1);
  const isMedia = card.sourceKind === 'video' || card.sourceKind === 'audio';
  const takeY = top + logoSize + (tall ? 44 : 32);
  const takeGap = tall ? 44 : 36;
  const sizeForLength = takeSize(card, format);
  const intendedTakeLines = card.commentary
    ? Math.min(4, wrap(card.commentary, innerW, 100, 'Instrument Serif Italic', sizeForLength).length)
    : 1;
  const intendedTakeHeight = card.commentary
    ? intendedTakeLines * Math.round(sizeForLength * 1.03)
    : (tall ? 100 : 76);
  const maxSheetHeight = H - top - takeY - takeGap - intendedTakeHeight;
  let sheetHeight;
  let excerptLimit = tall ? 5 : 3;
  if (tall) {
    const excerptSize = isMedia ? 34 : 38;
    const textWidth = innerW - 44 - 24 - 2 * width('[', 'Instrument Sans', excerptSize, 700) - 12;
    const excerptLines = wrap(excerpt, textWidth, 5, 'Instrument Sans', excerptSize).length;
    if (isMedia && excerpt) {
      const remainingLines = Math.floor((maxSheetHeight - 666 - (additionalHighlights ? 26 : 0)) / 46) + 1;
      excerptLimit = Math.max(1, Math.min(5, remainingLines));
    }
    sheetHeight = isMedia
      ? (excerpt ? 666 + Math.max(0, Math.min(excerptLines, excerptLimit) - 1) * 46 + (additionalHighlights ? 26 : 0) : 600)
      : Math.max(208, 104 + excerptLines * 52 + (additionalHighlights ? 26 : 0));
  } else {
    const textWidth = innerW - 60 - 2 * width('[', 'Instrument Sans', 26, 700) - 12;
    const excerptLines = wrap(excerpt || card.sourceTitle, textWidth, 3, 'Instrument Sans', 26).length;
    sheetHeight = isMedia ? 214 : 126 + Math.max(0, excerptLines - 1) * 36 + (additionalHighlights ? 28 : 0);
  }
  const sheetY = H - top - sheetHeight;
  const takeMax = sheetY - takeY - takeGap;
  const take = takeLines(card, format, takeMax, innerW);
  let takeSvg = take.lines.map((line, index) => textNode(line, pad, takeY + take.size * .84 + index * take.lineHeight, take.size, take.family, { weight: 400, spacing: -.4 })).join('');
  if (!card.commentary) {
    const barHeights = [18, 36, 58, 30, 68, 40, 55, 27, 16];
    const barY = takeY + (tall ? 19 : 13);
    takeSvg = barHeights.map((height, index) => `<rect x="${pad + index * 12}" y="${barY + (68 - height) / 2}" width="7" height="${height}" rx="3.5" fill="${INK}"/>`).join('');
    takeSvg += textNode(card.voiceDuration != null ? `${formatTime(card.voiceDuration)} voice take` : 'Voice take', pad + 132, takeY + (tall ? 86 : 64), tall ? 72 : 54, 'Instrument Sans', { weight: 500, spacing: -.5 });
  }
  const label = `TAKE — ${card.creatorName || 'ANNOTATOR'}`.toUpperCase();
  const fittedLabel = width(label, 'JetBrains Mono', metaSize, 600) > innerW * .57
    ? ellipsize(label, innerW * .57, 'JetBrains Mono', metaSize, 600) : label;
  const wordmark = logo(pad, top, logoSize, hue)
    + textNode('Annotated', pad + logoSize + (tall ? 14 : 12), top + (tall ? 38 : 29), tall ? 32 : 24, 'Instrument Sans', { weight: 700, spacing: -1, strokeWidth: tall ? 1.2 : .9 })
    + textNode(fittedLabel, W - pad, top + (tall ? 36 : 27), metaSize, 'JetBrains Mono', { weight: 600, anchor: 'end', spacing: 1 });
  let sheet = `<rect x="${pad}" y="${sheetY}" width="${innerW}" height="${sheetHeight}" rx="${tall ? 30 : 22}" fill="#fff"/>`;
  let videoFrame = null;
  if (tall) {
    const contentX = pad + 22;
    const contentW = innerW - 44;
    let textTop = sheetY + (isMedia ? 22 : 32);
    if (isMedia) {
      const frameH = Math.round(contentW * 9 / 16);
      videoFrame = { x: contentX, y: textTop, width: contentW, height: frameH, radius: 18 };
      sheet += `<rect x="${contentX}" y="${textTop}" width="${contentW}" height="${frameH}" rx="18" fill="#24252a"/>`;
      sheet += textNode(card.sourceKind === 'audio' ? 'AUDIO EXCERPT' : 'VIDEO EXCERPT', contentX + 34, textTop + frameH / 2, 29, 'Instrument Sans', { weight: 600, fill: '#fff' });
      const time = `[ ${formatTime(card.start)} – ${formatTime(card.end)} ]`;
      const chipW = width(time, 'JetBrains Mono', 18, 600) + 24;
      sheet += `<rect x="${contentX + 18}" y="${textTop + 18}" width="${chipW}" height="36" rx="8" fill="${hue.mark}"/>${textNode(time, contentX + 30, textTop + 43, 18, 'JetBrains Mono', { weight: 600 })}`;
      textTop += frameH + 25;
    }
    const textValue = excerpt || (!isMedia ? card.sourceTitle : '');
    if (textValue) sheet += markedExcerpt(textValue, contentX + 12, textTop, contentW - 24, excerptLimit, isMedia ? 34 : 38, isMedia ? 46 : 52, hue, additionalHighlights).svg;
    const metaBaseline = sheetY + sheetHeight - 34;
    sheet += sourceMeta(card, identity, contentX + 12, metaBaseline, contentW - 24, 16, contentX + contentW - 12);
  } else {
    const contentX = pad + 30;
    const contentW = innerW - 60;
    if (isMedia) {
      const frameX = contentX;
      const frameY = sheetY + 25;
      const frameW = 246;
      const frameH = 138;
      videoFrame = { x: frameX, y: frameY, width: frameW, height: frameH, radius: 12 };
      sheet += `<rect x="${frameX}" y="${frameY}" width="${frameW}" height="${frameH}" rx="12" fill="#24252a"/>`;
      sheet += textNode(card.sourceKind === 'audio' ? 'AUDIO EXCERPT' : 'VIDEO EXCERPT', frameX + 20, frameY + 76, 17, 'JetBrains Mono', { weight: 600, fill: '#fff' });
      const detailX = frameX + frameW + 24;
      const detailW = contentW - frameW - 24;
      const detail = excerpt || card.sourceTitle;
      const lines = wrap(detail, detailW, 3, 'Instrument Sans', 24);
      sheet += lines.map((line, i) => textNode(line, detailX, frameY + 32 + i * 31, 24)).join('');
      sheet += textNode(`[ ${formatTime(card.start)} – ${formatTime(card.end)} ]`, detailX, frameY + 132, 15, 'JetBrains Mono', { weight: 600, fill: hue.ink });
    } else {
      sheet += markedExcerpt(excerpt || card.sourceTitle, contentX, sheetY + 25, contentW, 3, 26, 36, hue, Math.max(0, excerpts.length - 1)).svg;
    }
    sheet += sourceMeta(card, identity, contentX, sheetY + sheetHeight - 27, contentW, 13, contentX + contentW);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${hue.mark}"/>${wordmark}${takeSvg}${sheet}</svg>`;
  return { svg, videoFrame };
}

async function drawCard(card, format) {
  const { svg, videoFrame } = await cardSvg(card, format);
  const image = await loadImage(Buffer.from(svg));
  const size = FORMATS[format];
  const canvas = createCanvas(size.width * SCALE, size.height * SCALE);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  if (card.sourceKind === 'video' && card.videoPath && videoFrame) {
    const bytes = await videoThumbnail(card.videoPath);
    if (bytes) {
      const thumbnail = await loadImage(bytes);
      const tall = format === 'tall';
      const { x, y, width: frameWidth, height: frameHeight, radius } = videoFrame;
      context.save();
      context.scale(SCALE, SCALE);
      context.beginPath();
      context.roundRect(x, y, frameWidth, frameHeight, radius);
      context.clip();
      context.drawImage(thumbnail, x, y, frameWidth, frameHeight);
      context.restore();
      if (tall) {
        const time = `[ ${formatTime(card.start)} – ${formatTime(card.end)} ]`;
        const chipWidth = width(time, 'JetBrains Mono', 18, 600) + 24;
        context.save();
        context.scale(SCALE, SCALE);
        context.fillStyle = HUES[markerIndex(card.id)].mark;
        context.beginPath();
        context.roundRect(x + 18, y + 18, chipWidth, 36, 8);
        context.fill();
        context.fillStyle = INK;
        context.font = font('JetBrains Mono', 18, 600);
        context.fillText(time, x + 30, y + 43);
        context.restore();
      }
    }
  }
  return canvas.encode('png');
}

function cacheKey(card, format) {
  return createHash('sha256').update(JSON.stringify([format, card])).digest('hex');
}

function runLimited(job) {
  if (activeRenders >= MAX_CONCURRENT_RENDERS && queue.length >= MAX_PENDING_RENDERS) {
    throw new ShareCardBusyError('Share-card rendering is busy.');
  }
  return new Promise((resolvePromise, reject) => {
    const start = async () => {
      activeRenders += 1;
      try { resolvePromise(await job()); }
      catch (error) { reject(error); }
      finally { activeRenders -= 1; queue.shift()?.(); }
    };
    if (activeRenders < MAX_CONCURRENT_RENDERS) start();
    else queue.push(start);
  });
}

export async function renderShareCard(card, { format = 'wide', withVideoPath } = {}) {
  if (!FORMATS[format]) throw new RangeError('Unsupported share-card format.');
  const identity = sourceIdentity({ url: card.sourceUrl, title: card.sourceTitle, author: card.sourceAuthor, publisher: card.sourcePublisher });
  const normalized = {
    id: cleanText(card.id),
    creatorName: cleanText(card.creatorName),
    commentary: cleanText(card.commentary),
    sourceKind: card.sourceKind,
    sourceTitle: displaySourceTitle({ url: card.sourceUrl, title: card.sourceTitle, author: card.sourceAuthor, publisher: card.sourcePublisher }),
    sourceAuthor: identity.author,
    sourcePublisher: identity.publisher,
    sourceUrl: card.sourceUrl,
    siteDomain: cleanText(card.siteDomain),
    excerpt: cleanText(card.excerpt),
    excerpts: sourceExcerpts(card),
    start: card.start,
    end: card.end,
    isDemo: Boolean(card.isDemo),
    voiceDuration: Number.isFinite(card.voiceDuration) ? card.voiceDuration : null,
    videoPath: card.videoPath || null,
    videoVersion: card.videoVersion || null,
  };
  const key = cacheKey(normalized, format);
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
  if (inflight.has(key)) return inflight.get(key);
  const rendering = runLimited(() => withVideoPath
    ? withVideoPath(videoPath => drawCard({ ...normalized, videoPath }, format))
    : drawCard(normalized, format));
  inflight.set(key, rendering);
  try {
    const png = await rendering;
    cache.set(key, png);
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    return png;
  } finally { inflight.delete(key); }
}

export const SHARE_CARD_SIZE = Object.freeze({ width: FORMATS.wide.width * SCALE, height: FORMATS.wide.height * SCALE });
export const SHARE_CARD_FORMATS = Object.freeze(Object.fromEntries(Object.entries(FORMATS).map(([name, size]) => [name, Object.freeze({ width: size.width * SCALE, height: size.height * SCALE })])));
