// src/universities/universities.controller.ts
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
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { UniversitiesService } from './universities.service';
import { CreateUniversityDto } from './dto/create-university.dto';
import { UpdateUniversityDto } from './dto/update-university.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/role.decorator';
import { UserType } from '../common/enum/user.enums';

@ApiTags('Universities')
@Controller('universities')
export class UniversitiesController {
  constructor(private readonly universitiesService: UniversitiesService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserType.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new university (Admin only)' })
  @ApiResponse({ status: 201, description: 'University created successfully' })
  @ApiResponse({ status: 409, description: 'University code already exists' })
  async create(@Body() createUniversityDto: CreateUniversityDto) {
    return await this.universitiesService.create(createUniversityDto);
  }

  @Post('bulk')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserType.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Bulk create universities (Admin only)' })
  @ApiResponse({
    status: 201,
    description: 'Universities created successfully',
  })
  async bulkCreate(@Body() universities: CreateUniversityDto[]) {
    return await this.universitiesService.bulkCreate(universities);
  }

  @Get()
  @ApiOperation({ summary: 'Get all universities' })
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  @ApiResponse({
    status: 200,
    description: 'Universities retrieved successfully',
  })
  async findAll(@Query('includeInactive') includeInactive?: string) {
    const includeInactiveFlag = includeInactive === 'true';
    return await this.universitiesService.findAll(includeInactiveFlag);
  }

  @Get('active')
  @ApiOperation({ summary: 'Get active universities only' })
  @ApiResponse({ status: 200, description: 'Active universities retrieved' })
  async findActive() {
    return await this.universitiesService.findActive();
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get universities with student statistics' })
  @ApiResponse({ status: 200, description: 'University statistics retrieved' })
  async getUniversitiesWithStats() {
    return await this.universitiesService.getUniversitiesWithStats();
  }

  @Get('search')
  @ApiOperation({ summary: 'Search universities by name or location' })
  @ApiQuery({ name: 'q', required: true, type: String })
  @ApiResponse({ status: 200, description: 'Search results retrieved' })
  async search(@Query('q') query: string) {
    return await this.universitiesService.searchUniversities(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get university by ID' })
  @ApiResponse({ status: 200, description: 'University found' })
  @ApiResponse({ status: 404, description: 'University not found' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return await this.universitiesService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserType.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update university (Admin only)' })
  @ApiResponse({ status: 200, description: 'University updated successfully' })
  @ApiResponse({ status: 404, description: 'University not found' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUniversityDto: UpdateUniversityDto,
  ) {
    return await this.universitiesService.update(id, updateUniversityDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserType.ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Deactivate university (Admin only)' })
  @ApiResponse({ status: 204, description: 'University deactivated' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.universitiesService.softDelete(id);
  }
}
