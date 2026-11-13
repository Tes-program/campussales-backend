import { imageSize } from './image-size';
import { isExtremeAspect, isTooSmall, UPLOAD_RULES } from './upload-rules';

function png(w: number, h: number) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function jpeg(w: number, h: number) {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc2, 0); // progressive
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function riff(chunk: string, body: Buffer) {
  const head = Buffer.alloc(20);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length + 12, 4);
  head.write('WEBP', 8, 'ascii');
  head.write(chunk, 12, 'ascii');
  head.writeUInt32LE(body.length, 16);
  return Buffer.concat([head, body]);
}

function webpLossy(w: number, h: number) {
  const b = Buffer.alloc(10);
  b[3] = 0x9d;
  b[4] = 0x01;
  b[5] = 0x2a;
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return riff('VP8 ', b);
}

function webpLossless(w: number, h: number) {
  const b = Buffer.alloc(5);
  b[0] = 0x2f;
  b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 1);
  return riff('VP8L', b);
}

function webpExtended(w: number, h: number) {
  const b = Buffer.alloc(10);
  b.writeUIntLE(w - 1, 4, 3);
  b.writeUIntLE(h - 1, 7, 3);
  return riff('VP8X', b);
}

function box(type: string, body: Buffer) {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(body.length + 8, 0);
  h.write(type, 4, 'ascii');
  return Buffer.concat([h, body]);
}

function heic(sizes: Array<[number, number]>) {
  const ispes = sizes.map(([w, h]) => {
    const b = Buffer.alloc(12);
    b.writeUInt32BE(w, 4);
    b.writeUInt32BE(h, 8);
    return box('ispe', b);
  });
  const ftyp = box('ftyp', Buffer.from('heic\0\0\0\0mif1heic', 'ascii'));
  const meta = box(
    'meta',
    Buffer.concat([
      Buffer.alloc(4), // full box version + flags
      box('hdlr', Buffer.alloc(20)),
      box('iprp', box('ipco', Buffer.concat(ispes))),
    ]),
  );
  return Buffer.concat([ftyp, meta]);
}

describe('imageSize', () => {
  it.each([
    ['PNG', png(640, 480), 'png'],
    ['JPEG (progressive, after APP0)', jpeg(1024, 768), 'jpeg'],
    ['WebP lossy', webpLossy(800, 600), 'webp'],
    ['WebP lossless', webpLossless(800, 600), 'webp'],
    ['WebP extended', webpExtended(800, 600), 'webp'],
  ])('reads %s', (_name, buf, format) => {
    const s = imageSize(buf);
    expect(s?.format).toBe(format);
    expect(s!.width * s!.height).toBeGreaterThan(0);
  });

  it('returns exact sizes', () => {
    expect(imageSize(png(640, 480))).toEqual({
      width: 640,
      height: 480,
      format: 'png',
    });
    expect(imageSize(jpeg(202, 86))).toMatchObject({ width: 202, height: 86 });
    expect(imageSize(webpLossless(1234, 567))).toMatchObject({
      width: 1234,
      height: 567,
    });
    expect(imageSize(webpExtended(4000, 3000))).toMatchObject({
      width: 4000,
      height: 3000,
    });
  });

  it('reads HEIC and picks the full image over the thumbnail', () => {
    expect(
      imageSize(
        heic([
          [320, 240],
          [4032, 3024],
        ]),
      ),
    ).toEqual({ width: 4032, height: 3024, format: 'heic' });
  });

  it('returns null for unknown or truncated data', () => {
    expect(imageSize(Buffer.from('not an image at all'))).toBeNull();
    expect(imageSize(jpeg(800, 600).subarray(0, 24))).toBeNull();
    expect(imageSize(Buffer.alloc(0))).toBeNull();
  });
});

describe('listing photo size rules', () => {
  it('400x300 is the minimum in either orientation', () => {
    expect(isTooSmall(400, 300)).toBe(false);
    expect(isTooSmall(300, 400)).toBe(false);
    expect(isTooSmall(399, 300)).toBe(true);
    expect(isTooSmall(400, 299)).toBe(true);
    expect(isTooSmall(350, 350)).toBe(true);
    expect(isTooSmall(4032, 3024)).toBe(false);
  });

  it('flags wider than 2:1 or taller than 1:2', () => {
    expect(isExtremeAspect(800, 400)).toBe(false);
    expect(isExtremeAspect(400, 800)).toBe(false);
    expect(isExtremeAspect(801, 400)).toBe(true);
    expect(isExtremeAspect(400, 801)).toBe(true);
    expect(isExtremeAspect(0, 100)).toBe(false);
  });

  it('uses the agreed message', () => {
    expect(UPLOAD_RULES.tooSmallMessage).toBe(
      'This photo is too small. Use one at least 400x300.',
    );
  });
});
