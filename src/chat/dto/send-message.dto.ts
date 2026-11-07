import { IsString, IsOptional, IsIn, IsUUID, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MessageType } from '../enums/chat.enums';

export class SendMessageDto {
  @ApiProperty({ description: 'Message content (trimmed)', maxLength: 1000 })
  @IsString({ message: 'Type a message.' })
  @MaxLength(1000, { message: 'Messages can be up to 1000 characters.' })
  content: string;

  @ApiPropertyOptional({ enum: MessageType, default: MessageType.TEXT })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsIn([MessageType.TEXT, MessageType.IMAGE, MessageType.FILE], {
    message: 'Choose text, image or file.',
  })
  type?: MessageType;

  @ApiPropertyOptional({ description: 'URL of attached media (from uploads)' })
  @IsOptional()
  @IsString()
  attachmentUrl?: string;

  @ApiPropertyOptional({ description: 'ID of message being replied to' })
  @IsOptional()
  @IsUUID()
  replyToId?: string;

  @ApiPropertyOptional({
    description: 'Product ID to attach product context to this message',
  })
  @IsOptional()
  @IsUUID()
  productId?: string;
}
