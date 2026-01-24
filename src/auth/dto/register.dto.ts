import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  MinLength,
  IsEnum,
  IsOptional,
} from 'class-validator';
import { UserType } from '../../common/enum/user.enums';

export class RegisterDto {
  @ApiProperty({ example: 'john.doe@university.edu' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'strongPassword123' })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiProperty({ example: 'johndoe' })
  @IsString()
  username: string;

  @ApiProperty({ enum: UserType, default: UserType.STUDENT })
  @IsEnum(UserType)
  @IsOptional()
  userType?: UserType = UserType.STUDENT;
}
