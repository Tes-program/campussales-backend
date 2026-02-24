import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  IsOptional,
  IsEnum,
  ValidateNested,
  IsBoolean,
  IsDateString,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UserType, UserStatus } from '../../common/enum/user.enums';

export class UpdateUserProfileDto {
  @ApiProperty({ example: 'John', required: false })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiProperty({ example: 'Doe', required: false })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiProperty({ example: '1990-01-01', required: false })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: Date;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  profilePictureUrl?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  universityId?: string;

  @ApiProperty({ example: 'University of Example', required: false })
  @IsOptional()
  @IsString()
  universityName?: string;

  @ApiProperty({ example: 'Computer Science', required: false })
  @IsOptional()
  @IsString()
  department?: string;

  @ApiProperty({ example: 'undergraduate', required: false })
  @IsOptional()
  @IsString()
  studentLevel?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  bio?: string;
}

export class UpdateUserDto {
  @ApiProperty({ example: 'john.doe@university.edu', required: false })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ example: '+1234567890', required: false })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiProperty({ enum: UserType, required: false })
  @IsOptional()
  @IsEnum(UserType)
  userType?: UserType;

  @ApiProperty({ enum: UserStatus, required: false })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isVerified?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ type: UpdateUserProfileDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateUserProfileDto)
  profile?: UpdateUserProfileDto;
}
