import type { AppConfig } from "../../config/env.js";
import type { AuthService, AuthUser } from "../../ports/auth-service.js";

type FirebaseLookupResponse = {
  users?: Array<{ localId?: string }>;
  error?: { message?: string };
};

type AuthError = Error & { code?: string };

export class FirebaseAuthService implements AuthService {
  private readonly apiKey: string | undefined;
  private readonly timeoutMs = 12_000;

  constructor(config: AppConfig) {
    this.apiKey = config.FIREBASE_WEB_API_KEY;
  }

  private createAuthError(message: string, code: string): AuthError {
    const error = new Error(message) as AuthError;
    error.code = code;
    return error;
  }

  async verifyBearerToken(token: string): Promise<AuthUser> {
    if (!this.apiKey) {
      throw this.createAuthError("FIREBASE_WEB_API_KEY is required to verify Firebase ID tokens in Workers runtime", "auth/configuration-error");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(this.apiKey)}`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ idToken: token })
        }
      );

      const payload = (await response.json()) as FirebaseLookupResponse;
      const message = payload.error?.message;

      if (!response.ok) {
        if (message === "TOKEN_EXPIRED") {
          throw this.createAuthError("Firebase ID token expired", "auth/id-token-expired");
        }

        throw this.createAuthError(`Firebase token verification failed (${response.status}): ${message ?? "unknown"}`, "auth/invalid-token");
      }

      const uid = payload.users?.[0]?.localId;
      if (!uid) {
        throw this.createAuthError("Firebase token verification did not return a user id", "auth/invalid-token");
      }

      return { uid };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw this.createAuthError("Firebase token verification timed out", "auth/timeout");
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
