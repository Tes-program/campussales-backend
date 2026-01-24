// src/users/dto/onboarding.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsUUID,
  IsDateString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CompleteOnboardingDto {
  @ApiProperty({ example: 'John' })
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  lastName: string;

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  @IsUUID()
  universityId: string;

  @ApiProperty({ example: 'Babcock University', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  universityName?: string;

  // Gender
  @ApiProperty({ example: 'Male', required: false })
  @IsOptional()
  @IsString()
  gender?: 'Male' | 'Female';

  // Interest
  @ApiProperty({
    example: 'Technology, Sports, Music',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  interests?: string;

  // Phone Number
  @ApiProperty({
    example: '+1234567890',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MinLength(7)
  @MaxLength(15)
  phoneNumber?: string;

  @ApiProperty({
    example: '100',
    description: '100, 200, 300, 400, etc.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  level?: string;

  @ApiProperty({ example: '2000-01-01', required: false })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: Date;

  @ApiProperty({
    example: 'Passionate about technology and innovation',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  profilePictureUrl?: string;
}
