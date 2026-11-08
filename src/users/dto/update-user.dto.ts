// Schemas for PATCH /api/users/me (UpdateMeDto) and the admin-only
// PATCH /api/users/:id (UpdateUserDto). Same validators as onboarding.
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Transform, Type } from 'class-transformer';
import {
  Allow,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { MSG } from '../../common/errors/messages';
import { UserStatus, UserType } from '../../common/enum/user.enums';
import { CATEGORY_SLUGS } from '../../common/constants/categories';
import { GENDERS, LEVELS } from '../../common/constants/profile';
import { Normalise, OptionalRule } from '../../common/validation/decorators';
import {
  makeValidateName,
  normaliseGenderInput,
  normaliseInterests,
  normaliseLevelInput,
  normalisePhoneInput,
  normaliseText,
  validateGender,
  validateInterests,
  validateLevel,
  validatePhone,
  validateSchoolRef,
} from '../../common/validation/rules';

/** null or "" clears the phone number. */
const validateOptionalPhone = (v: unknown) =>
  v === null || v === '' ? null : validatePhone(v);

export class UpdateMyProfileDto {
  @ApiPropertyOptional()
  @Normalise(normaliseText)
  @OptionalRule(makeValidateName(MSG.firstNameInvalid))
  firstName?: string;

  @ApiPropertyOptional()
  @Normalise(normaliseText)
  @OptionalRule(makeValidateName(MSG.lastNameInvalid))
  lastName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString({}, { message: 'Enter a valid date of birth.' })
  dateOfBirth?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: MSG.invalidValue })
  profilePictureUrl?: string;

  @ApiPropertyOptional({
    description: 'School id or exact name. Alias: universityId.',
  })
  @Expose()
  @Transform(({ obj }) => normaliseText(obj.school ?? obj.universityId))
  @OptionalRule(validateSchoolRef)
  school?: string;

  @ApiPropertyOptional({ deprecated: true })
  @Allow()
  universityId?: string;

  @ApiPropertyOptional({ deprecated: true, description: 'Ignored.' })
  @Allow()
  universityName?: string;

  @ApiPropertyOptional({ enum: LEVELS })
  @Normalise(normaliseLevelInput)
  @OptionalRule(validateLevel)
  level?: string;

  @ApiPropertyOptional({ enum: GENDERS, nullable: true })
  @Normalise(normaliseGenderInput)
  @OptionalRule(validateGender)
  gender?: string | null;

  @ApiPropertyOptional({ type: [String], enum: CATEGORY_SLUGS, maxItems: 8 })
  @Normalise(normaliseInterests)
  @OptionalRule(validateInterests)
  interests?: string[];

  @ApiPropertyOptional({ maxLength: 500 })
  @Normalise(normaliseText)
  @OptionalRule((v) =>
    v === null || (typeof v === 'string' && v.length <= 500)
      ? null
      : MSG.bioLong,
  )
  bio?: string | null;
}

/** PATCH /api/users/me — what a student may change about themselves. */
export class UpdateMeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail({}, { message: 'Enter a valid email address.' })
  email?: string;

  @ApiPropertyOptional({
    description:
      'Nigerian mobile, saved as +234XXXXXXXXXX. null clears it. Alias: phoneNumber.',
    nullable: true,
  })
  @Expose()
  @Transform(({ obj }: { obj: Record<string, unknown> }) => {
    const raw = obj.phone !== undefined ? obj.phone : obj.phoneNumber;
    return raw === null || raw === '' ? raw : normalisePhoneInput(raw);
  })
  @OptionalRule(validateOptionalPhone)
  phone?: string | null;

  @ApiPropertyOptional({ deprecated: true, description: 'Alias of phone.' })
  @Allow()
  phoneNumber?: string | null;

  @ApiPropertyOptional({ type: UpdateMyProfileDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateMyProfileDto)
  profile?: UpdateMyProfileDto;

  @ApiPropertyOptional({
    description:
      'Settings > "Share usage data" (default true). false: product analytics events from this account are dropped.',
  })
  @IsOptional()
  @IsBoolean({ message: 'Choose on or off.' })
  shareUsageData?: boolean;
}

/** PATCH /api/users/:id — admin only. */
export class UpdateUserDto extends UpdateMeDto {
  @ApiPropertyOptional({ enum: UserType })
  @IsOptional()
  @IsEnum(UserType)
  userType?: UserType;

  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isVerified?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** @deprecated kept so existing imports compile */
export { UpdateMyProfileDto as UpdateUserProfileDto };
