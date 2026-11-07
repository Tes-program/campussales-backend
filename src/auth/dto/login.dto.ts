import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Deliberately loose: any shape problem is reported like a wrong password
 * (no field hints), except a missing value.
 */
export class LoginDto {
  @ApiProperty({ example: 'ada@unilag.edu.ng' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString({ message: 'Enter your email.' })
  @MaxLength(254, { message: 'Enter your email.' })
  email: string;

  @ApiProperty()
  @IsString({ message: 'Enter your password.' })
  @MaxLength(1024, { message: 'Enter your password.' })
  password: string;
}
