import { IsUUID, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConversationType } from '../enums/chat.enums';

export class CreateConversationDto {
  @ApiProperty({ description: 'ID of the other participant' })
  @IsUUID()
  participantId: string;

  @ApiPropertyOptional({ description: 'Product ID if this is a product inquiry' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ enum: ConversationType, default: ConversationType.DIRECT })
  @IsOptional()
  @IsEnum(ConversationType)
  type?: ConversationType;
}
