import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { ValidationFailed } from '../common/errors/app-errors';
import { RateLimit } from '../common/rate-limit/rate-limit.decorator';
import { User } from '../users/entities/user.entity';
import { AnalyticsService } from './analytics.service';
import { EVENT_LIMITS, EVENT_NAMES, validateEvents } from './event-schema';

/** Do Not Track / Global Privacy Control: honoured by dropping the batch. */
export function doNotTrack(req: Request): boolean {
  return req.headers['dnt'] === '1' || req.headers['sec-gpc'] === '1';
}

@ApiTags('Analytics')
@Controller('events')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Post()
  @UseGuards(OptionalJwtAuthGuard)
  @RateLimit('events')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: `Product analytics batch (max ${EVENT_LIMITS.maxBatch}). Allowlisted names and property keys; no emails, phone numbers or text over ${EVENT_LIMITS.maxString} characters. 204 immediately; written asynchronously. Dropped silently with DNT/Sec-GPC or when the user turned off "Share usage data".`,
  })
  @ApiBody({
    schema: {
      example: {
        events: [
          {
            name: 'search',
            ts: 1794150000000,
            anonId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
            props: { query: 'laptop', resultCount: 12 },
          },
        ],
      },
    },
  })
  @ApiResponse({
    status: 204,
    description: 'Accepted (or dropped by privacy settings)',
  })
  @ApiResponse({
    status: 400,
    description: `VALIDATION_FAILED. Event names: ${EVENT_NAMES.join(', ')}`,
  })
  track(
    @Req() req: Request,
    @Body() body: unknown,
    @CurrentUser() user?: User,
  ): void {
    const result = validateEvents(body);
    if ('errors' in result) {
      throw new ValidationFailed(
        result.errors,
        'Some events were not accepted. Check the fields.',
      );
    }
    if (doNotTrack(req)) return;
    if (user && user.shareUsageData === false) return;
    this.analytics.enqueue(result.events, user?.id ?? null);
  }
}
