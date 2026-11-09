import { runSchema } from '../../common/validation/run-schema';
import { CompleteOnboardingDto } from './onboarding.dto';
import { UpdateMeDto } from './update-user.dto';

const SCHOOL_ID = '9f1e6a2c-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const valid = () => ({
  firstName: 'Ada',
  lastName: 'Okafor',
  phone: '08031234567',
  school: SCHOOL_ID,
  level: '300',
  gender: 'Female',
  interests: ['electronics'],
});
const onboard = (o: Record<string, unknown>) =>
  runSchema(CompleteOnboardingDto, { ...valid(), ...o });

const PHONE_MSG = 'Enter a valid Nigerian phone number, like 0803 123 4567.';

describe('CompleteOnboardingDto', () => {
  it('accepts a valid payload and normalises the phone', async () => {
    const r = await onboard({});
    expect(r.fields).toEqual({});
    expect(r.value.phone).toBe('+2348031234567');
  });

  describe('phone', () => {
    it.each([
      ['08031234567', '+2348031234567'],
      ['0803 123 4567', '+2348031234567'],
      ['0803-123-4567', '+2348031234567'],
      ['+2348031234567', '+2348031234567'],
      ['+234 803 123 4567', '+2348031234567'],
      ['2348031234567', '+2348031234567'],
      ['07012345678', '+2347012345678'],
      ['08112345678', '+2348112345678'],
      ['09012345678', '+2349012345678'],
      ['09112345678', '+2349112345678'],
    ])('accepts %p as %p', async (phone, stored) => {
      const r = await onboard({ phone });
      expect(r.fields.phone).toBeUndefined();
      expect(r.value.phone).toBe(stored);
    });

    it.each([
      '123',
      '0803123456', // 10 digits
      '080312345678', // 12 digits
      '06031234567', // 060 is not a mobile prefix
      '08231234567', // 082 is not a mobile prefix
      '+2340803123456',
      '+14155550123',
      'O8O31234567', // letter O
      '０８０３１２３４５６７', // full-width digits
      '😀',
    ])('rejects %p with the friendly message', async (phone) => {
      expect((await onboard({ phone })).fields.phone).toBe(PHONE_MSG);
    });

    it('requires a phone', async () => {
      expect((await onboard({ phone: undefined })).fields.phone).toBe(
        'Enter your phone number.',
      );
      expect((await onboard({ phone: '' })).fields.phone).toBe(
        'Enter your phone number.',
      );
    });

    it('accepts the legacy phoneNumber field and reports errors under phone', async () => {
      const ok = await onboard({
        phone: undefined,
        phoneNumber: '0803 123 4567',
      });
      expect(ok.fields).toEqual({});
      expect(ok.value.phone).toBe('+2348031234567');
      const bad = await onboard({ phone: undefined, phoneNumber: '123' });
      expect(bad.fields).toEqual({ phone: PHONE_MSG });
    });
  });

  describe('school', () => {
    it('requires a school', async () => {
      expect((await onboard({ school: undefined })).fields.school).toBe(
        'Choose your school.',
      );
    });
    it('accepts the legacy universityId field', async () => {
      const r = await onboard({ school: undefined, universityId: SCHOOL_ID });
      expect(r.ok).toBe(true);
      expect(r.value.school).toBe(SCHOOL_ID);
    });
  });

  describe('level', () => {
    it.each([
      ['100', '100'],
      ['600', '600'],
      ['300L', '300'],
      ['400 Level', '400'],
      [200, '200'],
      ['postgraduate', 'Postgraduate'],
      ['Alumnus', 'Alumnus'],
      ['Graduate', 'Alumnus'], // what the deployed frontend sends
    ])('accepts %p as %p', async (level, stored) => {
      const r = await onboard({ level });
      expect(r.fields.level).toBeUndefined();
      expect(r.value.level).toBe(stored);
    });
    it.each(['700', '0', 'Year 2'])('rejects %p', async (level) => {
      expect((await onboard({ level })).fields.level).toBe(
        'Level must be 100 to 600, Postgraduate or Alumnus.',
      );
    });
    it('is optional (H2): missing, null or blank are fine', async () => {
      for (const level of [undefined, null, '', '  ']) {
        const r = await onboard({ level });
        expect(r.fields).toEqual({});
      }
      expect((await onboard({ level: '' })).value.level).toBeNull();
    });
  });

  describe('gender', () => {
    it.each([
      ['male', 'Male'],
      ['FEMALE', 'Female'],
      ['prefer not to say', 'Prefer not to say'],
      ['prefer_not_to_say', 'Prefer not to say'],
    ])('accepts %p', async (gender, stored) => {
      const r = await onboard({ gender });
      expect(r.ok).toBe(true);
      expect(r.value.gender).toBe(stored);
    });
    it('is optional', async () => {
      expect((await onboard({ gender: undefined })).ok).toBe(true);
    });
    it('rejects other values', async () => {
      expect((await onboard({ gender: 'robot' })).fields.gender).toBe(
        'Gender must be Male, Female or Prefer not to say.',
      );
    });
  });

  describe('interests', () => {
    it('accepts 0 to 8 and maps legacy frontend values to slugs', async () => {
      expect((await onboard({ interests: [] })).ok).toBe(true);
      const r = await onboard({
        interests: [
          'electronics',
          'clothing',
          'home-kitchen',
          'beauty',
          'sports',
          'toys-games',
          'books',
        ],
      });
      expect(r.ok).toBe(true);
      expect(r.value.interests).toEqual([
        'electronics',
        'clothing-apparel',
        'home-kitchen',
        'beauty-personal-care',
        'sports-outdoors',
        'gaming',
        'books-textbooks',
      ]);
    });
    it('rejects more than 8', async () => {
      const nine = [
        'electronics',
        'books-textbooks',
        'clothing-apparel',
        'furniture',
        'sports-outdoors',
        'musical-instruments',
        'school-supplies',
        'home-kitchen',
        'art-crafts',
      ];
      expect((await onboard({ interests: nine })).fields.interests).toBe(
        'You can pick up to 8 interests.',
      );
    });
    it('rejects values outside the categories list', async () => {
      expect((await onboard({ interests: ['crypto'] })).fields.interests).toBe(
        'Pick interests from the categories list.',
      );
    });
  });

  it('validates names, including unicode', async () => {
    expect((await onboard({ firstName: 'Ọlálékan' })).ok).toBe(true);
    expect((await onboard({ firstName: 'A' })).fields.firstName).toBe(
      'First name must be 2 to 50 characters.',
    );
    expect((await onboard({ lastName: 'x'.repeat(51) })).fields.lastName).toBe(
      'Last name must be 2 to 50 characters.',
    );
  });

  it('accepts the exact payload the deployed frontend sends (no level)', async () => {
    const r = await runSchema(CompleteOnboardingDto, {
      firstName: 'Ada',
      lastName: 'Okafor',
      phoneNumber: '08031234567',
      gender: undefined, // "Prefer not to say" is sent as no gender
      universityId: SCHOOL_ID,
      interests: ['Clothing & Apparel', 'Beauty & Personal Care'],
    });
    expect(r.fields).toEqual({});
    expect(r.value.interests).toEqual([
      'clothing-apparel',
      'beauty-personal-care',
    ]);
  });
});

describe('UpdateMeDto', () => {
  it('uses the same phone rule', async () => {
    expect((await runSchema(UpdateMeDto, { phone: '123' })).fields.phone).toBe(
      PHONE_MSG,
    );
    expect(
      (await runSchema(UpdateMeDto, { phoneNumber: '0803 123 4567' })).value
        .phone,
    ).toBe('+2348031234567');
  });
  it('allows clearing the phone with null', async () => {
    expect((await runSchema(UpdateMeDto, { phone: null })).ok).toBe(true);
  });
  it('validates nested profile fields with dotted paths', async () => {
    const r = await runSchema(UpdateMeDto, {
      profile: { level: '900', interests: ['crypto'] },
    });
    expect(r.fields).toEqual({
      'profile.level': 'Level must be 100 to 600, Postgraduate or Alumnus.',
      'profile.interests': 'Pick interests from the categories list.',
    });
  });
  it('does not let a student change their own role or status', async () => {
    const r = await runSchema(UpdateMeDto, {
      userType: 'admin',
      status: 'active',
      isVerified: true,
    });
    expect(Object.keys(r.fields).sort()).toEqual([
      'isVerified',
      'status',
      'userType',
    ]);
  });
});
