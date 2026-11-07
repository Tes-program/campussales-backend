import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/user.module';
import { UniversitiesModule } from '../universities/universities.module';
import { RefreshToken } from './entities/refresh-token.entity';
import { PasswordReset } from './entities/password-reset.entity';
import { EmailVerification } from './entities/email-verification.entity';
import { User } from '../users/entities/user.entity';
import { JwtStrategy } from './strategies/jwt.strategy';
import { getJwtConfig } from '../config/jwt.config';
import { RefreshTokenService } from './refresh-token.service';
import { EmailVerifiedGuard } from './guards/email-verified.guard';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: getJwtConfig,
    }),
    TypeOrmModule.forFeature([
      RefreshToken,
      PasswordReset,
      EmailVerification,
      User,
    ]),
    UsersModule,
    UniversitiesModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    RefreshTokenService,
    EmailVerifiedGuard,
  ],
  exports: [AuthService, EmailVerifiedGuard],
})
export class AuthModule {}
