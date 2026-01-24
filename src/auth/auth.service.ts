/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/user.service';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import {
  JwtPayload,
  AuthTokens,
  AuthResponse,
} from './interfaces/jwt-payload.interface';
import {
  JWT_REFRESH_SECRET,
  JWT_REFRESH_EXPIRES_IN,
} from '../config/jwt.config';
import { PasswordReset } from './entities/password-reset.entity';
import { EmailService } from '../common/services/email.service';
import { randomBytes, createHash } from 'crypto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
    @InjectRepository(RefreshToken)
    private refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(PasswordReset)
    private passwordResetRepository: Repository<PasswordReset>,
    private emailService: EmailService,
  ) {}

  async register(registerDto: RegisterDto): Promise<AuthResponse> {
    try {
      // Validate email format
      if (!registerDto.email || !registerDto.email.includes('@')) {
        throw new BadRequestException('Invalid email format');
      }

      // Validate password strength
      if (!registerDto.password || registerDto.password.length < 6) {
        throw new BadRequestException(
          'Password must be at least 6 characters long',
        );
      }

      // Check if user exists
      const existingUser = await this.usersService.findByEmail(
        registerDto.email,
      );
      if (existingUser) {
        throw new ConflictException(
          'An account with this email already exists',
        );
      }

      // Check if username exists
      const existingUsername = await this.usersService.findByUsername(
        registerDto.username,
      );
      if (existingUsername) {
        throw new ConflictException(
          'This username is already taken. Please choose another one',
        );
      }

      // Hash password
      const passwordHash = await bcrypt.hash(registerDto.password, 12);

      // Create user
      const user = await this.usersService.create({
        email: registerDto.email,
        passwordHash,
        username: registerDto.username,
      });

      if (!user) {
        throw new BadRequestException('Failed to create user account');
      }

      // Generate tokens
      const tokens = await this.generateTokens(user);

      return {
        ...tokens,
        user: {
          id: user.id,
          email: user.email,
          userType: user.userType,
          status: user.status,
        },
      };
    } catch (error) {
      // Re-throw known errors
      if (
        error instanceof ConflictException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      // Handle unexpected errors
      throw new BadRequestException(
        'Registration failed. Please try again later',
      );
    }
  }

  async login(loginDto: LoginDto): Promise<AuthResponse> {
    try {
      // Validate input
      if (!loginDto.email || !loginDto.password) {
        throw new BadRequestException('Email and password are required');
      }

      const user = await this.validateUser(loginDto.email, loginDto.password);

      // Check if user account is active
      if (!user.isActive) {
        throw new UnauthorizedException(
          'Your account has been deactivated. Please contact support',
        );
      }

      const tokens = await this.generateTokens(user);

      return {
        ...tokens,
        user: {
          id: user.id,
          email: user.email,
          userType: user.userType,
          status: user.status,
          profile: user.profile,
        },
      };
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new UnauthorizedException('Login failed. Please try again');
    }
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    try {
      if (!refreshToken) {
        throw new UnauthorizedException('Refresh token is required');
      }

      // Verify refresh token JWT signature and expiry
      let payload: any;
      try {
        payload = this.jwtService.verify(refreshToken, {
          secret: this.configService.get(JWT_REFRESH_SECRET),
        });
      } catch (jwtError) {
        throw new UnauthorizedException(
          'Invalid or expired refresh token. Please login again',
        );
      }

      // Create deterministic hash of the token for database lookup
      const tokenHash = createHash('sha256').update(refreshToken).digest('hex');

      // Check if refresh token exists in database and is not revoked
      const storedToken = await this.refreshTokenRepository.findOne({
        where: {
          tokenHash,
          userId: payload.sub,
          isRevoked: false,
        },
      });

      if (!storedToken) {
        throw new UnauthorizedException(
          'Invalid refresh token. Please login again',
        );
      }

      // Check expiry (belt and suspenders - JWT already validated this)
      if (storedToken.expiresAt < new Date()) {
        throw new UnauthorizedException(
          'Refresh token has expired. Please login again',
        );
      }

      // Get user and verify account status
      const user = await this.usersService.findById(payload.sub);
      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      if (!user.isActive) {
        throw new UnauthorizedException('Account is deactivated');
      }

      // Revoke old refresh token (token rotation for security)
      storedToken.isRevoked = true;
      await this.refreshTokenRepository.save(storedToken);

      // Generate new tokens
      return this.generateTokens(user);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException(
        'Invalid or expired refresh token. Please login again',
      );
    }
  }

  async logout(userId: string, refreshToken: string): Promise<void> {
    try {
      if (!userId || !refreshToken) {
        throw new BadRequestException('User ID and refresh token are required');
      }

      // Create deterministic hash for database lookup
      const tokenHash = createHash('sha256').update(refreshToken).digest('hex');

      await this.refreshTokenRepository.update(
        { userId, tokenHash, isRevoked: false },
        { isRevoked: true },
      );

      // Even if token is not found, we consider logout successful
      // This prevents information leakage
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      // Don't throw error on logout failure - fail silently for security
    }
  }

  private async validateUser(email: string, password: string): Promise<User> {
    if (!email || !password) {
      throw new UnauthorizedException('Email and password are required');
    }

    const user = await this.usersService.findByEmail(email);

    if (!user) {
      // Use generic message to prevent email enumeration
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(
      password,
      user.passwordHash || '',
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return user;
  }

  private async generateTokens(user: User): Promise<AuthTokens> {
    try {
      if (!user || !user.id) {
        throw new BadRequestException('Invalid user data for token generation');
      }

      const payload: JwtPayload = {
        sub: user.id,
        email: user.email,
        userType: user.userType,
        status: user.status,
      };

      // Generate access token
      const accessToken = this.jwtService.sign(payload);

      // Generate refresh token
      const refreshToken = this.jwtService.sign(payload, {
        secret: this.configService.get(JWT_REFRESH_SECRET),
        expiresIn: JWT_REFRESH_EXPIRES_IN,
      });

      // Store deterministic SHA-256 hash of refresh token for efficient lookups
      const refreshTokenHash = createHash('sha256')
        .update(refreshToken)
        .digest('hex');
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

      await this.refreshTokenRepository.save({
        userId: user.id,
        tokenHash: refreshTokenHash,
        expiresAt,
      });

      return { accessToken, refreshToken };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to generate authentication tokens');
    }
  }

  async changePassword(
    userId: string,
    changePasswordDto: ChangePasswordDto,
  ): Promise<{ message: string }> {
    const { currentPassword, newPassword } = changePasswordDto;

    // Get user
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Verify current password
    const isPasswordValid = await bcrypt.compare(
      currentPassword,
      user.passwordHash,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    // Check if new password is same as current
    const isSamePassword = await bcrypt.compare(newPassword, user.passwordHash);
    if (isSamePassword) {
      throw new BadRequestException(
        'New password must be different from current password',
      );
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 12);

    // Update password
    await this.usersService.updatePassword(userId, newPasswordHash);

    // Revoke all refresh tokens for security
    await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true },
    );

    // Send notification email
    await this.emailService.sendPasswordChangedEmail(
      user.email,
      user.profile?.firstName,
    );

    return {
      message:
        'Password changed successfully. Please login again with your new password.',
    };
  }

  /**
   * Initiate forgot password flow
   */
  async forgotPassword(
    forgotPasswordDto: ForgotPasswordDto,
  ): Promise<{ message: string }> {
    try {
      const { email } = forgotPasswordDto;

      if (!email) {
        throw new BadRequestException('Email is required');
      }

      // Find user by email
      const user = await this.usersService.findByEmail(email);

      // Don't reveal if email exists or not (security best practice)
      if (!user) {
        return {
          message:
            'If that email exists in our system, a password reset link has been sent.',
        };
      }

      // Generate reset token
      const resetToken = randomBytes(32).toString('hex');
      const tokenHash = await bcrypt.hash(resetToken, 10);

      // Set expiry time (1 hour from now)
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 1);

      // Invalidate any existing unused reset tokens for this user
      await this.passwordResetRepository.update(
        { userId: user.id, isUsed: false },
        { isUsed: true },
      );

      // Save reset token
      await this.passwordResetRepository.save({
        userId: user.id,
        token: tokenHash,
        expiresAt,
        isUsed: false,
      });

      // Send reset email
      try {
        await this.emailService.sendPasswordResetEmail(
          user.email,
          resetToken,
          user.profile?.firstName,
        );
      } catch (emailError) {
        // Log email error but don't expose it to user
        throw new BadRequestException(
          'Failed to send reset email. Please try again later',
        );
      }

      return {
        message:
          'If that email exists in our system, a password reset link has been sent.',
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      return {
        message:
          'If that email exists in our system, a password reset link has been sent.',
      };
    }
  }

  /**
   * Reset password using token
   */
  async resetPassword(
    resetPasswordDto: ResetPasswordDto,
  ): Promise<{ message: string }> {
    try {
      const { token, newPassword } = resetPasswordDto;

      if (!token || !newPassword) {
        throw new BadRequestException('Token and new password are required');
      }

      if (newPassword.length < 6) {
        throw new BadRequestException(
          'New password must be at least 6 characters long',
        );
      }

      // Find all unused, non-expired reset tokens
      const resetTokens = await this.passwordResetRepository.find({
        where: {
          isUsed: false,
        },
        relations: ['user'],
      });

      // Find matching token
      let matchedReset: PasswordReset | null = null;
      for (const reset of resetTokens) {
        const isValid = await bcrypt.compare(token, reset.token);
        if (isValid && reset.expiresAt > new Date()) {
          matchedReset = reset;
          break;
        }
      }

      if (!matchedReset) {
        throw new BadRequestException(
          'Invalid or expired password reset token. Please request a new one',
        );
      }

      // Hash new password
      const newPasswordHash = await bcrypt.hash(newPassword, 12);

      // Update user password
      await this.usersService.updatePassword(
        matchedReset.userId,
        newPasswordHash,
      );

      // Mark token as used
      matchedReset.isUsed = true;
      await this.passwordResetRepository.save(matchedReset);

      // Revoke all refresh tokens
      await this.refreshTokenRepository.update(
        { userId: matchedReset.userId, isRevoked: false },
        { isRevoked: true },
      );

      // Send notification email
      try {
        await this.emailService.sendPasswordChangedEmail(
          matchedReset.user.email,
          matchedReset.user.profile?.firstName,
        );
      } catch (emailError) {
        // Log but don't fail the password reset
      }

      return {
        message:
          'Password reset successfully. Please login with your new password.',
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        'Failed to reset password. Please try again or request a new reset link',
      );
    }
  }

  /**
   * Cleanup expired password reset tokens (can be run as a cron job)
   */
  async cleanupExpiredResetTokens(): Promise<number> {
    const result = await this.passwordResetRepository
      .createQueryBuilder()
      .delete()
      .where('expiresAt < :now', { now: new Date() })
      .orWhere('isUsed = :isUsed', { isUsed: true })
      .execute();

    return result.affected || 0;
  }
}
