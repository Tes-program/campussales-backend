import {
  IsOptional,
  IsEnum,
  IsInt,
  Min,
  Max,
  IsString,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum ConversationFilter {
  ALL = 'all',
  UNREAD = 'unread',
}

export class FilterConversationsDto {
  @ApiPropertyOptional({ description: 'nextCursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ default: 20, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({
    enum: ConversationFilter,
    default: ConversationFilter.ALL,
  })
  @IsOptional()
  @IsEnum(ConversationFilter)
  filter?: ConversationFilter;

  @ApiPropertyOptional({
    description: 'true lists archived chats only; default lists the inbox.',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  archived?: 'true' | 'false';

  @ApiPropertyOptional({ deprecated: true, description: 'Use cursor.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
