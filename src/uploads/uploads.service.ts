// src/uploads/uploads.service.ts
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Upload, UploadType } from './entities/upload.entitiy';
import { v2 as cloudinary } from 'cloudinary';
import { open, unlink } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { getBaseUrl } from './storage.config';
import { UsersService } from '../users/user.service';
import { CloudinaryClient } from './cloudinary.client';
import { IMAGE_HEADER_BYTES, imageSize } from './image-size';
import { isTooSmall, UPLOAD_RULES } from './upload-rules';
import { ValidationFailed } from '../common/errors/app-errors';

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    @InjectRepository(Upload)
    private uploadsRepository: Repository<Upload>,
    private configService: ConfigService,
    private usersService: UsersService,
    private cloud: CloudinaryClient,
  ) {}

  /**
   * Legacy multipart listing photos: rejects the request when any photo is
   * under 400x300 and removes every file it stored, so nothing is left
   * behind. A photo whose size can't be read is let through.
   */
  async assertListingPhotoSizes(files: Express.Multer.File[]): Promise<void> {
    const sizes = await Promise.all(files.map((f) => this.storedSize(f)));
    if (!sizes.some((s) => s && isTooSmall(s.width, s.height))) return;
    await Promise.all(files.map((f) => this.removeStoredFile(f)));
    throw new ValidationFailed(
      { images: UPLOAD_RULES.tooSmallMessage },
      UPLOAD_RULES.tooSmallMessage,
    );
  }

  private isCloudinary(): boolean {
    return (this.configService.get('STORAGE_TYPE') || 'local') === 'cloudinary';
  }

  private async storedSize(
    file: Express.Multer.File,
  ): Promise<{ width: number; height: number } | null> {
    try {
      if (this.isCloudinary()) {
        const r = await this.cloud.resource(file.filename);
        return r ? { width: r.width, height: r.height } : null;
      }
      const fh = await open(
        file.path ?? join(process.cwd(), 'uploads', file.filename),
        'r',
      );
      try {
        const buf = Buffer.alloc(IMAGE_HEADER_BYTES);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        return imageSize(buf.subarray(0, bytesRead));
      } finally {
        await fh.close();
      }
    } catch (e) {
      this.logger.warn(
        `Could not read the size of ${file.filename}: ${(e as Error).message}`,
      );
      return null;
    }
  }

  private async removeStoredFile(file: Express.Multer.File): Promise<void> {
    try {
      if (this.isCloudinary()) await this.cloud.destroy([file.filename]);
      else
        await unlink(
          file.path ?? join(process.cwd(), 'uploads', file.filename),
        );
    } catch (e) {
      this.logger.warn(
        `Could not remove rejected upload ${file.filename}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Save uploaded file metadata to database
   */
  async saveUpload(
    userId: string,
    file: Express.Multer.File,
    uploadType: UploadType = UploadType.PRODUCT_IMAGE,
  ): Promise<Upload> {
    const storageType = this.configService.get('STORAGE_TYPE') || 'local';
    const baseUrl = getBaseUrl(this.configService);

    let url: string;
    let cloudinaryPublicId: string | undefined;

    if (storageType === 'cloudinary') {
      // Cloudinary file
      const cloudinaryFile = file as any;
      url = cloudinaryFile.path;
      cloudinaryPublicId = cloudinaryFile.filename;
    } else {
      // Local file
      url = `${baseUrl}/uploads/${file.filename}`;
    }

    const upload = this.uploadsRepository.create({
      userId,
      filename: file.filename,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      url,
      uploadType,
      cloudinaryPublicId,
    });

    const savedUpload = await this.uploadsRepository.save(upload);
    this.logger.log(`Upload saved: ${savedUpload.id} for user ${userId}`);

    // Auto-update user profile picture when uploading an avatar
    if (uploadType === UploadType.PROFILE_AVATAR) {
      try {
        await this.usersService.update(userId, {
          profile: { profilePictureUrl: savedUpload.url },
        });
        this.logger.log(`Auto-updated profile picture for user ${userId}`);
      } catch (error) {
        this.logger.warn(
          `Failed to auto-update profile picture for user ${userId}: ${error.message}`,
        );
      }
    }

    return savedUpload;
  }

  /**
   * Save multiple uploads
   */
  async saveMultipleUploads(
    userId: string,
    files: Express.Multer.File[],
    uploadType: UploadType = UploadType.PRODUCT_IMAGE,
  ): Promise<Upload[]> {
    const uploads = await Promise.all(
      files.map((file) => this.saveUpload(userId, file, uploadType)),
    );

    return uploads;
  }

  /**
   * Get upload by ID
   */
  async findById(id: string): Promise<Upload> {
    const upload = await this.uploadsRepository.findOne({ where: { id } });

    if (!upload) {
      throw new NotFoundException('Upload not found');
    }

    return upload;
  }

  /**
   * Get user's uploads
   */
  async getUserUploads(
    userId: string,
    uploadType?: UploadType,
  ): Promise<Upload[]> {
    const where: any = { userId };

    if (uploadType) {
      where.uploadType = uploadType;
    }

    return await this.uploadsRepository.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Delete upload
   */
  async deleteUpload(id: string, userId: string): Promise<void> {
    const upload = await this.findById(id);

    // Check ownership
    if (upload.userId !== userId) {
      throw new ForbiddenException('You can only delete your own uploads');
    }

    const storageType = this.configService.get('STORAGE_TYPE') || 'local';

    try {
      if (storageType === 'cloudinary' && upload.cloudinaryPublicId) {
        // Delete from Cloudinary
        await cloudinary.uploader.destroy(upload.cloudinaryPublicId);
        this.logger.log(
          `Deleted from Cloudinary: ${upload.cloudinaryPublicId}`,
        );
      } else {
        // Delete local file
        const filePath = join(process.cwd(), 'uploads', upload.filename);
        if (existsSync(filePath)) {
          await unlink(filePath);
          this.logger.log(`Deleted local file: ${filePath}`);
        }
      }
    } catch (error) {
      this.logger.error(`Failed to delete file: ${error.message}`);
      // Continue to delete from database even if file deletion fails
    }

    // Delete from database
    await this.uploadsRepository.remove(upload);
    this.logger.log(`Upload deleted from database: ${id}`);
  }

  /**
   * Delete multiple uploads
   */
  async deleteMultipleUploads(
    uploadIds: string[],
    userId: string,
  ): Promise<void> {
    await Promise.all(uploadIds.map((id) => this.deleteUpload(id, userId)));
  }

  /**
   * Cleanup orphaned uploads (files not associated with any product/user)
   * This can be run as a cron job
   */
  async cleanupOrphanedUploads(): Promise<number> {
    // Find uploads older than 24 hours with no associated products
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

    const orphanedUploads = await this.uploadsRepository
      .createQueryBuilder('upload')
      .where('upload.createdAt < :date', { date: twentyFourHoursAgo })
      .getMany();

    let deletedCount = 0;

    for (const upload of orphanedUploads) {
      try {
        await this.deleteUpload(upload.id, upload.userId);
        deletedCount++;
      } catch (error) {
        this.logger.error(
          `Failed to cleanup upload ${upload.id}: ${error.message}`,
        );
      }
    }

    this.logger.log(`Cleaned up ${deletedCount} orphaned uploads`);
    return deletedCount;
  }
}
