// src/uploads/storage.config.ts
import { diskStorage } from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import { ConfigService } from '@nestjs/config';
import { MulterModuleOptions } from '@nestjs/platform-express';
import { BadRequestException } from '@nestjs/common';
import { extname } from 'path';
import { existsSync, mkdirSync } from 'fs';

export const getStorageConfig = (
  configService: ConfigService,
): MulterModuleOptions => {
  const storageType = configService.get('STORAGE_TYPE') || 'local';

  // Common file filter
  const fileFilter = (req: any, file: any, cb: any) => {
    const allowedMimeTypes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
    ];

    if (!allowedMimeTypes.includes(file.mimetype)) {
      cb(
        new BadRequestException(
          'Only image files (JPEG, PNG, WebP) are allowed',
        ),
        false,
      );
      return;
    }
    cb(null, true);
  };

  const limits = {
    fileSize: 5 * 1024 * 1024, // 5MB
    files: 5, // Max 5 files per upload
  };

  if (storageType === 'cloudinary') {
    // Configure Cloudinary
    cloudinary.config({
      cloud_name: configService.get('CLOUDINARY_CLOUD_NAME'),
      api_key: configService.get('CLOUDINARY_API_KEY'),
      api_secret: configService.get('CLOUDINARY_API_SECRET'),
    });

    return {
      storage: new CloudinaryStorage({
        cloudinary: cloudinary,
        params: (req, file) => {
          return {
            folder: 'campussales',
            allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
            public_id: `${Date.now()}-${file.originalname.split('.')[0]}`,
            transformation: [
              { width: 1200, height: 1200, crop: 'limit', quality: 'auto' },
            ],
          };
        },
      }),
      fileFilter,
      limits,
    };
  }

  // Local file storage
  const uploadPath = './uploads';

  // Create uploads directory if it doesn't exist
  if (!existsSync(uploadPath)) {
    mkdirSync(uploadPath, { recursive: true });
  }

  return {
    storage: diskStorage({
      destination: uploadPath,
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = extname(file.originalname);
        cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
      },
    }),
    fileFilter,
    limits,
  };
};

// Helper to get base URL for local storage
export const getBaseUrl = (configService: ConfigService): string => {
  const storageType = configService.get('STORAGE_TYPE') || 'local';

  if (storageType === 'cloudinary') {
    return ''; // Cloudinary returns full URLs
  }

  return configService.get('BACKEND_URL') || 'http://localhost:3000';
};
