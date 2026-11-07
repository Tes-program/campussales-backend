import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { runSchema } from '../common/validation/run-schema';
import { ValidationFailed } from '../common/errors/app-errors';
import { User } from '../users/entities/user.entity';
import { toPublicUser } from '../users/user.service';
import {
  AUTH,
  legacyTokensEnabled,
  readCookie,
  refreshCookieOptions,
} from './auth.config';
import { AuthService, IssuedSession, SessionContext } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { LegacyRegisterDto, SignupDto } from './dto/signup.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

const ctxOf = (req: Request): SessionContext => ({
  ip: req.ip,
  userAgent: req.get('user-agent') ?? undefined,
});

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Post('signup')
  @ApiOperation({ summary: 'Create an account. Sets the refresh cookie.' })
  @ApiResponse({ status: 201, description: '{ accessToken, expiresIn, user }' })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_FAILED (e.g. fields.acceptedTerms)',
  })
  @ApiResponse({
    status: 409,
    description: 'CONFLICT - email already registered',
  })
  @ApiResponse({ status: 429, description: 'RATE_LIMITED' })
  async signup(
    @Body() dto: SignupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.sessionResponse(
      res,
      await this.authService.signup(dto, ctxOf(req)),
    );
  }

  /**
   * @deprecated Used by the deployed frontend. While AUTH_LEGACY_TOKENS=true
   * it accepts the old body ({ email, password, username }) without terms;
   * otherwise it behaves exactly like /auth/signup.
   */
  @Post('register')
  @ApiOperation({
    summary: 'Deprecated alias of /auth/signup',
    deprecated: true,
  })
  @ApiBody({ type: LegacyRegisterDto })
  async register(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { value, fields, ok } = legacyTokensEnabled(this.config)
      ? await runSchema<SignupDto | LegacyRegisterDto>(
          LegacyRegisterDto,
          body ?? {},
        )
      : await runSchema<SignupDto | LegacyRegisterDto>(SignupDto, body ?? {});
    if (!ok) throw new ValidationFailed(fields);
    return this.sessionResponse(
      res,
      await this.authService.signup(value, ctxOf(req)),
    );
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log in. Sets the refresh cookie.' })
  @ApiResponse({ status: 200, description: '{ accessToken, expiresIn, user }' })
  @ApiResponse({ status: 401, description: 'INVALID_CREDENTIALS' })
  @ApiResponse({
    status: 429,
    description: 'RATE_LIMITED with retryAfterSeconds',
  })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.sessionResponse(
      res,
      await this.authService.login(dto, ctxOf(req)),
    );
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth(AUTH.cookieName)
  @ApiOperation({
    summary: 'Rotate the refresh cookie and get a new access token.',
  })
  @ApiResponse({ status: 200, description: '{ accessToken, expiresIn, user }' })
  @ApiResponse({
    status: 401,
    description: 'UNAUTHENTICATED - missing, expired, revoked or reused',
  })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const session = await this.authService.refresh(
        this.presentedToken(req, dto),
        ctxOf(req),
      );
      return this.sessionResponse(res, session);
    } catch (e) {
      res.clearCookie(AUTH.cookieName, this.clearOptions());
      throw e;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth(AUTH.cookieName)
  @ApiOperation({
    summary:
      'Revoke this session (token family) and clear the cookie. Works with an expired access token.',
  })
  @ApiResponse({ status: 204 })
  async logout(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logout(this.presentedToken(req, dto));
    res.clearCookie(AUTH.cookieName, this.clearOptions());
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out of all devices.' })
  @ApiResponse({ status: 204 })
  async logoutAll(
    @CurrentUser() user: User,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logoutAll(user.id);
    res.clearCookie(AUTH.cookieName, this.clearOptions());
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Change password. Signs out other devices, emails the user, returns a fresh access token.',
  })
  @ApiResponse({
    status: 200,
    description: '{ message, accessToken, expiresIn }',
  })
  @ApiResponse({
    status: 400,
    description: 'fields.currentPassword or fields.newPassword',
  })
  async changePassword(
    @CurrentUser() user: User,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    return this.authService.changePassword(
      user,
      dto,
      this.presentedToken(req, {}),
    );
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Always 200: "If that email has an account, we\'ve sent a link."',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    return this.authService.forgotPassword(dto, ctxOf(req));
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a new password with the emailed token.' })
  @ApiResponse({
    status: 400,
    description: 'TOKEN_INVALID, TOKEN_EXPIRED or fields.newPassword',
  })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm an email address with the emailed token.' })
  @ApiResponse({ status: 400, description: 'TOKEN_INVALID or TOKEN_EXPIRED' })
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto.token);
  }

  @Post('resend-verification')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a new confirmation link (3 per hour).' })
  @ApiResponse({
    status: 429,
    description: 'RATE_LIMITED with retryAfterSeconds',
  })
  async resendVerification(@CurrentUser() user: User) {
    return this.authService.resendVerification(user);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current user (includes emailVerified)' })
  getCurrentUser(@CurrentUser() user: User) {
    return toPublicUser(user);
  }

  // ─────────────────────────────────────────────────────────────────

  private presentedToken(
    req: Request,
    dto: RefreshTokenDto,
  ): string | undefined {
    const fromCookie = readCookie(req.headers.cookie, AUTH.cookieName);
    if (fromCookie) return fromCookie;
    return legacyTokensEnabled(this.config) ? dto?.refreshToken : undefined;
  }

  private sessionResponse(res: Response, s: IssuedSession) {
    res.cookie(
      AUTH.cookieName,
      s.refreshToken,
      refreshCookieOptions(this.config),
    );
    res.setHeader('Cache-Control', 'no-store');
    return {
      accessToken: s.accessToken,
      tokenType: 'Bearer',
      expiresIn: s.expiresIn,
      user: s.user,
      // Legacy: the deployed frontend stores this. Removed after AUTH.legacyRemovalDate.
      ...(legacyTokensEnabled(this.config)
        ? { refreshToken: s.refreshToken }
        : {}),
    };
  }

  private clearOptions() {
    const options = refreshCookieOptions(this.config);
    delete options.maxAge;
    return options;
  }
}
