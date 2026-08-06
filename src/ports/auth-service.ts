export type AuthUser = {
  uid: string;
};

export interface AuthService {
  verifyBearerToken(token: string): Promise<AuthUser>;
}
