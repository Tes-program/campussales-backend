import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, Matches, MaxLength, ValidateNested } from 'class-validator';

export class PushKeysDto {
  @ApiProperty()
  @IsString()
  @MaxLength(255)
  p256dh: string;

  @ApiProperty()
  @IsString()
  @MaxLength(255)
  auth: string;
}

/** The browser's PushSubscription.toJSON(). */
export class PushSubscriptionDto {
  @ApiProperty({ description: 'https URL from the browser push service' })
  @IsString()
  @MaxLength(1000)
  @Matches(/^https:\/\/\S+$/, {
    message: 'Push endpoint must be an https URL.',
  })
  endpoint: string;

  @ApiProperty({ type: PushKeysDto })
  @ValidateNested()
  @Type(() => PushKeysDto)
  keys: PushKeysDto;
}

export class PushUnsubscribeDto {
  @ApiProperty()
  @IsString()
  @MaxLength(1000)
  endpoint: string;
}
