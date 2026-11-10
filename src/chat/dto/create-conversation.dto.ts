import { IsUUID, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConversationType } from '../enums/chat.enums';

export class CreateConversationDto {
  @ApiProperty({ description: 'ID of the other participant' })
  @IsUUID()
  participantId: string;

  @ApiPropertyOptional({
    description:
      'The listing this chat is about. One conversation per (buyer, seller, product); without it, the general chat between the two people.',
  })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({
    enum: ConversationType,
    deprecated: true,
    description: 'Ignored: derived from productId.',
  })
  @IsOptional()
  @IsEnum(ConversationType)
  type?: ConversationType;
}
