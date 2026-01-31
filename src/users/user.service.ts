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
import { UserStatus } from '../common/enum/user.enums';
// import * as bcrypt from 'bcryptjs';
import { OnboardingStatusDto } from './dto/check-status-onboarding.dto';
import { CompleteOnboardingDto } from './dto/onboarding.dto';
import { Logger } from '@nestjs/common';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(UserProfile)
    private userProfileRepository: Repository<UserProfile>,
    private readonly logger: Logger,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<User> {
    try {
      // Validate input
      if (!createUserDto.email || !createUserDto.username) {
        throw new ConflictException('Email and username are required');
      }

      // Check if user already exists
      const existingUser = await this.findByEmail(createUserDto.email);
      if (existingUser) {
        throw new ConflictException('A user with this email already exists');
      }

      // Check if username already exists
      const existingUsername = await this.findByUsername(
        createUserDto.username,
      );
      if (existingUsername) {
        throw new ConflictException(
          'This username is already taken. Please choose another one',
        );
      }

      // Create user
      const user = this.usersRepository.create({
        email: createUserDto.email,
        passwordHash: createUserDto.passwordHash,
        username: createUserDto.username,
        status: UserStatus.ACTIVE,
      });

      const savedUser = await this.usersRepository.save(user);

      if (!savedUser) {
        throw new ConflictException('Failed to create user');
      }

      return savedUser;
    } catch (error) {
      if (error instanceof ConflictException) {
        throw error;
      }
      throw new ConflictException('Unable to create user account');
    }
  }

  // New method to find user by username
  async findByUsername(username: string): Promise<User | null> {
    return await this.usersRepository.findOne({
      where: { username },
    });
  }

  async findAll(
    page: number = 1,
    limit: number = 10,
  ): Promise<{ data: User[]; total: number }> {
    try {
      // Validate pagination parameters
      if (page < 1) page = 1;
      if (limit < 1 || limit > 100) limit = 10;

      const [users, total] = await this.usersRepository.findAndCount({
        relations: ['profile', 'profile.university'],
        skip: (page - 1) * limit,
        take: limit,
        order: { createdAt: 'DESC' },
      });

      return { data: users, total };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      throw new NotFoundException('Unable to fetch users');
    }
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
    try {
      if (!id) {
        throw new NotFoundException('User ID is required');
      }

      const user = await this.findByIdOrFail(id);

      // Update user fields
      if (updateUserDto.email && updateUserDto.email !== user.email) {
        const existingUser = await this.findByEmail(updateUserDto.email);
        if (existingUser && existingUser.id !== id) {
          throw new ConflictException(
            'Another user with this email already exists',
          );
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
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      throw new ConflictException('Failed to update user');
    }
  }

  async updatePassword(id: string, newPassword: string): Promise<void> {
    const user = await this.findByIdOrFail(id);
    // const passwordHash = await bcrypt.hash(newPassword, 12);

    user.passwordHash = newPassword;
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

  // Add these methods to src/users/user.service.ts

  // src/users/user.service.ts - UPDATE completeOnboarding method
  async completeOnboarding(
    userId: string,
    onboardingDto: CompleteOnboardingDto,
  ): Promise<User> {
    try {
      if (!userId) {
        throw new NotFoundException('User ID is required');
      }

      // Validate required fields
      if (!onboardingDto.firstName || !onboardingDto.lastName) {
        throw new ConflictException('First name and last name are required');
      }

      const user = await this.findByIdOrFail(userId);

      // Check if profile exists
      let profile = await this.userProfileRepository.findOne({
        where: { userId },
      });

      // ✅ FIX: Normalize gender to match enum
      const normalizedGender = onboardingDto.gender
        ? ((onboardingDto.gender.charAt(0).toUpperCase() +
            onboardingDto.gender.slice(1).toLowerCase()) as 'Male' | 'Female')
        : undefined;

      // ✅ FIX: Handle interests array properly
      const interestsArray = Array.isArray(onboardingDto.interests)
        ? onboardingDto.interests
        : onboardingDto.interests
          ? [onboardingDto.interests]
          : undefined;

      const profileData = {
        firstName: onboardingDto.firstName,
        lastName: onboardingDto.lastName,
        universityId: onboardingDto.universityId,
        universityName: onboardingDto.universityName,
        studentLevel: onboardingDto.level,
        dateOfBirth: onboardingDto.dateOfBirth,
        bio: onboardingDto.bio,
        profilePictureUrl: onboardingDto.profilePictureUrl,
        gender: normalizedGender,
        interest: interestsArray, // Note: it's 'interest' not 'interests' in DB
      };

      if (profile) {
        // Update existing profile
        Object.assign(profile, profileData);
        await this.userProfileRepository.save(profile);
      } else {
        // Create new profile
        profile = this.userProfileRepository.create({
          userId,
          ...profileData,
        });
        await this.userProfileRepository.save(profile);
      }

      user.profile = profile;
      return user;
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        throw error;
      }

      // ✅ FIX: Log the actual error for debugging
      this.logger.error(
        `Failed to complete onboarding for user ${userId}: ${error.message}`,
        error.stack,
      );

      throw new ConflictException(
        `Failed to complete onboarding: ${error.message}`,
      );
    }
  }

  /**
   * Check onboarding status
   */
  async getOnboardingStatus(userId: string): Promise<OnboardingStatusDto> {
    const user = await this.findByIdOrFail(userId);

    const hasProfile = !!user.profile;
    const hasUniversity = !!user.profile?.universityId;
    const hasUniversityName = !!user.profile?.universityName;
    const hasLevel = !!user.profile?.studentLevel;
    const hasBio = !!user.profile?.bio;
    const hasProfilePicture = !!user.profile?.profilePictureUrl;

    const completedSteps = {
      hasProfile,
      hasUniversity,
      hasUniversityName,
      hasLevel,
      hasBio,
      hasProfilePicture,
    };

    const missingFields: string[] = [];
    if (!hasProfile) missingFields.push('profile');
    if (!hasUniversity) missingFields.push('university');
    if (!hasUniversityName) missingFields.push('universityName');
    if (!hasLevel) missingFields.push('studentLevel');
    if (!hasBio) missingFields.push('bio');
    if (!hasProfilePicture) missingFields.push('profilePicture');

    const totalSteps = Object.keys(completedSteps).length;
    const completedCount = Object.values(completedSteps).filter(Boolean).length;
    const profileCompletionPercentage = Math.round(
      (completedCount / totalSteps) * 100,
    );

    const isComplete = missingFields.length === 0;

    return {
      isComplete,
      completedSteps,
      missingFields,
      profileCompletionPercentage,
    };
  }

  /**
   * Get user profile with statistics
   */
  async getUserProfile(userId: string): Promise<{
    user: User;
    stats: {
      totalProducts: number;
      activeProducts: number;
      soldProducts: number;
      wishlistCount: number;
      joinedDate: Date;
      lastActive: Date;
    };
  }> {
    const user = await this.findByIdOrFail(userId);

    // Get product statistics
    const products = await this.usersRepository
      .createQueryBuilder('user')
      .leftJoin('user.products', 'product')
      .where('user.id = :userId', { userId })
      .select('COUNT(product.id)', 'total')
      .addSelect(
        'COUNT(CASE WHEN product.isAvailable = true THEN 1 END)',
        'active',
      )
      .addSelect(
        'COUNT(CASE WHEN product.isAvailable = false THEN 1 END)',
        'sold',
      )
      .getRawOne();

    // Get wishlist count
    const wishlistCount = await this.usersRepository
      .createQueryBuilder('user')
      .leftJoin('user.wishlists', 'wishlist')
      .where('user.id = :userId', { userId })
      .getCount();

    return {
      user,
      stats: {
        totalProducts: parseInt(products?.total) || 0,
        activeProducts: parseInt(products?.active) || 0,
        soldProducts: parseInt(products?.sold) || 0,
        wishlistCount,
        joinedDate: user.createdAt,
        lastActive: user.updatedAt,
      },
    };
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
