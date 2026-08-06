import { cert, getApp, getApps, initializeApp, type App, type ServiceAccount } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import type { AppConfig } from "../../config/env.js";
import type { AuthService, AuthUser } from "../../ports/auth-service.js";

let firebaseApp: App | null = null;

function parseServiceAccount(raw: string): ServiceAccount {
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const privateKeyRaw = parsed.private_key;
  if (typeof privateKeyRaw === "string") {
    parsed.private_key = privateKeyRaw.replace(/\\n/g, "\n");
  }

  return parsed as ServiceAccount;
}

function getFirebaseApp(config: AppConfig): App {
  if (firebaseApp) {
    return firebaseApp;
  }

  const serviceAccount = parseServiceAccount(config.FIREBASE_SERVICE_ACCOUNT_JSON);

  firebaseApp = getApps().length > 0 ? getApp() : initializeApp({
    credential: cert(serviceAccount),
    projectId: config.FIREBASE_PROJECT_ID
  });

  return firebaseApp;
}

export class FirebaseAuthService implements AuthService {
  private readonly auth: Auth;

  constructor(config: AppConfig) {
    this.auth = getAuth(getFirebaseApp(config));
  }

  async verifyBearerToken(token: string): Promise<AuthUser> {
    const decoded = await this.auth.verifyIdToken(token);
    return { uid: decoded.uid };
  }
}
