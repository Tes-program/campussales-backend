import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { UserStatus } from '../../common/enum/user.enums';

/** Schema for PATCH /api/users/:id/status (admin). */
export class UpdateUserStatusDto {
  @ApiProperty({ enum: UserStatus })
  @IsEnum(UserStatus, {
    message: 'Status must be active, inactive or suspended.',
  })
  status: UserStatus;
}
