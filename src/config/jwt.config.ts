import { ConfigService } from '@nestjs/config';
import { JwtModuleOptions } from '@nestjs/jwt';

export const getJwtConfig = (
  configService: ConfigService,
): JwtModuleOptions => ({
  secret: configService.get('JWT_SECRET'),
  signOptions: {
    expiresIn: '15m', // Access token expires in 15 minutes
  },
});

export const JWT_REFRESH_SECRET = 'JWT_REFRESH_SECRET';
export const JWT_REFRESH_EXPIRES_IN = '7d';
