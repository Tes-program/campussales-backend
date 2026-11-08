import { PublicCache } from '../common/http-cache/http-cache.interceptor';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { MSG } from '../common/errors/messages';
import { Normalise, OptionalRule } from '../common/validation/decorators';
import { normaliseText } from '../common/validation/rules';
import { SchoolsService } from './schools.service';
import { SCHOOL_SEARCH_LIMIT } from './school-search';

const queryCheck = (v: unknown) =>
  typeof v === 'string' && v.length <= 100 ? null : MSG.schoolQueryLong;

export class SchoolSearchQuery {
  @Normalise(normaliseText)
  @OptionalRule(queryCheck)
  query?: string;

  /** Alias of query. */
  @IsOptional()
  @Normalise(normaliseText)
  @OptionalRule(queryCheck)
  q?: string;
}

@ApiTags('Schools')
@Controller('schools')
export class SchoolsController {
  constructor(private readonly schools: SchoolsService) {}

  @Get()
  @PublicCache(600, 3600)
  @ApiOperation({
    summary: `Search schools (typo-tolerant, case-insensitive). Max ${SCHOOL_SEARCH_LIMIT} results.`,
  })
  @ApiQuery({ name: 'query', required: false, example: 'unilag' })
  @ApiResponse({ status: 200, description: '[{ id, name, shortName, city }]' })
  async search(@Query() params: SchoolSearchQuery) {
    return this.schools.search(params.query ?? params.q ?? '');
  }
}
