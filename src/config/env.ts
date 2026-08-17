import dotenv from "dotenv";
import { z } from "zod";

const isCloudflareWorkersRuntime = typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== "undefined";
if (!isCloudflareWorkersRuntime) {
  dotenv.config({ override: true });
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8080),
  LLM_PROVIDER: z.enum(["gemini", "openrouter"]).default("gemini"),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_BASIC_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_ADVANCED_MODEL: z.string().default("gemini-2.5-pro"),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_MODEL: z.string().default("openai/gpt-4o-mini"),
  OPENROUTER_ADVANCED_MODEL: z.string().min(1).optional(),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  LLM_ENABLE_PROVIDER_FAILOVER: z.coerce.boolean().default(true),
  LLM_LOW_COST_MODE: z.coerce.boolean().default(false),
  LLM_DISABLE_ADVANCED_FALLBACK: z.coerce.boolean().default(false),
  LLM_MAX_INFERENCE_TEXT_LENGTH: z.coerce.number().int().min(2000).max(50000).default(12000),
  LLM_MAX_LLM_CALLS_PER_REQUEST: z.coerce.number().int().min(1).max(12).default(4),
  LLM_DEDUPE_TTL_SECONDS: z.coerce.number().int().min(0).max(86400).default(300),
  LLM_DAILY_REQUEST_BUDGET: z.coerce.number().int().positive().optional(),
  OCR_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.45),
  DEFAULT_TIMEZONE: z.string().default("UTC"),
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().min(1),
  FIREBASE_WEB_API_KEY: z.string().min(1).optional(),
  CLOUDFLARE_R2_ENDPOINT: z.string().url().optional(),
  CLOUDFLARE_R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  CLOUDFLARE_R2_BUCKET: z.string().min(1).optional(),
  CLOUDFLARE_R2_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().optional()
}).superRefine((env, ctx) => {
  if (env.LLM_PROVIDER === "gemini" && !env.GEMINI_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["GEMINI_API_KEY"],
      message: "GEMINI_API_KEY is required when LLM_PROVIDER=gemini"
    });
  }

  if (env.LLM_PROVIDER === "openrouter" && !env.OPENROUTER_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["OPENROUTER_API_KEY"],
      message: "OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter"
    });
  }
});

export type AppConfig = z.infer<typeof envSchema>;

type EnvSource = Record<string, unknown>;

export function loadConfig(runtimeEnv?: EnvSource): AppConfig {
  const mergedEnv = {
    ...process.env,
    ...(runtimeEnv ?? {})
  };

  const parsed = envSchema.safeParse(mergedEnv);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${errors}`);
  }

  return parsed.data;
}
