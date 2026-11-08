/**
 * Cloudinary delivery URLs: https://res.cloudinary.com/<cloud>/image/upload/
 * [transformations/]v<version>/<publicId>.<format>
 */
const URL_RE =
  /^https:\/\/res\.cloudinary\.com\/([^/]+)\/image\/upload\/(?:[^/]+\/)*?v(\d+)\/(.+?)(?:\.([a-z0-9]+))?$/i;

export interface CloudinaryRef {
  cloudName: string;
  version: number;
  publicId: string;
  format: string | null;
}

export function parseCloudinaryUrl(
  url: string | null | undefined,
): CloudinaryRef | null {
  if (!url) return null;
  const m = URL_RE.exec(url.split('?')[0]);
  if (!m) return null;
  return {
    cloudName: m[1],
    version: Number(m[2]),
    publicId: decodeURIComponent(m[3]),
    format: m[4]?.toLowerCase() ?? null,
  };
}

export function cloudinaryUrl(
  cloudName: string,
  publicId: string,
  version: number,
  opts: { width?: number; format?: string } = {},
): string {
  const t = [
    'f_auto',
    'q_auto',
    ...(opts.width ? ['c_limit', `w_${opts.width}`] : []),
  ].join(',');
  const ext = opts.format ? `.${opts.format}` : '';
  return `https://res.cloudinary.com/${cloudName}/image/upload/${t}/v${version}/${publicId}${ext}`;
}

/** Original stored file (no transformation): the legacy `url` field. */
export function cloudinaryOriginalUrl(
  cloudName: string,
  publicId: string,
  version: number,
  format: string,
): string {
  return `https://res.cloudinary.com/${cloudName}/image/upload/v${version}/${publicId}.${format}`;
}
