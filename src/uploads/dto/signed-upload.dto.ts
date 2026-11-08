import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { UPLOAD_RULES } from '../upload-rules';

export class SignUploadDto {
  @ApiPropertyOptional({ enum: ['product', 'avatar'], default: 'product' })
  @IsOptional()
  @IsIn(['product', 'avatar'], { message: 'Choose product or avatar.' })
  kind?: 'product' | 'avatar';

  @ApiPropertyOptional({
    minimum: 1,
    maximum: UPLOAD_RULES.maxImagesPerListing,
    default: 1,
  })
  @IsOptional()
  @IsInt({ message: 'Send a whole number of photos.' })
  @Min(1, { message: 'Send at least 1 photo.' })
  @Max(UPLOAD_RULES.maxImagesPerListing, {
    message: `You can add up to ${UPLOAD_RULES.maxImagesPerListing} photos at a time.`,
  })
  count?: number;
}

export class CompleteUploadDto {
  @ApiProperty()
  @IsUUID('4', { message: 'This upload link is not valid.' })
  uploadId: string;

  @ApiProperty({ description: 'public_id from Cloudinary’s response' })
  @IsString()
  @MaxLength(255)
  @Matches(/^campussales\/(products|avatars)\/[0-9a-f-]{36}$/, {
    message: 'This upload is not valid.',
  })
  publicId: string;

  @ApiProperty({ description: 'version from Cloudinary’s response' })
  @IsInt({ message: 'This upload is not valid.' })
  @Min(1)
  version: number;

  @ApiProperty({ description: 'signature from Cloudinary’s response' })
  @IsString()
  @Matches(/^[0-9a-f]{40,64}$/, { message: 'This upload is not valid.' })
  signature: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10)
  format?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  bytes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  width?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  height?: number;
}
