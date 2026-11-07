import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/** The password rule needs the account (email/name), so it runs in the service. */
export class ChangePasswordDto {
  @ApiProperty()
  @IsString({ message: 'Enter your current password.' })
  @MaxLength(1024, { message: 'Enter your current password.' })
  currentPassword: string;

  @ApiProperty()
  @IsString({ message: 'Enter a password.' })
  newPassword: string;
}
