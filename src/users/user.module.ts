import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersService } from './user.service';
import { UsersController } from './user.controller';
import { User } from './entities/user.entity';
import { UserProfile } from './entities/user-profile.entity';
import { University } from './entities/university.entity';
import { Logger } from '@nestjs/common';
import { UniversitiesModule } from '../universities/universities.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, UserProfile, University]),
    UniversitiesModule,
  ],
  controllers: [UsersController],
  providers: [UsersService, Logger],
  exports: [UsersService],
})
export class UsersModule {}
