import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '../users/entities/user.entity';
import { BlocksService } from './blocks.service';

export class BlockUserDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: "We couldn't find that person." })
  userId: string;
}

@ApiTags('Blocks')
@Controller('blocks')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class BlocksController {
  constructor(private readonly blocks: BlocksService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Block a user (idempotent).' })
  block(@CurrentUser() user: User, @Body() dto: BlockUserDto) {
    return this.blocks.block(user.id, dto.userId);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unblock a user (idempotent).' })
  async unblock(
    @CurrentUser() user: User,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    await this.blocks.unblock(user.id, userId);
  }

  @Get()
  @ApiOperation({ summary: 'People you blocked.' })
  list(@CurrentUser() user: User) {
    return this.blocks.list(user.id);
  }
}
