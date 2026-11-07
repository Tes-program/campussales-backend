import { ErrorCode } from './error-codes';

/**
 * Student-facing copy. Where the frontend already had a message for the same
 * problem (Sell form toasts, api client) the same wording is used here. The frontend
 * should be able to show `error.message` and `error.fields[x]` verbatim.
 */
export const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.VALIDATION_FAILED]: 'Please fix the highlighted fields.',
  [ErrorCode.UNAUTHENTICATED]: 'Please log in to continue.',
  [ErrorCode.FORBIDDEN]: 'You do not have permission to perform this action.',
  [ErrorCode.NOT_FOUND]: "We couldn't find what you're looking for.",
  [ErrorCode.CONFLICT]: 'That clashes with something that already exists.',
  [ErrorCode.RATE_LIMITED]:
    "You're doing that too often. Please wait a moment and try again.",
  [ErrorCode.SERVER_ERROR]:
    'Something went wrong on our side. Please try again in a moment.',
};

export const MSG = {
  // Generic validation
  invalidRequest: 'Please check your details and try again.',
  invalidJson: "We couldn't read that request. Please try again.",
  fieldNotAllowed: "This field isn't accepted here.",
  invalidValue: "This value isn't valid.",
  required: 'This field is required.',
  requestTimeout: 'This is taking longer than usual. Please try again.',

  // Listings
  titleRequired: 'Please enter a product title.',
  titleType: 'Title must be text.',
  titleShort: 'Title must be at least 3 characters.',
  titleLong: 'Title must be 80 characters or fewer.',
  titleControl: 'Title contains characters we can’t display. Please retype it.',
  descriptionType: 'Description must be text.',
  descriptionLong: 'Description must be 600 characters or fewer.',
  descriptionControl:
    'Description contains characters we can’t display. Please retype it.',
  priceRequired: 'Enter a price.',
  priceNotNumber: 'Price must be a number, like 2500.',
  priceWhole: 'Price must be a whole number of naira (no kobo).',
  priceMin: 'Price must be at least ₦50.',
  priceMax: 'Price can’t be more than ₦100,000,000.',
  quantityNotNumber: 'Quantity must be a number.',
  quantityWhole: 'Quantity must be a whole number.',
  quantityMin: 'Quantity must be at least 1.',
  quantityMax: 'Quantity can’t be more than 999.',
  categoryRequired: 'Please select a category.',
  categoryInvalid: 'Choose a category from the list.',
  categoryUnavailable:
    'That category isn’t available right now. Choose another one.',
  conditionRequired: 'Choose the item’s condition.',
  conditionInvalid: 'Condition must be New, Like New, Used or Fair.',
  imagesRequired: 'Please add at least one image.',
  imagesType: 'Photos must be a list of uploaded images.',
  imagesMax: 'Maximum 5 images allowed.',
  imagesHost: 'Photos must be uploaded through CampusSales.',
  imagesDuplicate: 'Each photo can only be added once.',
  tagsType: 'Tags must be a list of words.',
  tagsMax: 'You can add up to 10 tags.',
  tagLength: 'Each tag must be 2 to 24 characters.',
  tagChars: 'Tags can only use letters, numbers, spaces and hyphens.',

  productNotFound: 'This item is no longer available.',
  productNotOwner: 'Only the seller can change this item.',
  productSoldLocked:
    'Sold items can’t be edited. Relist it first if you want to sell it again.',
  productSoldActivate:
    'This item is marked as sold. Relist it to make it active again.',
  relistTooSoon: 'You can bump a listing once every 24 hours. Try again later.',
  draftIncomplete: 'Finish the highlighted fields before publishing.',

  // Onboarding / profile
  phoneRequired: 'Enter your phone number.',
  phoneInvalid: 'Enter a valid Nigerian phone number, like 0803 123 4567.',
  phoneTaken: 'That number is already used on another account.',
  schoolRequired: 'Choose your school.',
  schoolInvalid: 'Choose your school from the list.',
  levelRequired: 'Choose your level.',
  levelInvalid: 'Level must be 100 to 600, Postgraduate or Alumnus.',
  genderInvalid: 'Gender must be Male, Female or Prefer not to say.',
  interestsType: 'Interests must be a list of categories.',
  interestsMax: 'You can pick up to 8 interests.',
  interestsInvalid: 'Pick interests from the categories list.',
  firstNameInvalid: 'First name must be 2 to 50 characters.',
  lastNameInvalid: 'Last name must be 2 to 50 characters.',
  bioLong: 'Bio must be 500 characters or fewer.',
  emailTaken: 'That email is already used on another account.',
  schoolQueryLong: 'Search must be 100 characters or fewer.',
} as const;
