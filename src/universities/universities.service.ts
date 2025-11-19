// src/universities/universities.service.ts
import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { University } from '../users/entities/university.entity';
import { CreateUniversityDto } from './dto/create-university.dto';
import { UpdateUniversityDto } from './dto/update-university.dto';

@Injectable()
export class UniversitiesService {
  constructor(
    @InjectRepository(University)
    private universitiesRepository: Repository<University>,
  ) {}

  /**
   * Create a new university
   */
  async create(createUniversityDto: CreateUniversityDto): Promise<University> {
    // Check if code already exists
    if (createUniversityDto.code) {
      const existingUniversity = await this.universitiesRepository.findOne({
        where: { code: createUniversityDto.code },
      });

      if (existingUniversity) {
        throw new ConflictException('University with this code already exists');
      }
    }

    const university = this.universitiesRepository.create(createUniversityDto);
    return await this.universitiesRepository.save(university);
  }

  /**
   * Get all universities
   */
  async findAll(includeInactive: boolean = false): Promise<University[]> {
    const whereCondition = includeInactive ? {} : { isActive: true };

    return await this.universitiesRepository.find({
      where: whereCondition,
      order: { name: 'ASC' },
    });
  }

  /**
   * Get active universities only
   */
  async findActive(): Promise<University[]> {
    return await this.universitiesRepository.find({
      where: { isActive: true },
      order: { name: 'ASC' },
    });
  }

  /**
   * Get university by ID
   */
  async findOne(id: string): Promise<University> {
    const university = await this.universitiesRepository.findOne({
      where: { id },
      relations: ['profiles'],
    });

    if (!university) {
      throw new NotFoundException('University not found');
    }

    return university;
  }

  /**
   * Get university by code
   */
  async findByCode(code: string): Promise<University | null> {
    return await this.universitiesRepository.findOne({
      where: { code },
    });
  }

  /**
   * Search universities by name or location
   */
  async searchUniversities(query: string): Promise<University[]> {
    return await this.universitiesRepository.find({
      where: [
        { name: ILike(`%${query}%`), isActive: true },
        { location: ILike(`%${query}%`), isActive: true },
      ],
      order: { name: 'ASC' },
    });
  }

  /**
   * Update university
   */
  async update(
    id: string,
    updateUniversityDto: UpdateUniversityDto,
  ): Promise<University> {
    const university = await this.findOne(id);

    // Check if new code conflicts with existing university
    if (
      updateUniversityDto.code &&
      updateUniversityDto.code !== university.code
    ) {
      const existingUniversity = await this.findByCode(
        updateUniversityDto.code,
      );
      if (existingUniversity && existingUniversity.id !== id) {
        throw new ConflictException('University with this code already exists');
      }
    }

    Object.assign(university, updateUniversityDto);
    return await this.universitiesRepository.save(university);
  }

  /**
   * Soft delete - mark as inactive
   */
  async softDelete(id: string): Promise<void> {
    const university = await this.findOne(id);
    university.isActive = false;
    await this.universitiesRepository.save(university);
  }

  /**
   * Get universities with student count
   */
  async getUniversitiesWithStats(): Promise<
    Array<{
      id: string;
      name: string;
      location: string;
      code: string;
      isActive: boolean;
      studentCount: number;
    }>
  > {
    const universities = await this.universitiesRepository
      .createQueryBuilder('university')
      .leftJoin('university.profiles', 'profile')
      .select('university.id', 'id')
      .addSelect('university.name', 'name')
      .addSelect('university.location', 'location')
      .addSelect('university.code', 'code')
      .addSelect('university.isActive', 'isActive')
      .addSelect('COUNT(profile.id)', 'studentCount')
      .groupBy('university.id')
      .orderBy('university.name', 'ASC')
      .getRawMany();

    return universities.map((uni) => ({
      id: uni.id,
      name: uni.name,
      location: uni.location,
      code: uni.code,
      isActive: uni.isActive,
      studentCount: parseInt(uni.studentCount) || 0,
    }));
  }

  /**
   * Bulk create universities (for seeding)
   */
  async bulkCreate(universities: CreateUniversityDto[]): Promise<University[]> {
    const createdUniversities: University[] = [];

    for (const universityDto of universities) {
      try {
        const university = await this.create(universityDto);
        createdUniversities.push(university);
      } catch (error) {
        if (error instanceof ConflictException) {
          continue;
        }
        throw error;
      }
    }

    return createdUniversities;
  }
}
