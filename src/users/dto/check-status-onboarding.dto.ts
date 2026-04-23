// src/users/dto/check-onboarding-status.dto.ts
export class OnboardingStatusDto {
  isComplete: boolean;
  completedSteps: {
    hasProfile: boolean;
    hasUniversity: boolean;
    hasUniversityName: boolean;
    hasBio: boolean;
    hasProfilePicture: boolean;
  };
  missingFields: string[];
  profileCompletionPercentage: number;
}
