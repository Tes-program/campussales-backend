import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/user.service';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { UserStatus } from '../../common/enum/user.enums';
import { AppError } from '../../common/errors/app-errors';
import { ErrorCode } from '../../common/errors/error-codes';

const sessionEnded = () =>
  new AppError(
    ErrorCode.UNAUTHENTICATED,
    'Your session has ended. Please log in again.',
  );

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET') || 'fallback-secret',
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.usersService.findById(payload.sub);
    if (
      !user ||
      user.status !== UserStatus.ACTIVE ||
      !user.isActive ||
      user.deletionRequestedAt
    ) {
      throw sessionEnded();
    }
    // Tokens issued before a password change or "sign out everywhere".
    if (
      user.tokensValidAfter &&
      (payload.iat ?? 0) < Math.floor(user.tokensValidAfter.getTime() / 1000)
    ) {
      throw sessionEnded();
    }
    this.touchLastActive(user.id, user.lastActiveAt);
    return user;
  }

  /** Records activity at most every 5 minutes (fire and forget). */
  private touchLastActive(userId: string, last?: Date | null) {
    if (last && Date.now() - last.getTime() < 5 * 60_000) return;
    this.usersService.touchLastActive(userId).catch(() => undefined);
  }
}
