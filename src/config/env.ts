import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ override: true });

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
  OCR_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.45),
  DEFAULT_TIMEZONE: z.string().default("UTC"),
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().min(1),
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

export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${errors}`);
  }

  return parsed.data;
}
