// src/uploads/storage.config.ts
import { diskStorage } from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import { ConfigService } from '@nestjs/config';
import { MulterModuleOptions } from '@nestjs/platform-express';
import { ValidationFailed } from '../common/errors/app-errors';
import { UPLOAD_RULES } from './upload-rules';
import { extname } from 'path';
import { existsSync, mkdirSync } from 'fs';

export const getStorageConfig = (
  configService: ConfigService,
): MulterModuleOptions => {
  const storageType = configService.get('STORAGE_TYPE') || 'local';

  // Common file filter
  const fileFilter = (req: any, file: any, cb: any) => {
    if (!UPLOAD_RULES.mimeTypes.includes(file.mimetype)) {
      cb(
        new ValidationFailed(
          { images: 'Use a JPG, PNG, WebP or HEIC photo.' },
          'Use a JPG, PNG, WebP or HEIC photo.',
        ),
        false,
      );
      return;
    }
    cb(null, true);
  };

  const limits = {
    fileSize: UPLOAD_RULES.maxBytes, // 3 MB (B5)
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
              {
                width: UPLOAD_RULES.maxWidth,
                height: UPLOAD_RULES.maxWidth,
                crop: 'limit',
                quality: 'auto:good',
              },
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
