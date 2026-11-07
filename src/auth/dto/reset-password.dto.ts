import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Transform } from 'class-transformer';
import { Allow, IsString, Length } from 'class-validator';

/** The password rule needs the account (email/name), so it runs in the service. */
export class ResetPasswordDto {
  @ApiProperty({ description: 'The token from the emailed link.' })
  @IsString({
    message: 'This link is no longer valid. Please request a new one.',
  })
  @Length(10, 200, {
    message: 'This link is no longer valid. Please request a new one.',
  })
  token: string;

  @ApiProperty({ description: 'Alias: password.' })
  @Expose()
  @Transform(
    ({ obj }: { obj: Record<string, unknown> }) =>
      obj.newPassword ?? obj.password,
  )
  @IsString({ message: 'Enter a password.' })
  newPassword: string;

  @ApiPropertyOptional({ deprecated: true })
  @Allow()
  password?: string;
}
