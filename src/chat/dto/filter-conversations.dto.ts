import { IsOptional, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../common/dto/pagination.dto';

export enum ConversationFilter {
  ALL = 'all',
  UNREAD = 'unread',
}

export class FilterConversationsDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: ConversationFilter,
    default: ConversationFilter.ALL,
  })
  @IsOptional()
  @IsEnum(ConversationFilter)
  filter?: ConversationFilter = ConversationFilter.ALL;
}
