import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { randomBytes, randomInt } from 'crypto';
import { IsNull, Repository } from 'typeorm';
import {
  AppError,
  rateLimited,
  ValidationFailed,
} from '../common/errors/app-errors';
import { ErrorCode } from '../common/errors/error-codes';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { EmailService } from '../common/services/email.service';
import { UserStatus, UserType } from '../common/enum/user.enums';
import { SchoolsService } from '../universities/schools.service';
import { User } from '../users/entities/user.entity';
import { toPublicUser, UsersService } from '../users/user.service';
import { AUTH, frontendUrl } from './auth.config';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import {
  LegacyRegisterDto,
  SignupDto,
  SIGNUP_MESSAGES,
} from './dto/signup.dto';
import { EmailVerification } from './entities/email-verification.entity';
import { PasswordReset } from './entities/password-reset.entity';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { checkPassword } from './password-policy';
import { RefreshTokenService, sha256 } from './refresh-token.service';

export const BCRYPT_COST = 12;
export const FORGOT_PASSWORD_MESSAGE =
  "If that email has an account, we've sent a link.";

/**
 * Real cost-12 hash of a random string, compared against when the email is
 * unknown so wrong-email and wrong-password do the same work.
 */
const DUMMY_HASH = bcrypt.hashSync(
  randomBytes(16).toString('hex'),
  BCRYPT_COST,
);

export interface SessionContext {
  ip?: string;
  userAgent?: string;
}

export interface IssuedSession {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  familyId: string;
  user: ReturnType<typeof toPublicUser<User>>;
}

