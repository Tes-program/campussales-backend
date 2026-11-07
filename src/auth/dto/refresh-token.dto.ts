import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The refresh token normally travels in the HttpOnly cookie. The body field is
 * only read while AUTH_LEGACY_TOKENS=true (deployed frontend).
 */
export class RefreshTokenDto {
  @ApiPropertyOptional({ deprecated: true })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  refreshToken?: string;
}
