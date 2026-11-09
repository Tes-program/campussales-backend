// Schema for POST /api/users/onboarding/complete.
// Canonical fields: phone, school. The deployed frontend still sends
// phoneNumber / universityId; those are accepted as aliases and any error is
// reported under the canonical name (fields.phone, fields.school).
//
// H2 decision: `level` is optional (null allowed). Nothing in the product
// (feed, search, listings) reads it, and the deployed frontend never sends
// it, so requiring it blocked every new user. The profile page can ask for it
// later via PATCH /users/me.
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Transform } from 'class-transformer';
import { Allow, IsDateString, IsOptional, IsString } from 'class-validator';
import { MSG } from '../../common/errors/messages';
import { CATEGORY_SLUGS } from '../../common/constants/categories';
import { GENDERS, LEVELS } from '../../common/constants/profile';
import {
  Normalise,
  OptionalRule,
  Rule,
} from '../../common/validation/decorators';
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

export type { Gender } from '../../common/constants/profile';

/** A blank level means "not given". */
const normaliseOptionalLevel = (v: unknown) =>
  v === null || (typeof v === 'string' && v.trim() === '')
    ? null
    : normaliseLevelInput(v);

/** Fields with a fixed list of values; echoed in error.details.allowedValues. */
export const ONBOARDING_ALLOWED_VALUES = {
  level: LEVELS,
  gender: GENDERS,
  interests: CATEGORY_SLUGS,
} as const;

const firstDefined = (...values: unknown[]) =>
  values.find((v) => v !== undefined && v !== null && v !== '');

export class CompleteOnboardingDto {
  @ApiProperty({ example: 'Ada' })
  @Normalise(normaliseText)
  @Rule(makeValidateName(MSG.firstNameInvalid))
  firstName: string;

  @ApiProperty({ example: 'Okafor' })
  @Normalise(normaliseText)
  @Rule(makeValidateName(MSG.lastNameInvalid))
  lastName: string;

  @ApiProperty({
    example: '0803 123 4567',
    description:
      'Nigerian mobile. Saved as +234XXXXXXXXXX. Alias: phoneNumber.',
  })
  @Expose()
  @Transform(({ obj }) =>
    normalisePhoneInput(firstDefined(obj.phone, obj.phoneNumber)),
  )
  @Rule(validatePhone)
  phone: string;

  @ApiPropertyOptional({ deprecated: true, description: 'Alias of phone.' })
  @Allow()
  phoneNumber?: string;

  @ApiProperty({
    description:
      'School id from GET /api/schools (or exact name/short name). Alias: universityId.',
  })
  @Expose()
  @Transform(({ obj }) =>
    normaliseText(firstDefined(obj.school, obj.universityId)),
  )
  @Rule(validateSchoolRef)
  school: string;

  @ApiPropertyOptional({ deprecated: true, description: 'Alias of school.' })
  @Allow()
  universityId?: string;

  @ApiPropertyOptional({
    deprecated: true,
    description: 'Ignored; the canonical name is stored.',
  })
  @Allow()
  universityName?: string;

  @ApiPropertyOptional({
    enum: LEVELS,
    nullable: true,
    example: '300',
    description: 'Optional. Omit to keep the current value; null clears it.',
  })
  @Normalise(normaliseOptionalLevel)
  @OptionalRule((v) => (v === null ? null : validateLevel(v)))
  level?: string | null;

  @ApiPropertyOptional({ enum: GENDERS })
  @Normalise(normaliseGenderInput)
  @Rule(validateGender)
  gender?: string;

  @ApiPropertyOptional({ type: [String], enum: CATEGORY_SLUGS, maxItems: 8 })
  @Normalise(normaliseInterests)
  @Rule(validateInterests)
  interests?: string[];

  @ApiPropertyOptional({ example: '2003-05-14' })
  @IsOptional()
  @IsDateString({}, { message: 'Enter a valid date of birth.' })
  dateOfBirth?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @Normalise(normaliseText)
  @OptionalRule((v) =>
    typeof v === 'string' && v.length <= 500 ? null : MSG.bioLong,
  )
  bio?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: MSG.invalidValue })
  profilePictureUrl?: string;
}
