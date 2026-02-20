import { commands } from "./commands";
import { loadConfig } from "./config/env";
import { QuantumClient } from "./core/QuantumClient";
import { createLogger } from "./logger";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const client = new QuantumClient(config, logger);

  client.registerCommands(commands);
  await client.start();
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error", error);
  process.exit(1);
});

