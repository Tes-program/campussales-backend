import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ValidationFailed } from '../common/errors/app-errors';
import { CATEGORY_SLUGS } from '../common/constants/categories';
import { Normalise, Rule } from '../common/validation/decorators';
import {
  normaliseInterests,
  validateInterests,
} from '../common/validation/rules';
import { User } from '../users/entities/user.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateInterestsDto {
  @ApiProperty({ type: [String], enum: CATEGORY_SLUGS, maxItems: 8 })
  @Normalise(normaliseInterests)
  @Rule((v) =>
    v === undefined ? 'Send a list of interests.' : validateInterests(v),
  )
  interests: string[];
}

@ApiTags('Me')
@Controller('me')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MeController {
  constructor(
    @InjectRepository(UserProfile)
    private readonly profiles: Repository<UserProfile>,
  ) {}

  @Get('interests')
  @ApiOperation({ summary: 'Category slugs the feed boosts.' })
  getInterests(@CurrentUser() user: User) {
    return { interests: user.profile?.interests ?? [] };
  }

  @Patch('interests')
  @ApiOperation({ summary: 'Replace interests (0 to 8 category slugs).' })
  async setInterests(
    @CurrentUser() user: User,
    @Body() dto: UpdateInterestsDto,
  ) {
    const profile = await this.profiles.findOne({ where: { userId: user.id } });
    if (!profile) {
      throw new ValidationFailed(
        { interests: 'Finish setting up your profile first.' },
        'Finish setting up your profile first.',
      );
    }
    profile.interests = dto.interests;
    await this.profiles.save(profile);
    return { interests: dto.interests };
  }
}
