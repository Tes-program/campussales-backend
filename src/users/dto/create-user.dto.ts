import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  IsOptional,
  IsDateString,
  IsUUID,
} from 'class-validator';

export class CreateUserProfileDto {
  @ApiProperty({ example: 'John' })
  @IsString()
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  lastName: string;

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

export class CreateUserDto {
  @ApiProperty({ example: 'john.doe@university.edu' })
  @IsEmail()
  email: string;

  @IsString()
  passwordHash: string; // This will be hashed password, not plain text

  @ApiProperty({ example: 'johndoe' })
  @IsString()
  username: string;
}
