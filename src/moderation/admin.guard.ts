import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { forbidden } from '../common/errors/app-errors';
import { UserType } from '../common/enum/user.enums';
import { User } from '../users/entities/user.entity';

/**
 * Admin API access needs BOTH a logged-in admin (userType=admin) AND the
 * separate X-Admin-Key header matching ADMIN_API_KEY. A stolen student token,
 * or even an admin's normal token alone, is not enough. Without
 * ADMIN_API_KEY configured the admin API is disabled. Use after JwtAuthGuard.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      user?: User;
      headers: Record<string, string | undefined>;
    }>();
    const expected = this.config.get<string>('ADMIN_API_KEY');
    const given = req.headers['x-admin-key'];
    const keyOk =
      !!expected &&
      typeof given === 'string' &&
      given.length === expected.length &&
      timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!req.user || req.user.userType !== UserType.ADMIN || !keyOk) {
      throw forbidden();
    }
    return true;
  }
}
