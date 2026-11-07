import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '../users/entities/user.entity';
import { PrivacyService } from './privacy.service';

export class ConsentsDto {
  @ApiPropertyOptional({ example: '2026-11-01' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  termsVersion?: string;

  @ApiPropertyOptional({ example: '2026-11-01' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  privacyVersion?: string;
}

export class DeleteAccountDto {
  @ApiProperty({ description: 'Must be the literal text DELETE.' })
  @IsString()
  confirm: string;
}

/**
 * Data export and account deletion. NEEDS LEGAL REVIEW before launch
 * (Nigeria Data Protection Act 2023). We do not claim compliance.
 */
@ApiTags('Privacy')
@Controller('me')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Get('export')
  @ApiOperation({ summary: 'Download a JSON copy of your data (3 per day).' })
  export(@CurrentUser() user: User) {
    return this.privacy.export(user);
  }

  @Delete('account')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Request account deletion. 30-day grace (log in to cancel); then personal data is deleted and chats anonymised.',
  })
  requestDeletion(@CurrentUser() user: User, @Body() dto: DeleteAccountDto) {
    return this.privacy.requestDeletion(user, dto.confirm);
  }

  @Post('consents')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record acceptance of the current terms and/or privacy policy.',
  })
  consents(@CurrentUser() user: User, @Body() dto: ConsentsDto) {
    return this.privacy.recordConsents(user, dto);
  }
}
