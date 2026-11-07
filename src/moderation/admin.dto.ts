import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export const ADMIN_ACTIONS = [
  'approve',
  'reject',
  'remove',
  'warn_user',
  'suspend_user',
  'unsuspend_user',
  'clear_user_review',
  'dismiss_report',
] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

export class AdminActionDto {
  @ApiProperty({ enum: ADMIN_ACTIONS })
  @IsIn(ADMIN_ACTIONS as unknown as string[], { message: 'Unknown action.' })
  action: AdminAction;

  @ApiProperty({
    format: 'uuid',
    description:
      'Listing id (approve/reject/remove), user id (warn/suspend/...), report id (dismiss_report).',
  })
  @IsUUID('all', { message: 'targetId must be an id.' })
  targetId: string;

  @ApiPropertyOptional({
    description: 'Shown to the owner for reject/remove/warn/suspend.',
    maxLength: 300,
  })
  @IsOptional()
  @IsString()
  @MaxLength(300, { message: 'Reason must be 300 characters or fewer.' })
  reason?: string;
}

export class DryRunDto {
  @ApiProperty() @IsString() @MaxLength(200) title: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsString({ each: true })
  tags?: string[];
  @ApiPropertyOptional() @IsOptional() price?: number;
}
