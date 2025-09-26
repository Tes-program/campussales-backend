import { UserType, UserStatus } from '../../common/enum/user.enums';

export interface JwtPayload {
  sub: string; // user id
  email: string;
  userType: UserType;
  status: UserStatus;
  iat?: number;
  exp?: number;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResponse extends AuthTokens {
  user: {
    id: string;
    email: string;
    userType: UserType;
    status: UserStatus;
    profile?: {
      firstName: string;
      lastName: string;
    };
  };
}
