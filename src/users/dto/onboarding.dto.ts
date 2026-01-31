// src/users/dto/onboarding.dto.ts - UPDATE
import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsUUID,
  IsDateString,
  MaxLength,
  MinLength,
  IsEnum,
} from 'class-validator';
import { Transform } from 'class-transformer';

// Add this enum to match your entity
export enum Gender {
  MALE = 'Male',
  FEMALE = 'Female',
}

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

  // ✅ FIX: Add proper enum validation and transformation
  @ApiProperty({
    example: 'Male',
    enum: Gender,
    description: 'Gender (Male or Female)',
    required: false,
  })
  @IsOptional()
  @IsEnum(Gender, { message: 'Gender must be either "Male" or "Female"' })
  @Transform(({ value }: { value: unknown }) => {
    // Capitalize first letter to match enum
    if (typeof value === 'string') {
      return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
    }
    return value as Gender;
  })
  gender?: Gender;

  // ✅ FIX: Validate interests as array
  @ApiProperty({
    example: ['Technology', 'Sports', 'Music'],
    description: 'Array of user interests',
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsString({ each: true })
  @Transform(({ value }: { value: unknown }) => {
    // Handle if sent as JSON string
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as string[];
      } catch {
        return value.split(',').map((i) => i.trim());
      }
    }
    return value as string[];
  })
  interests?: string[];

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
    example: '400',
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
