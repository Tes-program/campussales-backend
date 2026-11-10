import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { REPORT_REASONS } from '../../moderation/report.entity';

export class MarkReadDto {
  @ApiPropertyOptional({
    description:
      'Highest seq the reader has seen. Omit to mark the whole conversation read.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  upToSeq?: number;
}

export class ConversationSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional({
    description: 'Muted chats send no push or email notifications.',
  })
  @IsOptional()
  @IsBoolean()
  muted?: boolean;
}

export class DeleteMessageQueryDto {
  @ApiPropertyOptional({
    enum: ['me', 'everyone'],
    default: 'me',
    description:
      '"me" hides it for you only. "everyone" works on your own messages within 10 minutes.',
  })
  @IsOptional()
  @IsIn(['me', 'everyone'])
  for?: 'me' | 'everyone';
}

export class ReportMessageDto {
  @ApiProperty({ enum: REPORT_REASONS })
  @IsIn(REPORT_REASONS as unknown as string[], { message: 'Choose a reason.' })
  reason: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  details?: string;
}

export class ChatSettingsDto {
  @ApiPropertyOptional({
    description:
      'Let people you chat with see when you are online and last active.',
  })
  @IsOptional()
  @IsBoolean()
  showPresence?: boolean;
}
