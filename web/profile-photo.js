// The editor keeps this result locally until its Save action. No upload occurs here.
export async function prepareProfilePhoto(file) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPEG, PNG or WebP photo.');
  if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('Choose a photo up to 5 MB.');
  let image;
  try {
    image = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 512;
    const side = Math.min(image.width, image.height);
    if (!side) throw new Error();
    canvas.getContext('2d').drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 512, 512);
    const prepared = canvas.toDataURL('image/webp', 0.85);
    if (prepared.length > 700 * 1024) throw new Error();
    return prepared;
  } catch {
    throw new Error('This photo could not be opened. Try another JPEG, PNG or WebP.');
  } finally { image?.close(); }
}
