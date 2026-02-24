import {
  IsString,
  IsOptional,
  IsEnum,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MessageType } from '../enums/chat.enums';

export class SendMessageDto {
  @ApiProperty({ description: 'Message content', maxLength: 5000 })
  @IsString()
  @MaxLength(5000)
  content: string;

  @ApiPropertyOptional({ enum: MessageType, default: MessageType.TEXT })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsEnum(MessageType)
  type?: MessageType;

  @ApiPropertyOptional({ description: 'URL of attached media (from uploads)' })
  @IsOptional()
  @IsString()
  attachmentUrl?: string;

  @ApiPropertyOptional({ description: 'ID of message being replied to' })
  @IsOptional()
  @IsUUID()
  replyToId?: string;
}
