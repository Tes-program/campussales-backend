import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, IsOptional, IsUUID, ValidateNested } from 'class-validator';
import { MSG } from '../../common/errors/messages';
import { UpdateDraftDto } from './update-draft.dto';

/** Schema for POST /api/products/drafts/auto-save. */
export class AutoSaveDraftDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MSG.invalidValue })
  draftId?: string;

  @ApiProperty({ type: UpdateDraftDto })
  @IsDefined({ message: MSG.required })
  @ValidateNested()
  @Type(() => UpdateDraftDto)
  data: UpdateDraftDto;
}
