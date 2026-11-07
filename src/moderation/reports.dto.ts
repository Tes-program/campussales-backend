import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsUUID } from 'class-validator';
import { Normalise, OptionalRule } from '../common/validation/decorators';
import { normaliseText } from '../common/validation/rules';
import { REPORT_REASONS, REPORT_TARGETS } from './report.entity';
import type { ReportReason, ReportTarget } from './report.entity';

// Control characters other than tab/newline (details may span lines).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

const validateDetails = (v: unknown) => {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length > 1000) {
    return 'Details must be 1000 characters or fewer.';
  }
  return CONTROL.test(v)
    ? "Details contain characters we can't display."
    : null;
};

export class CreateReportDto {
  @ApiProperty({ enum: REPORT_TARGETS })
  @IsIn(REPORT_TARGETS as unknown as string[], {
    message: 'Choose what you are reporting.',
  })
  targetType: ReportTarget;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: "We couldn't find what you're reporting." })
  targetId: string;

  @ApiProperty({ enum: REPORT_REASONS })
  @IsIn(REPORT_REASONS as unknown as string[], { message: 'Choose a reason.' })
  reason: ReportReason;

  @ApiPropertyOptional({ maxLength: 1000 })
  @Normalise(normaliseText)
  @OptionalRule(validateDetails)
  details?: string | null;
}
