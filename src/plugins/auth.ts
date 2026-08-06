import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthService } from "../ports/auth-service.js";

const AUTH_TIMEOUT_MS = 12_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`Auth verification timed out after ${timeoutMs}ms`) as Error & { statusCode?: number };
      error.statusCode = 503;
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function authPreHandler(authService: AuthService) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }

    try {
      request.log.info("auth.verify.start");
      request.authUser = await withTimeout(authService.verifyBearerToken(token), AUTH_TIMEOUT_MS);
      request.log.info({ uid: request.authUser.uid }, "auth.verify.success");
    } catch (error) {
      const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 401;
      const errorCode = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "unknown";
      const errorMessage = error instanceof Error ? error.message : "Unknown auth error";
      request.log.warn({ statusCode, errorCode, errorMessage }, "auth.verify.failed");

      if (statusCode === 503) {
        reply.code(503).send({ error: "Service Unavailable", message: "Authentication provider timeout" });
        return;
      }

      if (errorCode === "auth/id-token-expired") {
        reply.code(401).send({
          error: "Unauthorized",
          code: "TOKEN_EXPIRED",
          message: "Firebase ID token expired. Refresh token on client and retry."
        });
        return;
      }

      reply.code(401).send({ error: "Unauthorized" });
    }
  };
}
