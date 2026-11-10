import {
  IsString,
  IsOptional,
  IsUUID,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  Matches,
  MaxLength,
  IsIn,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AttachmentInputDto {
  @ApiProperty({
    description:
      'Cloudinary URL from a completed signed upload with kind "chat" (JPEG, PNG or WebP, up to 3 MB).',
  })
  @IsString()
  @MaxLength(500)
  url: string;
}

/**
 * POST /chat/conversations/:id/messages and the `message:send` socket event.
 * Only the conversation id (in the path) and the token are needed: the
 * server knows the other participant. Length and content rules are checked
 * in ChatService so REST and sockets return the same error codes.
 */
export class SendMessageDto {
  @ApiPropertyOptional({
    description:
      'Client-generated id (e.g. a UUID). Sending again with the same id returns the same message instead of a duplicate.',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_.:-]{1,64}$/, {
    message: 'clientMessageId must be 1 to 64 letters, numbers, _ . : or -.',
  })
  clientMessageId?: string;

  @ApiPropertyOptional({
    description: 'Message text, trimmed, 1 to 1000 characters',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString({ message: 'Type a message.' })
  text?: string;

  @ApiPropertyOptional({ type: [AttachmentInputDto], maxItems: 4 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4, { message: 'Send up to 4 photos at a time.' })
  @ValidateNested({ each: true })
  @Type(() => AttachmentInputDto)
  attachments?: AttachmentInputDto[];

  @ApiPropertyOptional({ description: 'ID of message being replied to' })
  @IsOptional()
  @IsUUID()
  replyToId?: string;

  // ── legacy (one release) ──

  @ApiPropertyOptional({ deprecated: true, description: 'Use `text`.' })
  @IsOptional()
  @IsString({ message: 'Type a message.' })
  content?: string;

  @ApiPropertyOptional({
    enum: ['text', 'image'],
    description:
      'Optional, case-insensitive (TEXT or text). Derived from attachments when omitted; responses are always lowercase.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsIn(['text', 'image', 'file', 'system'], {
    message: 'Choose text or image.',
  })
  type?: string;

  @ApiPropertyOptional({ deprecated: true, description: 'Use `attachments`.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  attachmentUrl?: string;

  @ApiPropertyOptional({
    deprecated: true,
    description: 'Product shown with this message (legacy).',
  })
  @IsOptional()
  @IsUUID()
  productId?: string;
}
