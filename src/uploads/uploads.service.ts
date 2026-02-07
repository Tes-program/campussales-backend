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
import { unlink } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { getBaseUrl } from './storage.config';

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    @InjectRepository(Upload)
    private uploadsRepository: Repository<Upload>,
    private configService: ConfigService,
  ) {}

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
