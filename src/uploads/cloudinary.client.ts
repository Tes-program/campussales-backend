import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';

export interface CloudinaryResource {
  publicId: string;
  version: number;
  format: string;
  bytes: number;
  width: number;
  height: number;
  secureUrl: string;
}

/**
 * The few Cloudinary operations the API needs, behind one class so tests can
 * replace it (no network) and so credentials are read in one place.
 */
@Injectable()
export class CloudinaryClient {
  private readonly logger = new Logger(CloudinaryClient.name);

  constructor(private readonly config: ConfigService) {
    cloudinary.config({
      cloud_name: config.get<string>('CLOUDINARY_CLOUD_NAME'),
      api_key: config.get<string>('CLOUDINARY_API_KEY'),
      api_secret: config.get<string>('CLOUDINARY_API_SECRET'),
      secure: true,
    });
  }

  get cloudName(): string | undefined {
    return this.config.get<string>('CLOUDINARY_CLOUD_NAME');
  }

  get apiKey(): string | undefined {
    return this.config.get<string>('CLOUDINARY_API_KEY');
  }

  configured(): boolean {
    return !!(
      this.cloudName &&
      this.apiKey &&
      this.config.get<string>('CLOUDINARY_API_SECRET')
    );
  }

  /** Cloudinary's request signature (SHA-1 of the sorted params + secret). */
  sign(params: Record<string, string | number>): string {
    return cloudinary.utils.api_sign_request(
      params,
      this.config.get<string>('CLOUDINARY_API_SECRET') ?? '',
    );
  }

  /** Verifies the signature Cloudinary returns in the upload response. */
  verifyUploadResponse(
    publicId: string,
    version: number,
    signature: string,
  ): boolean {
    const expected = cloudinary.utils.api_sign_request(
      { public_id: publicId, version },
      this.config.get<string>('CLOUDINARY_API_SECRET') ?? '',
    );
    return (
      typeof signature === 'string' &&
      signature.length === expected.length &&
      signature === expected
    );
  }

  /** Admin API lookup (bytes, format) of an uploaded image; null if missing. */
  async resource(publicId: string): Promise<CloudinaryResource | null> {
    try {
      const r = (await cloudinary.api.resource(publicId, {
        resource_type: 'image',
      })) as {
        public_id: string;
        version: number;
        format: string;
        bytes: number;
        width: number;
        height: number;
        secure_url: string;
      };
      return {
        publicId: r.public_id,
        version: r.version,
        format: r.format,
        bytes: r.bytes,
        width: r.width,
        height: r.height,
        secureUrl: r.secure_url,
      };
    } catch (e) {
      const code = (e as { error?: { http_code?: number } }).error?.http_code;
      if (code === 404) return null;
      throw e;
    }
  }

  /** Deletes up to 100 images per call. Missing ids are not an error. */
  async destroy(publicIds: string[]): Promise<void> {
    for (let i = 0; i < publicIds.length; i += 100) {
      const batch = publicIds.slice(i, i + 100);
      await cloudinary.api.delete_resources(batch, {
        resource_type: 'image',
        invalidate: true,
      });
      this.logger.log(`Deleted ${batch.length} image(s) from Cloudinary`);
    }
  }
}
