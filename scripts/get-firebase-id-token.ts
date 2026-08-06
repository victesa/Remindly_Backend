import "dotenv/config";

const API_KEY = process.env.FIREBASE_WEB_API_KEY?.trim();
const EMAIL = process.env.TEST_USER_EMAIL?.trim();
const PASSWORD = process.env.TEST_USER_PASSWORD?.trim();

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

async function main(): Promise<void> {
  const apiKey = requireEnv("FIREBASE_WEB_API_KEY", API_KEY);
  const email = requireEnv("TEST_USER_EMAIL", EMAIL);
  const password = requireEnv("TEST_USER_PASSWORD", PASSWORD);

  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email,
      password,
      returnSecureToken: true
    })
  });

  const body = (await response.json()) as {
    idToken?: string;
    localId?: string;
    expiresIn?: string;
    error?: {
      message?: string;
    };
  };

  if (!response.ok || !body.idToken) {
    const reason = body.error?.message ?? `HTTP_${response.status}`;
    throw new Error(`Failed to sign in test user: ${reason}`);
  }

  const expiresInSeconds = Number(body.expiresIn ?? "0");
  const expiresAtIso = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
    ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
    : "unknown";

  console.log("UID:", body.localId ?? "unknown");
  console.log("Expires At:", expiresAtIso);
  console.log("ID Token:");
  console.log(body.idToken);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
