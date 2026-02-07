// src/uploads/uploads.controller.ts
import {
  Controller,
  Post,
  Delete,
  Get,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  ParseUUIDPipe,
  Logger,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { UploadsService } from './uploads.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { UploadType } from './entities/upload.entitiy';
import {
  UploadResponseDto,
  MultipleUploadResponseDto,
} from './dto/upload-response.dto';

@ApiTags('Uploads')
@Controller('uploads')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class UploadsController {
  private readonly logger = new Logger(UploadsController.name);

  constructor(private readonly uploadsService: UploadsService) {}

  @Post('product-images')
  @UseInterceptors(FilesInterceptor('images', 5))
  @ApiOperation({ summary: 'Upload product images (max 5)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        images: {
          type: 'array',
          items: {
            type: 'string',
            format: 'binary',
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Images uploaded successfully',
    type: MultipleUploadResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid file or too many files' })
  async uploadProductImages(
    @CurrentUser() user: User,
    @UploadedFiles() files: Express.Multer.File[],
  ): Promise<MultipleUploadResponseDto> {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files uploaded');
    }

    this.logger.log(`User ${user.id} uploading ${files.length} product images`);

    const uploads = await this.uploadsService.saveMultipleUploads(
      user.id,
      files,
      UploadType.PRODUCT_IMAGE,
    );

    return {
      files: uploads.map((upload) => ({
        id: upload.id,
        filename: upload.filename,
        url: upload.url,
        size: upload.size,
        mimetype: upload.mimetype,
      })),
      message: `Successfully uploaded ${uploads.length} image(s)`,
    };
  }

  @Post('avatar')
  @UseInterceptors(FileInterceptor('avatar'))
  @ApiOperation({ summary: 'Upload profile avatar' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        avatar: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Avatar uploaded successfully',
    type: UploadResponseDto,
  })
  async uploadAvatar(
    @CurrentUser() user: User,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<UploadResponseDto> {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    this.logger.log(`User ${user.id} uploading profile avatar`);

    const upload = await this.uploadsService.saveUpload(
      user.id,
      file,
      UploadType.PROFILE_AVATAR,
    );

    return {
      id: upload.id,
      filename: upload.filename,
      url: upload.url,
      size: upload.size,
      mimetype: upload.mimetype,
    };
  }

  @Get('my-uploads')
  @ApiOperation({ summary: 'Get user uploads' })
  @ApiResponse({ status: 200, description: 'Uploads retrieved successfully' })
  async getMyUploads(
    @CurrentUser() user: User,
    @Query('type') uploadType?: UploadType,
  ): Promise<UploadResponseDto[]> {
    const uploads = await this.uploadsService.getUserUploads(
      user.id,
      uploadType,
    );
    return uploads.map((upload) => ({
      id: upload.id,
      filename: upload.filename,
      url: upload.url,
      size: upload.size,
      mimetype: upload.mimetype,
    }));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete upload' })
  @ApiResponse({ status: 204, description: 'Upload deleted successfully' })
  @ApiResponse({ status: 404, description: 'Upload not found' })
  @ApiResponse({ status: 403, description: 'Not authorized to delete' })
  async deleteUpload(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    this.logger.log(`User ${user.id} deleting upload ${id}`);
    await this.uploadsService.deleteUpload(id, user.id);
  }
}
