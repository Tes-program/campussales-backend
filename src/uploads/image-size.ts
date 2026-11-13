/**
 * Reads an image's pixel size from its header bytes (no image library).
 * Supports JPEG, PNG, WebP (VP8, VP8L, VP8X), GIF and HEIC/HEIF/AVIF.
 * Returns null when the format is unknown or the header is cut short.
 *
 * Sizes are as stored in the file. EXIF rotation is ignored: the minimum-size
 * and aspect-ratio rules (upload-rules.ts) don't depend on orientation.
 */
export interface ImageSize {
  width: number;
  height: number;
  format: 'jpeg' | 'png' | 'webp' | 'gif' | 'heic';
}

/** Bytes worth reading from the start of a file to find the size. */
export const IMAGE_HEADER_BYTES = 256 * 1024;

export function imageSize(buf: Buffer): ImageSize | null {
  if (buf.length < 12) return null;
  try {
    if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG')
      return png(buf);
    if (buf[0] === 0xff && buf[1] === 0xd8) return jpeg(buf);
    if (
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP'
    )
      return webp(buf);
    if (buf.toString('ascii', 0, 3) === 'GIF')
      return size(buf.readUInt16LE(6), buf.readUInt16LE(8), 'gif');
    if (buf.toString('ascii', 4, 8) === 'ftyp') return heic(buf);
  } catch {
    // RangeError: the header ends before the size fields.
  }
  return null;
}

function size(
  width: number,
  height: number,
  format: ImageSize['format'],
): ImageSize | null {
  return width > 0 && height > 0 ? { width, height, format } : null;
}

function png(buf: Buffer) {
  // IHDR is always the first chunk: width and height at bytes 16 and 20.
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return size(buf.readUInt32BE(16), buf.readUInt32BE(20), 'png');
}

function jpeg(buf: Buffer) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    // Fill bytes, standalone markers (TEM, RST0-7) carry no length.
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    // SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return size(buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5), 'jpeg');
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webp(buf: Buffer) {
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    // Key frame start code 9d 01 2a, then 14-bit width/height.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return size(
      buf.readUInt16LE(26) & 0x3fff,
      buf.readUInt16LE(28) & 0x3fff,
      'webp',
    );
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const b = buf.readUInt32LE(21);
    return size((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1, 'webp');
  }
  if (chunk === 'VP8X') {
    return size(buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1, 'webp');
  }
  return null;
}

/**
 * HEIC/HEIF/AVIF (ISO BMFF): the size is in an `ispe` property inside
 * meta > iprp > ipco. Several may exist (thumbnails, tiles); the largest is
 * the full image.
 */
function heic(buf: Buffer) {
  let best: { w: number; h: number } | null = null;
  const walk = (start: number, end: number, depth: number) => {
    let i = start;
    while (i + 8 <= end) {
      let len = buf.readUInt32BE(i);
      const type = buf.toString('ascii', i + 4, i + 8);
      let header = 8;
      if (len === 1) {
        len = Number(buf.readBigUInt64BE(i + 8));
        header = 16;
      } else if (len === 0) {
        len = end - i;
      }
      if (len < header) return;
      const boxEnd = Math.min(i + len, end);
      if (type === 'meta' && depth === 0) walk(i + header + 4, boxEnd, 1);
      else if ((type === 'iprp' || type === 'ipco') && depth > 0)
        walk(i + header, boxEnd, depth + 1);
      else if (type === 'ispe' && i + header + 12 <= end) {
        const w = buf.readUInt32BE(i + header + 4);
        const h = buf.readUInt32BE(i + header + 8);
        if (!best || w * h > best.w * best.h) best = { w, h };
      }
      i += len;
    }
  };
  walk(0, buf.length, 0);
  const b = best as { w: number; h: number } | null;
  return b ? size(b.w, b.h, 'heic') : null;
}
