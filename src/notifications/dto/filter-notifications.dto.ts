import {
  IsOptional,
  IsEnum,
  IsInt,
  Min,
  Max,
  IsString,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class FilterNotificationsDto {
  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiProperty({
    required: false,
    enum: ['all', 'unread'],
    default: 'all',
  })
  @IsOptional()
  @IsEnum(['all', 'unread'])
  type?: 'all' | 'unread' = 'all';

  @ApiProperty({
    required: false,
    description: 'nextCursor from the previous page.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  cursor?: string;
}
