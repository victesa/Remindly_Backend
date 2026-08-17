import type { AppConfig } from "../../config/env.js";
import type { GeminiAi } from "../../ports/gemini-ai.js";
import { FailoverGeminiClient } from "./failover-gemini-client.js";
import { GeminiHttpClient } from "./gemini-http-client.js";
import { OpenRouterClient } from "./openrouter-client.js";

export function buildGeminiAi(config: AppConfig): GeminiAi {
  const gemini = config.GEMINI_API_KEY ? new GeminiHttpClient(config) : null;
  const openrouter = config.OPENROUTER_API_KEY ? new OpenRouterClient(config) : null;

  const primaryProvider = config.LLM_PROVIDER;
  const primary = primaryProvider === "openrouter" ? openrouter : gemini;

  if (!primary) {
    throw new Error(`Primary LLM provider ${primaryProvider} is not configured`);
  }

  if (!config.LLM_ENABLE_PROVIDER_FAILOVER) {
    return primary;
  }

  const fallbackProvider = primaryProvider === "openrouter" ? "gemini" : "openrouter";
  const fallback = fallbackProvider === "openrouter" ? openrouter : gemini;
  if (!fallback) {
    return primary;
  }

  return new FailoverGeminiClient(primary, fallback, primaryProvider, fallbackProvider);
}
