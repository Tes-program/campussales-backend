import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-errors';
import { ErrorCode } from '../../common/errors/error-codes';
import { User } from '../../users/entities/user.entity';

/**
 * New accounts may use the app unverified for 24 hours (users.verifyBy).
 * After that, guarded write actions return 403 EMAIL_NOT_VERIFIED.
 * Accounts created before B2 have no deadline. Use after JwtAuthGuard.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<{ user?: User }>().user;
    if (!user || user.emailVerifiedAt || !user.verifyBy) return true;
    if (user.verifyBy.getTime() > Date.now()) return true;
    throw new AppError(ErrorCode.EMAIL_NOT_VERIFIED);
  }
}
