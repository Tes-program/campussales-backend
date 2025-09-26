import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { UserProfile } from './entities/user-profile.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserType, UserStatus } from '../common/enum/user.enums';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(UserProfile)
    private userProfileRepository: Repository<UserProfile>,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<User> {
    // Check if user already exists
    const existingUser = await this.findByEmail(createUserDto.email);
    if (existingUser) {
      throw new ConflictException('Email already exists');
    }

    // Create user
    const user = this.usersRepository.create({
      email: createUserDto.email,
      passwordHash: createUserDto.passwordHash,
      phoneNumber: createUserDto.phoneNumber,
      userType: createUserDto.userType || UserType.STUDENT,
      status: UserStatus.ACTIVE,
    });

    const savedUser = await this.usersRepository.save(user);

    // Create user profile if provided
    if (createUserDto.profile) {
      const profile = this.userProfileRepository.create({
        userId: savedUser.id,
        firstName: createUserDto.profile.firstName,
        lastName: createUserDto.profile.lastName,
        dateOfBirth: createUserDto.profile.dateOfBirth,
        profilePictureUrl: createUserDto.profile.profilePictureUrl,
        universityId: createUserDto.profile.universityId,
        department: createUserDto.profile.department,
        studentLevel: createUserDto.profile.studentLevel,
        bio: createUserDto.profile.bio,
      });

      const savedProfile = await this.userProfileRepository.save(profile);
      savedUser.profile = savedProfile;
    }

    return savedUser;
  }

  async findAll(
    page: number = 1,
    limit: number = 10,
  ): Promise<{ data: User[]; total: number }> {
    const [users, total] = await this.usersRepository.findAndCount({
      relations: ['profile', 'profile.university'],
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return { data: users, total };
  }

  async findById(id: string): Promise<User | null> {
    return await this.usersRepository.findOne({
      where: { id },
      relations: ['profile', 'profile.university'],
    });
  }

  async findByEmail(email: string): Promise<User | null> {
    return await this.usersRepository.findOne({
      where: { email },
      relations: ['profile', 'profile.university'],
    });
  }

  async findByIdOrFail(id: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    const user = await this.findByIdOrFail(id);

    // Update user fields
    if (updateUserDto.email && updateUserDto.email !== user.email) {
      const existingUser = await this.findByEmail(updateUserDto.email);
      if (existingUser && existingUser.id !== id) {
        throw new ConflictException('Email already exists');
      }
      user.email = updateUserDto.email;
    }

    if (updateUserDto.phoneNumber !== undefined) {
      user.phoneNumber = updateUserDto.phoneNumber;
    }

    if (updateUserDto.userType) {
      user.userType = updateUserDto.userType;
    }

    if (updateUserDto.status) {
      user.status = updateUserDto.status;
    }

    if (updateUserDto.isVerified !== undefined) {
      user.isVerified = updateUserDto.isVerified;
    }

    if (updateUserDto.isActive !== undefined) {
      user.isActive = updateUserDto.isActive;
    }

    const updatedUser = await this.usersRepository.save(user);

    // Update profile if provided
    if (updateUserDto.profile) {
      let profile = await this.userProfileRepository.findOne({
        where: { userId: id },
      });

      if (profile) {
        // Update existing profile
        Object.assign(profile, updateUserDto.profile);
        await this.userProfileRepository.save(profile);
      } else {
        // Create new profile
        profile = this.userProfileRepository.create({
          userId: id,
          ...updateUserDto.profile,
        });
        await this.userProfileRepository.save(profile);
      }

      updatedUser.profile = profile;
    }

    return updatedUser;
  }

  async updatePassword(id: string, newPassword: string): Promise<void> {
    const user = await this.findByIdOrFail(id);
    const passwordHash = await bcrypt.hash(newPassword, 12);

    user.passwordHash = passwordHash;
    await this.usersRepository.save(user);
  }

  async updateStatus(id: string, status: UserStatus): Promise<User> {
    const user = await this.findByIdOrFail(id);
    user.status = status;
    return await this.usersRepository.save(user);
  }

  async softDelete(id: string): Promise<void> {
    const user = await this.findByIdOrFail(id);
    user.isActive = false;
    user.status = UserStatus.INACTIVE;
    await this.usersRepository.save(user);
  }

  async hardDelete(id: string): Promise<void> {
    const user = await this.findByIdOrFail(id);
    await this.usersRepository.remove(user);
  }

  async verifyUser(id: string): Promise<User> {
    const user = await this.findByIdOrFail(id);
    user.isVerified = true;
    return await this.usersRepository.save(user);
  }

  //   async getUserStats(id: string): Promise<{
  //     totalProducts: number;
  //     activeProducts: number;
  //     totalSales: number;
  //     wishlistCount: number;
  //   }> {
  //     // This will be implemented once we have the products and orders modules
  //     // For now, return default values
  //     return {
  //       totalProducts: 0,
  //       activeProducts: 0,
  //       totalSales: 0,
  //       wishlistCount: 0,
  //     };
  //   }
}
