import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class VerifyEmailDto {
  @ApiProperty({ description: 'The token from the emailed link.' })
  @IsString({
    message: 'This link is no longer valid. Please request a new one.',
  })
  @Length(10, 200, {
    message: 'This link is no longer valid. Please request a new one.',
  })
  token: string;
}
