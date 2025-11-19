// src/universities/dto/create-university.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, MaxLength, MinLength } from 'class-validator';

export class CreateUniversityDto {
  @ApiProperty({ example: 'Babcock University' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @ApiProperty({
    example: 'Ilishan-Remo, Ogun State, Nigeria',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  location?: string;

  @ApiProperty({ example: 'BABCOCK', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string;
}