const invalidCredentials = () => new AppError(ErrorCode.INVALID_CREDENTIALS);

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly rateLimit: RateLimitService,
    private readonly email: EmailService,
    private readonly schools: SchoolsService,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(PasswordReset)
    private readonly resets: Repository<PasswordReset>,
    @InjectRepository(EmailVerification)
    private readonly verifications: Repository<EmailVerification>,
  ) {}

  // ───────────────────────────── sign-up ──────────────────────────────

  async signup(
    dto: SignupDto | LegacyRegisterDto,
    ctx: SessionContext,
  ): Promise<IssuedSession> {
    const limit = await this.rateLimit.consume(
      RateLimitService.key('signup-ip', ctx.ip ?? 'unknown'),
      AUTH.signup.perIp,
      AUTH.signup.windowMs,
    );
    if (!limit.allowed) {
      throw rateLimited(
        'Too many sign-ups from this network. Please try again later.',
        limit.retryAfterSeconds,
      );
    }

    // Decision (documented in docs/security.md): an existing email gets a
    // clear 409 instead of a neutral flow, because sign-up logs the user in
    // straight away. Enumeration is limited by the per-IP sign-up limit.
    if (await this.usersService.findByEmail(dto.email)) {
      throw new AppError(ErrorCode.CONFLICT, SIGNUP_MESSAGES.emailTaken, {
        email: SIGNUP_MESSAGES.emailTaken,
      });
    }

    let signupSchoolId: string | null = null;
    const schoolRef = dto.schoolId ?? dto.campus;
    if (schoolRef) {
      const school = await this.schools.resolve(schoolRef);
      if (!school) {
        throw new ValidationFailed({
          [dto.schoolId ? 'schoolId' : 'campus']: SIGNUP_MESSAGES.school,
        });
      }
      signupSchoolId = school.id;
    }

    let username = dto.username;
    if (username) {
      if (await this.usersService.findByUsername(username)) {
        throw new AppError(ErrorCode.CONFLICT, SIGNUP_MESSAGES.usernameTaken, {
          username: SIGNUP_MESSAGES.usernameTaken,
        });
      }
    } else {
      username = await this.generateUsername(dto.email);
    }

    const acceptedTerms = dto.acceptedTerms === true;
    const user = await this.users.save(
      this.users.create({
        email: dto.email,
        username,
        passwordHash: await bcrypt.hash(dto.password, BCRYPT_COST),
        fullName: dto.name ?? null,
        userType: UserType.STUDENT, // never trust a client-supplied role
        status: UserStatus.ACTIVE,
        signupSchoolId,
        acceptedTermsVersion: acceptedTerms
          ? (dto.acceptedTermsVersion ?? null)
          : null,
        acceptedTermsAt: acceptedTerms ? new Date() : null,
        verifyBy: new Date(Date.now() + AUTH.verifyGraceHours * 3_600_000),
      }),
    );

    this.sendVerification(user).catch(() => undefined);
    const fresh = await this.usersService.findByIdOrFail(user.id);
    return this.startSession(fresh, ctx);
  }

  // ───────────────────────────── login ────────────────────────────────

  /**
   * Always "Email or password is incorrect." (INVALID_CREDENTIALS) on failure,
   * with equal work for unknown emails. After 5 failures per account or 20
   * per IP in 15 minutes, further attempts wait a progressively longer delay
   * (30s, 60s, 120s ... capped at 15 min) instead of a hard lock-out.
   */
  async login(dto: LoginDto, ctx: SessionContext): Promise<IssuedSession> {
    const acctKey = RateLimitService.key('login-acct', dto.email);
    const ipKey = RateLimitService.key('login-ip', ctx.ip ?? 'unknown');
    await this.enforceLoginDelay(acctKey, AUTH.login.perAccount);
    await this.enforceLoginDelay(ipKey, AUTH.login.perIp);

    const user = await this.usersService.findByEmail(dto.email);
    const ok = await bcrypt.compare(
      dto.password,
      user?.passwordHash || DUMMY_HASH,
    );

    if (!user || !ok) {
      await this.rateLimit.hit(acctKey, AUTH.login.windowMs);
      await this.rateLimit.hit(ipKey, AUTH.login.windowMs);
      throw invalidCredentials();
    }

    // Logging in during the 30-day deletion grace cancels the deletion.
    if (user.deletionRequestedAt) {
      await this.users.update({ id: user.id }, { deletionRequestedAt: null });
      user.deletionRequestedAt = null;
    }

    if (!user.isActive || user.status !== UserStatus.ACTIVE) {
      throw new AppError(
        ErrorCode.UNAUTHENTICATED,
        'This account is not active. Please contact support.',
      );
    }

    await this.rateLimit.reset(acctKey);

    // Re-hash when the stored cost is below the current standard.
    if (bcrypt.getRounds(user.passwordHash) < BCRYPT_COST) {
      await this.users.update(
        { id: user.id },
        { passwordHash: await bcrypt.hash(dto.password, BCRYPT_COST) },
      );
    }

    return this.startSession(user, ctx);
  }

  private async enforceLoginDelay(
    key: string,
    threshold: number,
  ): Promise<void> {
    const failures = await this.rateLimit.events(key, AUTH.login.windowMs);
    if (failures.length < threshold) return;
    const over = failures.length - threshold; // 0 on the first blocked attempt
    const delaySeconds = Math.min(
      AUTH.login.windowMs / 1000,
      AUTH.login.baseDelaySeconds * 2 ** over,
    );
    const waitMs =
      failures[failures.length - 1] + delaySeconds * 1000 - Date.now();
    if (waitMs > 0) {
      throw rateLimited(
        'Too many attempts. Please wait a moment and try again.',
        waitMs / 1000,
      );
    }
  }

  // ─────────────────────────── sessions ───────────────────────────────

  async refresh(
    rawToken: string | undefined,
    ctx: SessionContext,
  ): Promise<IssuedSession> {
    const rotated = await this.refreshTokens.rotate(rawToken, ctx.userAgent);
    const user = await this.usersService.findById(rotated.userId);
    if (!user || !user.isActive || user.status !== UserStatus.ACTIVE) {
      await this.refreshTokens.revokeFamily(rotated.familyId, 'inactive');
      throw new AppError(
        ErrorCode.UNAUTHENTICATED,
        'Your session has ended. Please log in again.',
      );
    }
    return {
      ...this.accessFor(user),
      refreshToken: rotated.token,
      familyId: rotated.familyId,
      user: toPublicUser(user),
    };
  }

  /** Revokes the presented token's family. Always succeeds. */
  async logout(rawToken: string | undefined): Promise<void> {
    const family = await this.refreshTokens.familyOf(rawToken);
    if (family)
      await this.refreshTokens.revokeFamily(family.familyId, 'logout');
  }

  /** "Sign out of all devices": refresh tokens and live access tokens. */
  async logoutAll(userId: string): Promise<void> {
    await this.refreshTokens.revokeAllForUser(userId, 'logout_all');
    await this.users.update({ id: userId }, { tokensValidAfter: new Date() });
  }

  // ─────────────────────────── passwords ──────────────────────────────

  async changePassword(
    user: User,
    dto: ChangePasswordDto,
    currentRefreshToken: string | undefined,
  ): Promise<{ message: string; accessToken: string; expiresIn: number }> {
    const fresh = await this.usersService.findByIdOrFail(user.id);
    if (!(await bcrypt.compare(dto.currentPassword, fresh.passwordHash))) {
      throw new ValidationFailed({
        currentPassword: 'Your current password is incorrect.',
      });
    }
    const problem = checkPassword(dto.newPassword, this.passwordContext(fresh));
    if (problem) throw new ValidationFailed({ newPassword: problem });
    if (await bcrypt.compare(dto.newPassword, fresh.passwordHash)) {
      throw new ValidationFailed({
        newPassword:
          'Your new password must be different from your current one.',
      });
    }

    await this.setPassword(fresh.id, dto.newPassword);
    const keep = await this.refreshTokens.familyOf(currentRefreshToken);
    await this.refreshTokens.revokeAllForUser(
      fresh.id,
      'password_change',
      keep?.userId === fresh.id ? keep.familyId : undefined,
    );
    this.email
      .sendPasswordChangedEmail(fresh.email, this.firstName(fresh))
      .catch(() => undefined);

    // Older access tokens are now rejected, so hand back a fresh one.
    const refreshed = await this.usersService.findByIdOrFail(fresh.id);
    return {
      message: 'Password changed. You were signed out on your other devices.',
      ...this.accessFor(refreshed),
    };
  }

  /**
   * Always resolves with the same message (no account enumeration). Limits
   * (3/hour per email, 20/hour per IP) are applied silently. The email is
   * sent in the background so response time does not reveal anything.
   */
  async forgotPassword(
    dto: ForgotPasswordDto,
    ctx: SessionContext,
  ): Promise<{ message: string }> {
    const perEmail = await this.rateLimit.consume(
      RateLimitService.key('forgot-email', dto.email),
      AUTH.forgotPassword.perEmail,
      AUTH.forgotPassword.windowMs,
    );
    const perIp = await this.rateLimit.consume(
      RateLimitService.key('forgot-ip', ctx.ip ?? 'unknown'),
      AUTH.forgotPassword.perIp,
      AUTH.forgotPassword.windowMs,
    );
    if (perEmail.allowed && perIp.allowed) {
      this.issueReset(dto.email).catch((e: Error) =>
        this.logger.error(`Password reset issue failed: ${e.name}`),
      );
    }
    return { message: FORGOT_PASSWORD_MESSAGE };
  }

  private async issueReset(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    if (!user || !user.isActive) return;
    const token = randomBytes(32).toString('base64url');
    // A newer link supersedes any older unused one.
    await this.resets.update(
      { userId: user.id, isUsed: false },
      { isUsed: true },
    );
    await this.resets.save(
      this.resets.create({
        userId: user.id,
        token: sha256(token),
        expiresAt: new Date(Date.now() + AUTH.resetTtlMinutes * 60_000),
        isUsed: false,
      }),
    );
    const url = `${frontendUrl(this.config)}/reset-password?token=${encodeURIComponent(token)}`;
    await this.email.sendPasswordResetEmail(
      user.email,
      url,
      AUTH.resetTtlMinutes,
      this.firstName(user),
    );
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const reset = await this.resets.findOne({
      where: { token: sha256(dto.token) },
    });
    if (!reset || reset.isUsed) throw new AppError(ErrorCode.TOKEN_INVALID);
    if (reset.expiresAt.getTime() <= Date.now()) {
      await this.resets.update({ id: reset.id }, { isUsed: true });
      throw new AppError(ErrorCode.TOKEN_EXPIRED);
    }
    const user = await this.usersService.findByIdOrFail(reset.userId);
    const problem = checkPassword(dto.newPassword, this.passwordContext(user));
    if (problem) throw new ValidationFailed({ newPassword: problem });

    // Single use: claim the token atomically before changing anything.
    const claimed = await this.resets.update(
      { id: reset.id, isUsed: false },
      { isUsed: true },
    );
    if (!claimed.affected) throw new AppError(ErrorCode.TOKEN_INVALID);

    await this.setPassword(user.id, dto.newPassword);
    await this.refreshTokens.revokeAllForUser(user.id, 'password_change');
    this.email
      .sendPasswordChangedEmail(user.email, this.firstName(user))
      .catch(() => undefined);
    return {
      message:
        'Your password has been reset. Please log in with your new password.',
    };
  }

  // ─────────────────────── email verification ─────────────────────────

  async verifyEmail(
    token: string,
  ): Promise<{ message: string; user: ReturnType<typeof toPublicUser<User>> }> {
    const row = await this.verifications.findOne({
      where: { tokenHash: sha256(token) },
    });
    if (!row || row.usedAt) throw new AppError(ErrorCode.TOKEN_INVALID);
    if (row.expiresAt.getTime() <= Date.now())
      throw new AppError(ErrorCode.TOKEN_EXPIRED);
    await this.verifications.update({ id: row.id }, { usedAt: new Date() });
    await this.users.update(
      { id: row.userId, emailVerifiedAt: IsNull() },
      { emailVerifiedAt: new Date(), isVerified: true },
    );
    const user = await this.usersService.findByIdOrFail(row.userId);
    return { message: 'Your email is confirmed.', user: toPublicUser(user) };
  }

  async resendVerification(user: User): Promise<{ message: string }> {
    if (user.emailVerifiedAt)
      return { message: 'Your email is already confirmed.' };
    const limit = await this.rateLimit.consume(
      RateLimitService.key('resend-verify', user.id),
      AUTH.resendVerification.perUser,
      AUTH.resendVerification.windowMs,
    );
    if (!limit.allowed) {
      throw rateLimited(
        "We've already sent a few links. Please check your inbox or try again later.",
        limit.retryAfterSeconds,
      );
    }
    await this.sendVerification(user);
    return { message: "We've sent a new confirmation link." };
  }

  private async sendVerification(user: User): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    await this.verifications.update(
      { userId: user.id, usedAt: IsNull() },
      { usedAt: new Date() },
    );
    await this.verifications.save(
      this.verifications.create({
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + AUTH.verifyLinkTtlHours * 3_600_000),
      }),
    );
    const url = `${frontendUrl(this.config)}/verify-email?token=${encodeURIComponent(token)}`;
    await this.email.sendVerificationEmail(
      user.email,
      url,
      AUTH.verifyLinkTtlHours,
      this.firstName(user),
    );
  }

  // ───────────────────────────── helpers ──────────────────────────────

  private async startSession(
    user: User,
    ctx: SessionContext,
  ): Promise<IssuedSession> {
    const { token, familyId } = await this.refreshTokens.issue(user.id, {
      userAgent: ctx.userAgent,
    });
    return {
      ...this.accessFor(user),
      refreshToken: token,
      familyId,
      user: toPublicUser(user),
    };
  }

  private accessFor(user: User): { accessToken: string; expiresIn: number } {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      userType: user.userType,
      status: user.status,
    };
    return {
      accessToken: this.jwtService.sign(payload, {
        expiresIn: AUTH.accessTtlSeconds,
      }),
      expiresIn: AUTH.accessTtlSeconds,
    };
  }

  private async setPassword(userId: string, password: string): Promise<void> {
    const now = new Date();
    await this.users.update(
      { id: userId },
      {
        passwordHash: await bcrypt.hash(password, BCRYPT_COST),
        passwordChangedAt: now,
        tokensValidAfter: now,
      },
    );
    // Any outstanding reset link dies with the old password.
    await this.resets.update({ userId, isUsed: false }, { isUsed: true });
  }

  private passwordContext(user: User) {
    const name =
      user.fullName ??
      ([user.profile?.firstName, user.profile?.lastName]
        .filter(Boolean)
        .join(' ') ||
        user.username);
    return { email: user.email, name };
  }

  private firstName(user: User): string | null {
    return user.profile?.firstName ?? user.fullName?.split(' ')[0] ?? null;
  }

  private async generateUsername(email: string): Promise<string> {
    const base =
      email
        .split('@')[0]
        .toLowerCase()
        .replace(/[^a-z0-9._]/g, '')
        .slice(0, 20) || 'student';
    for (let i = 0; i < 10; i++) {
      const candidate = `${base}${randomInt(1000, 9999)}`;
      if (!(await this.usersService.findByUsername(candidate)))
        return candidate;
    }
    return `${base}${randomBytes(4).toString('hex')}`;
  }
}
