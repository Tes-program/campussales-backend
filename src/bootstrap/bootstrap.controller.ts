import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PublicCache } from '../common/http-cache/http-cache.interceptor';
import { User } from '../users/entities/user.entity';
import { BootstrapService } from './bootstrap.service';

@ApiTags('Bootstrap')
@Controller('bootstrap')
export class BootstrapController {
  constructor(private readonly bootstrap: BootstrapService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary:
      'First screen in one request (logged in): user, unread counts, wishlist ids, categories with counts, school list version, flags, first feed page.',
  })
  @ApiResponse({
    status: 401,
    description: 'Refresh the token and retry, or use /bootstrap/public.',
  })
  forUser(@CurrentUser() user: User) {
    return this.bootstrap.forUser(user);
  }

  @Get('public')
  @PublicCache(30, 60)
  @ApiOperation({
    summary:
      'First screen for logged-out visitors: categories, school list version, flags, latest listings.',
  })
  forVisitor() {
    return this.bootstrap.forVisitor();
  }
}
