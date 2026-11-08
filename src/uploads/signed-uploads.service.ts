import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import {
  AppError,
  notFound,
  ValidationFailed,
} from '../common/errors/app-errors';
import { ErrorCode } from '../common/errors/error-codes';
import { CloudinaryClient } from './cloudinary.client';
import { cloudinaryOriginalUrl, cloudinaryUrl } from './cloudinary-url';
import { Upload, UploadType } from './entities/upload.entitiy';
import { UPLOAD_RULES } from './upload-rules';
import { UsersService } from '../users/user.service';

export type UploadKind = 'product' | 'avatar' | 'chat';

const FOLDERS: Record<UploadKind, string> = {
  product: 'campussales/products',
  avatar: 'campussales/avatars',
  chat: 'campussales/chat',
};

/** Incoming: shrink before storing. Eager: warm the two sizes lists and item pages use. */
export const INCOMING_TRANSFORMATION = `c_limit,w_${UPLOAD_RULES.maxWidth},h_${UPLOAD_RULES.maxWidth}/q_auto:good`;
export const EAGER_TRANSFORMATIONS =
  'c_limit,w_400/q_auto|c_limit,w_800/q_auto';

export interface SignedUpload {
  uploadId: string;
  publicId: string;
  /** POST multipart/form-data here with `file` plus every field in `fields`. */
  uploadUrl: string;
  fields: Record<string, string | number>;
  expiresAt: string;
}

/**
 * Direct-to-Cloudinary uploads (B5): photos go from the phone straight to
 * Cloudinary, never through our server.
 *
 *  1. POST /api/uploads/sign: we choose the public id (inside our folder),
 *     sign the allowed formats and transformations, and record a pending
 *     upload. The client must send exactly the signed fields.
 *  2. The client uploads to Cloudinary and gets { public_id, version,
 *     signature, bytes, ... } back.
 *  3. POST /api/uploads/complete: we verify Cloudinary's response signature,
 *     check the stored size, and mark the upload ready. The response has the
 *     public id, version and responsive URLs.
 * Pending uploads never completed are removed by the orphan clean-up.
 */
@Injectable()
export class SignedUploadsService {
  private readonly logger = new Logger(SignedUploadsService.name);

  constructor(
    @InjectRepository(Upload) private readonly uploads: Repository<Upload>,
    private readonly cloud: CloudinaryClient,
    private readonly users: UsersService,
  ) {}

  private assertConfigured() {
    if (!this.cloud.configured()) {
      throw new AppError(
        ErrorCode.SERVER_ERROR,
        'Photo uploads are not available right now. Please try again later.',
      );
    }
  }

  async sign(
    userId: string,
    kind: UploadKind,
    count: number,
  ): Promise<{ uploads: SignedUpload[]; maxBytes: number; formats: string[] }> {
    this.assertConfigured();
    const timestamp = Math.floor(Date.now() / 1000);
    const expiresAt = new Date(
      (timestamp + UPLOAD_RULES.signatureTtlSeconds) * 1000,
    );
    const preset = process.env.CLOUDINARY_UPLOAD_PRESET;
    const out: SignedUpload[] = [];
    for (let i = 0; i < count; i++) {
      const publicId = `${FOLDERS[kind]}/${randomUUID()}`;
      const params: Record<string, string | number> = {
        allowed_formats: UPLOAD_RULES.formats.join(','),
        eager: EAGER_TRANSFORMATIONS,
        eager_async: 'true',
        public_id: publicId,
        timestamp,
        transformation: INCOMING_TRANSFORMATION,
        ...(preset ? { upload_preset: preset } : {}),
      };
      const signature = this.cloud.sign(params);
      const row = await this.uploads.save(
        this.uploads.create({
          userId,
          filename: publicId,
          originalName: '',
          mimetype: 'image/*',
          size: 0,
          url: '',
          uploadType:
            kind === 'avatar'
              ? UploadType.PROFILE_AVATAR
              : UploadType.PRODUCT_IMAGE,
          cloudinaryPublicId: publicId,
          status: 'pending',
        }),
      );
      out.push({
        uploadId: row.id,
        publicId,
        uploadUrl: `https://api.cloudinary.com/v1_1/${this.cloud.cloudName}/image/upload`,
        fields: { ...params, api_key: this.cloud.apiKey ?? '', signature },
        expiresAt: expiresAt.toISOString(),
      });
    }
    return {
      uploads: out,
      maxBytes: UPLOAD_RULES.maxBytes,
      formats: UPLOAD_RULES.formats,
    };
  }

