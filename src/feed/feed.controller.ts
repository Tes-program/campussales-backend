import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ValidationFailed } from '../common/errors/app-errors';
import { User } from '../users/entities/user.entity';
import { FEED_PAGE, FeedService } from './feed.service';

@ApiTags('Feed')
@Controller('feed')
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Personal feed (campus, interests, recency, price drops).',
  })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, example: FEED_PAGE })
  async get(
    @CurrentUser() user: User,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    let offset = 0;
    if (cursor) {
      try {
        const o = (
          JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
            o: number;
          }
        ).o;
        if (!Number.isInteger(o) || o < 0) throw new Error();
        offset = o;
      } catch {
        throw new ValidationFailed({
          cursor: 'This page link has expired. Please reload.',
        });
      }
    }
    const limit = limitRaw === undefined ? FEED_PAGE : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new ValidationFailed({ limit: 'Show between 1 and 50 items.' });
    }
    return this.feed.feed(user, offset, limit);
  }
}
