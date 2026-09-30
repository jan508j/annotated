import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { renderShareCard } from '../server/share-card.mjs';

const phrase = 'A clear point about evidence and context needs room to breathe. The record makes a narrower claim than the headline suggests. ';
const longExcerpt = ('Original fixture evidence from a local test source should stay distinct from the author take and remain readable even when the marked transcript contains many words. ').repeat(5);

test('share cards render publisher metadata and keep it in the image cache identity', async () => {
  const card = {
    id: 'publisher-fixture', creatorName: 'Local test author', commentary: 'A local test take.',
    sourceKind: 'article', sourceTitle: 'Evidence', sourceAuthor: 'Fixture Writer',
    sourceUrl: 'https://about.example.test/evidence', excerpt: 'Local test evidence.',
  };
  const fallback = await renderShareCard(card);
  const named = await renderShareCard({ ...card, sourcePublisher: 'Example Publisher' });
  assert.notDeepEqual(named, fallback, 'publisher name and initial replace the hostname fallback');
  assert.deepEqual(await renderShareCard({ ...card, sourcePublisher: 'Example Publisher' }), named);
});

test('dense tall media cards retain a clear gap between take and source sheet', async () => {
  for (const length of [80, 140, 220, 300]) {
    const card = {
      id: `layout-fixture-${length}`,
      creatorName: 'A Very Long Local Test Author Name With Several Additional Words',
      commentary: phrase.repeat(5).slice(0, length).trimEnd(),
      sourceKind: 'video',
      sourceTitle: 'Local fixture video',
      sourceAuthor: 'An Extremely Long Source Author Name With Several Additional Words',
      sourceUrl: 'https://youtube.com/watch?v=fixture',
      siteDomain: 'annotated.example.test',
      excerpts: [longExcerpt, 'Two', 'Three', 'Four', 'Five'],
      start: 3,
      end: 7,
    };
    const png = await renderShareCard(card, { format: 'tall' });
    const image = await loadImage(png);
    assert.equal(image.width, 2160);
    assert.equal(image.height, 2700);
    const canvas = createCanvas(1080, 1350);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 1080, 1350);
    const pixels = context.getImageData(0, 0, 1080, 1350).data;
    const index = (x, y) => (y * 1080 + x) * 4;
    let sheetTop = -1;
    for (let y = 200; y < 1250; y += 1) {
      const p = index(540, y);
      if (pixels[p] > 250 && pixels[p + 1] > 250 && pixels[p + 2] > 250) { sheetTop = y; break; }
    }
    assert.ok(sheetTop > 260, `sheet is visible for ${length} characters`);
    for (let y = sheetTop - 24; y < sheetTop - 2; y += 2) {
      for (let x = 72; x < 1008; x += 3) {
        const p = index(x, y);
        assert.ok(pixels[p] > 60 || pixels[p + 1] > 60 || pixels[p + 2] > 60,
          `take remains above the source sheet for ${length} characters`);
      }
    }
  }
});

test('one-line tall media sheet follows the reference frame geometry', async () => {
  const png = await renderShareCard({
    id: 'reference-geometry-fixture',
    creatorName: 'Local test author',
    commentary: 'Labs get excuses. Companies get judged.',
    sourceKind: 'video',
    sourceTitle: 'Local fixture video',
    sourceAuthor: 'Fixture show',
    sourceUrl: 'https://youtube.com/watch?v=fixture',
    excerpts: ['We have to stop calling these companies labs.'],
    start: 3,
    end: 7,
  }, { format: 'tall' });
  const image = await loadImage(png);
  const canvas = createCanvas(1080, 1350);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, 1080, 1350);
  const pixel = (x, y) => context.getImageData(x, y, 1, 1).data;
  assert.ok(pixel(540, 611)[1] < 250, 'hue background ends above the sheet');
  assert.deepEqual([...pixel(540, 612)].slice(0, 3), [255, 255, 255], 'sheet begins at y=612');
  assert.ok(pixel(100, 640)[0] < 100, 'frame begins within the sheet at x=94, y=634');
});