  async complete(
    userId: string,
    dto: {
      uploadId: string;
      publicId: string;
      version: number;
      signature: string;
      format?: string;
      bytes?: number;
      width?: number;
      height?: number;
    },
  ) {
    this.assertConfigured();
    const row = await this.uploads.findOne({
      where: { id: dto.uploadId, userId },
    });
    if (!row || row.cloudinaryPublicId !== dto.publicId)
      throw notFound("We couldn't find that upload. Please try again.");
    if (row.status === 'ready') return this.view(row);
    if (row.status !== 'pending')
      throw notFound("We couldn't find that upload. Please try again.");
    const ageSeconds = (Date.now() - row.createdAt.getTime()) / 1000;
    if (ageSeconds > UPLOAD_RULES.signatureTtlSeconds + 60) {
      throw new ValidationFailed(
        { uploadId: 'This upload took too long. Please add the photo again.' },
        'This upload took too long. Please add the photo again.',
      );
    }
    if (
      !this.cloud.verifyUploadResponse(dto.publicId, dto.version, dto.signature)
    ) {
      throw new ValidationFailed(
        { signature: "We couldn't verify this photo. Please add it again." },
        "We couldn't verify this photo. Please add it again.",
      );
    }

    // Ask Cloudinary for the real size/format: the client's numbers are not trusted.
    let info = {
      format: dto.format ?? 'jpg',
      bytes: dto.bytes ?? 0,
      width: dto.width ?? null,
      height: dto.height ?? null,
    } as {
      format: string;
      bytes: number;
      width: number | null;
      height: number | null;
    };
    if (process.env.UPLOAD_VERIFY_WITH_ADMIN_API !== 'false') {
      try {
        const r = await this.cloud.resource(dto.publicId);
        if (!r)
          throw notFound("We couldn't find that photo. Please add it again.");
        info = {
          format: r.format,
          bytes: r.bytes,
          width: r.width,
          height: r.height,
        };
      } catch (e) {
        if (e instanceof AppError) throw e;
        // Admin API rate limit/outage: fall back to the signed response.
        this.logger.warn(
          `Cloudinary resource lookup failed: ${(e as Error).message}`,
        );
      }
    }
    if (info.bytes > UPLOAD_RULES.maxBytes) {
      await this.cloud.destroy([dto.publicId]).catch(() => undefined);
      await this.uploads.update({ id: row.id }, { status: 'deleted' });
      throw new ValidationFailed(
        { image: UPLOAD_RULES.tooLargeMessage },
        UPLOAD_RULES.tooLargeMessage,
      );
    }
    if (!UPLOAD_RULES.formats.includes(info.format.toLowerCase())) {
      await this.cloud.destroy([dto.publicId]).catch(() => undefined);
      await this.uploads.update({ id: row.id }, { status: 'deleted' });
      throw new ValidationFailed(
        { image: 'Use a JPG, PNG, WebP or HEIC photo.' },
        'Use a JPG, PNG, WebP or HEIC photo.',
      );
    }

    row.version = dto.version;
    row.size = info.bytes;
    row.width = info.width;
    row.height = info.height;
    row.mimetype = `image/${info.format.toLowerCase() === 'jpg' ? 'jpeg' : info.format.toLowerCase()}`;
    row.url = cloudinaryOriginalUrl(
      this.cloud.cloudName ?? '',
      dto.publicId,
      dto.version,
      info.format.toLowerCase(),
    );
    row.status = 'ready';
    await this.uploads.save(row);

    if (row.uploadType === UploadType.PROFILE_AVATAR) {
      await this.users.update(userId, {
        profile: { profilePictureUrl: row.url },
      });
    }
    return this.view(row);
  }

  view(row: Upload) {
    const cloud = this.cloud.cloudName ?? '';
    const v = row.version ?? 1;
    const pid = row.cloudinaryPublicId ?? '';
    return {
      id: row.id,
      publicId: pid,
      version: row.version ?? null,
      /** Full URL of the stored image (send this in a listing's `images`). */
      url: row.url,
      width: row.width ?? null,
      height: row.height ?? null,
      size: row.size,
      responsive: {
        thumb: cloudinaryUrl(cloud, pid, v, { width: 400 }),
        card: cloudinaryUrl(cloud, pid, v, { width: 800 }),
        full: cloudinaryUrl(cloud, pid, v, { width: UPLOAD_RULES.maxWidth }),
      },
    };
  }
}
