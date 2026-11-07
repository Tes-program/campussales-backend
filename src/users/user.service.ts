import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Raw, Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { UserProfile } from './entities/user-profile.entity';
import { CreateUserDto } from './dto/create-user.dto';
import {
  UpdateMeDto,
  UpdateMyProfileDto,
  UpdateUserDto,
} from './dto/update-user.dto';
import { UserStatus } from '../common/enum/user.enums';
// import * as bcrypt from 'bcryptjs';
import { OnboardingStatusDto } from './dto/check-status-onboarding.dto';
import { CompleteOnboardingDto } from './dto/onboarding.dto';
import { Logger } from '@nestjs/common';
import { SchoolsService, PublicSchool } from '../universities/schools.service';
import { conflict, ValidationFailed } from '../common/errors/app-errors';
import { MSG } from '../common/errors/messages';
import { Gender, Level } from '../common/constants/profile';

/** Strips secrets before a user leaves the API. */
export function toPublicUser<T extends User>(user: T): Omit<T, 'passwordHash'> {
  const rest = { ...user } as Partial<T>;
  delete rest.passwordHash;
  return rest as Omit<T, 'passwordHash'>;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(UserProfile)
    private userProfileRepository: Repository<UserProfile>,
    private readonly logger: Logger,
    private readonly schoolsService: SchoolsService,
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

  /** Case-insensitive: emails are compared lowercased. */
  async findByEmail(email: string): Promise<User | null> {
    return await this.usersRepository.findOne({
      where: {
        email: Raw((col) => `LOWER(${col}) = LOWER(:email)`, { email }),
      },
      relations: ['profile', 'profile.university'],
    });
  }

  async touchLastActive(id: string): Promise<void> {
    await this.usersRepository.update({ id }, { lastActiveAt: new Date() });
  }

  async findByIdOrFail(id: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  /**
   * Profile update for PATCH /users/me (UpdateMeDto) and the admin route
   * (UpdateUserDto). Uses the same validators as onboarding; returns 409 when
   * the phone number belongs to another account.
   */
  async update(id: string, dto: UpdateMeDto | UpdateUserDto): Promise<User> {
    const user = await this.findByIdOrFail(id);

    if (dto.email && dto.email !== user.email) {
      const existingUser = await this.findByEmail(dto.email);
      if (existingUser && existingUser.id !== id) {
        throw conflict(MSG.emailTaken, { email: MSG.emailTaken });
      }
      user.email = dto.email;
    }

    if (dto.phone !== undefined) {
      if (dto.phone) await this.assertPhoneAvailable(dto.phone, id);
      user.phoneNumber = dto.phone || null;
    }

    if ('userType' in dto && dto.userType) user.userType = dto.userType;
    if ('status' in dto && dto.status) user.status = dto.status;
    if ('isActive' in dto && dto.isActive !== undefined)
      user.isActive = dto.isActive;
    if ('isVerified' in dto && dto.isVerified !== undefined)
      user.isVerified = dto.isVerified;

    // Save user columns only; the profile is handled below.
    const userColumns = { ...user } as Partial<User>;
    delete userColumns.profile;
    await this.usersRepository.save(userColumns);

    if (dto.profile) {
      await this.saveProfile(id, await this.profileChanges(dto.profile));
    }
    return this.findByIdOrFail(id);
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

  /**
   * Idempotent: the same payload twice returns 200 both times and leaves the
   * profile unchanged.
   */
  async completeOnboarding(
    userId: string,
    dto: CompleteOnboardingDto,
  ): Promise<User & { school: PublicSchool }> {
    const user = await this.findByIdOrFail(userId);

    const school = await this.schoolsService.resolve(dto.school);
    if (!school) throw new ValidationFailed({ school: MSG.schoolInvalid });

    await this.assertPhoneAvailable(dto.phone, userId);

    if (user.phoneNumber !== dto.phone) {
      await this.usersRepository.update(
        { id: userId },
        { phoneNumber: dto.phone },
      );
    }

    await this.saveProfile(userId, {
      firstName: dto.firstName,
      lastName: dto.lastName,
      universityId: school.id,
      universityName: school.name,
      level: dto.level as Level,
      ...(dto.gender !== undefined ? { gender: dto.gender as Gender } : {}),
      ...(dto.interests !== undefined ? { interests: dto.interests } : {}),
      ...(dto.dateOfBirth !== undefined
        ? { dateOfBirth: dto.dateOfBirth as unknown as Date }
        : {}),
      ...(dto.bio !== undefined ? { bio: dto.bio } : {}),
      ...(dto.profilePictureUrl !== undefined
        ? { profilePictureUrl: dto.profilePictureUrl }
        : {}),
    });

    const fresh = await this.findByIdOrFail(userId);
    return Object.assign(fresh, { school });
  }

  /**
   * Throws 409 if another account already uses this number. Also matches the
   * un-normalised forms older rows may still hold (0803..., 234803...).
   */
  async assertPhoneAvailable(e164: string, userId: string): Promise<void> {
    const national = e164.replace(/^\+234/, '');
    const variants = [e164, `0${national}`, `234${national}`];
    const other = await this.usersRepository.findOne({
      where: { phoneNumber: In(variants), id: Not(userId) },
      select: ['id'],
    });
    if (other) throw conflict(MSG.phoneTaken, { phone: MSG.phoneTaken });
  }

  private async profileChanges(
    p: UpdateMyProfileDto,
  ): Promise<Partial<UserProfile>> {
    const changes: Partial<UserProfile> = {};
    if (p.firstName !== undefined) changes.firstName = p.firstName;
    if (p.lastName !== undefined) changes.lastName = p.lastName;
    if (p.dateOfBirth !== undefined)
      changes.dateOfBirth = p.dateOfBirth as unknown as Date;
    if (p.profilePictureUrl !== undefined)
      changes.profilePictureUrl = p.profilePictureUrl;
    if (p.bio !== undefined) changes.bio = p.bio ?? undefined;
    if (p.level !== undefined) changes.level = p.level as Level;
    if (p.gender !== undefined) changes.gender = (p.gender as Gender) ?? null;
    if (p.interests !== undefined) changes.interests = p.interests;
    if (p.school !== undefined) {
      const school = await this.schoolsService.resolve(p.school);
      if (!school)
        throw new ValidationFailed({ 'profile.school': MSG.schoolInvalid });
      changes.universityId = school.id;
      changes.universityName = school.name;
    }
    return changes;
  }

  private async saveProfile(
    userId: string,
    changes: Partial<UserProfile>,
  ): Promise<void> {
    const profile = await this.userProfileRepository.findOne({
      where: { userId },
    });
    if (profile) {
      Object.assign(profile, changes);
      await this.userProfileRepository.save(profile);
      return;
    }
    if (!changes.firstName || !changes.lastName) {
      throw new ValidationFailed({
        ...(changes.firstName
          ? {}
          : { 'profile.firstName': MSG.firstNameInvalid }),
        ...(changes.lastName
          ? {}
          : { 'profile.lastName': MSG.lastNameInvalid }),
      });
    }
    await this.userProfileRepository.save(
      this.userProfileRepository.create({
        userId,
        ...changes,
      } as Partial<UserProfile>),
    );
  }

  /**
   * Check onboarding status
   */
  async getOnboardingStatus(userId: string): Promise<OnboardingStatusDto> {
    const user = await this.findByIdOrFail(userId);

    const hasProfile = !!user.profile;
    const hasUniversity = !!user.profile?.universityId;
    const hasUniversityName = !!user.profile?.universityName;
    const hasBio = !!user.profile?.bio;
    const hasProfilePicture = !!user.profile?.profilePictureUrl;

    const completedSteps = {
      hasProfile,
      hasUniversity,
      hasUniversityName,
      hasBio,
      hasProfilePicture,
    };

    const missingFields: string[] = [];
    if (!hasProfile) missingFields.push('profile');
    if (!hasUniversity) missingFields.push('university');
    if (!hasUniversityName) missingFields.push('universityName');
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
