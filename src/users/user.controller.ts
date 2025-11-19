import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { UsersService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/role.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from './entities/user.entity';
import { UserType, UserStatus } from '../common/enum/user.enums';
import { PaginationDto } from '../common/dto/pagination.dto';
import { CompleteOnboardingDto } from './dto/onboarding.dto';

@ApiTags('Users')
@Controller('users')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @Roles(UserType.ADMIN)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: 'Create a new user (Admin only)' })
  @ApiResponse({ status: 201, description: 'User created successfully' })
  @ApiResponse({ status: 409, description: 'Email already exists' })
  async create(@Body() createUserDto: CreateUserDto) {
    return await this.usersService.create(createUserDto);
  }

  @Get()
  @Roles(UserType.ADMIN)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: 'Get all users (Admin only)' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiResponse({ status: 200, description: 'Users retrieved successfully' })
  async findAll(@Query() paginationDto: PaginationDto) {
    return await this.usersService.findAll(
      paginationDto.page,
      paginationDto.limit,
    );
  }

  //   @Get('me')
  //   @ApiOperation({ summary: 'Get current user profile' })
  //   @ApiResponse({ status: 200, description: 'Current user profile' })
  //   async getProfile(@CurrentUser() user: User) {
  //     return user;
  //   }

  //   @Get('me/stats')
  //   @ApiOperation({ summary: 'Get current user statistics' })
  //   @ApiResponse({ status: 200, description: 'User statistics' })
  //   async getMyStats(@CurrentUser() user: User) {
  //     return await this.usersService.getUserStats(user.id);
  //   }

  @Get(':id')
  @ApiOperation({ summary: 'Get user by ID' })
  @ApiResponse({ status: 200, description: 'User found' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return await this.usersService.findByIdOrFail(id);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update current user profile' })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  async updateProfile(
    @CurrentUser() user: User,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    return await this.usersService.update(user.id, updateUserDto);
  }

  @Patch(':id')
  @Roles(UserType.ADMIN)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: 'Update user by ID (Admin only)' })
  @ApiResponse({ status: 200, description: 'User updated successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    return await this.usersService.update(id, updateUserDto);
  }

  @Patch(':id/status')
  @Roles(UserType.ADMIN)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: 'Update user status (Admin only)' })
  @ApiResponse({ status: 200, description: 'Status updated successfully' })
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { status: UserStatus },
  ) {
    return await this.usersService.updateStatus(id, body.status);
  }

  @Patch(':id/verify')
  @Roles(UserType.ADMIN)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: 'Verify user (Admin only)' })
  @ApiResponse({ status: 200, description: 'User verified successfully' })
  async verifyUser(@Param('id', ParseUUIDPipe) id: string) {
    return await this.usersService.verifyUser(id);
  }

  @Delete('me')
  @ApiOperation({ summary: 'Deactivate current user account' })
  @ApiResponse({ status: 204, description: 'Account deactivated' })
  async deactivateAccount(@CurrentUser() user: User) {
    await this.usersService.softDelete(user.id);
  }

  @Delete(':id')
  @Roles(UserType.ADMIN)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: 'Delete user (Admin only)' })
  @ApiResponse({ status: 204, description: 'User deleted successfully' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.usersService.hardDelete(id);
  }

  // Add these endpoints to src/users/user.controller.ts

  @Post('onboarding/complete')
  @ApiOperation({ summary: 'Complete user onboarding' })
  @ApiResponse({
    status: 200,
    description: 'Onboarding completed successfully',
  })
  @ApiResponse({ status: 400, description: 'Invalid data' })
  async completeOnboarding(
    @CurrentUser() user: User,
    @Body() onboardingDto: CompleteOnboardingDto,
  ) {
    return await this.usersService.completeOnboarding(user.id, onboardingDto);
  }

  @Get('onboarding/status')
  @ApiOperation({ summary: 'Check onboarding status' })
  @ApiResponse({ status: 200, description: 'Onboarding status retrieved' })
  async getOnboardingStatus(@CurrentUser() user: User) {
    return await this.usersService.getOnboardingStatus(user.id);
  }

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Current user profile' })
  getProfile(@CurrentUser() user: User) {
    return user;
  }

  @Get('me/profile')
  @ApiOperation({ summary: 'Get current user profile with statistics' })
  @ApiResponse({ status: 200, description: 'Profile with stats retrieved' })
  async getProfileWithStats(@CurrentUser() user: User) {
    return await this.usersService.getUserProfile(user.id);
  }
}
