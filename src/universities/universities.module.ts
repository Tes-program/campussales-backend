// src/universities/universities.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UniversitiesService } from './universities.service';
import { UniversitiesController } from './universities.controller';
import { University } from '../users/entities/university.entity';
import { SchoolsController } from './schools.controller';
import { SchoolsService } from './schools.service';

@Module({
  imports: [TypeOrmModule.forFeature([University])],
  controllers: [UniversitiesController, SchoolsController],
  providers: [UniversitiesService, SchoolsService],
  exports: [UniversitiesService, SchoolsService],
})
export class UniversitiesModule {}
