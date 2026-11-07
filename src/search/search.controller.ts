import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ValidationFailed } from '../common/errors/app-errors';
import { SearchService } from './search.service';

@ApiTags('Search')
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get('suggest')
  @ApiOperation({
    summary: 'Up to 8 suggestions (categories, popular titles). Cached 60s.',
  })
  @ApiQuery({ name: 'q', required: true })
  async suggest(@Query('q') q?: string) {
    if (typeof q !== 'string' || q.length > 100) {
      throw new ValidationFailed({
        q: 'Search must be 100 characters or fewer.',
      });
    }
    return { suggestions: await this.search.suggest(q) };
  }
}
