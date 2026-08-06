import { buildApp } from "./app.js";
import { loadConfig } from "./config/env.js";

async function start(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  try {
    app.log.info({ llmProvider: config.LLM_PROVIDER }, "llm.provider.active");
    await app.listen({
      host: config.HOST,
      port: config.PORT
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();
