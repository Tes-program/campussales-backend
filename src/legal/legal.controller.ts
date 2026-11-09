import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { frontendUrl } from '../auth/auth.config';
import { PublicCache } from '../common/http-cache/http-cache.interceptor';
import { legalVersions } from '../config/legal';
import type { LegalVersions } from '../config/legal';

@ApiTags('Legal')
@Controller('legal')
export class LegalController {
  constructor(private readonly config: ConfigService) {}

  @Get('versions')
  @PublicCache(300)
  @ApiOperation({
    summary:
      'Current Terms and Privacy Policy versions. Send termsVersion as acceptedTermsVersion at sign-up. Public; cacheable for 5 minutes.',
  })
  @ApiResponse({
    status: 200,
    description: '{ termsVersion, privacyVersion, termsUrl, privacyUrl }',
  })
  versions(): LegalVersions {
    return legalVersions(frontendUrl(this.config));
  }
}
