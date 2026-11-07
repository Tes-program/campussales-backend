import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '../users/entities/user.entity';
import { CreateReportDto } from './reports.dto';
import { ReportsService } from './reports.service';

@ApiTags('Reports')
@Controller('reports')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  @ApiOperation({
    summary:
      'Report a listing, user or message. The reported user is never told who reported. The item disappears for the reporter at once.',
  })
  @ApiResponse({
    status: 201,
    description: '{ id, status, message, hiddenForYou }',
  })
  @ApiResponse({ status: 409, description: 'Already reported in the last 24h' })
  @ApiResponse({ status: 429, description: 'More than 20 reports today' })
  create(@CurrentUser() user: User, @Body() dto: CreateReportDto) {
    return this.reports.create(user, dto);
  }
}
