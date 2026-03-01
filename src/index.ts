import { commands, orchestratorCommands } from "./commands";
import { loadConfig, type AppConfig } from "./config/env";
import { QuantumClient } from "./core/QuantumClient";
import { createLogger } from "./logger";
import { ChannelBoundJukeboxCoordinator } from "./modules/orchestrator/ChannelBoundJukeboxCoordinator";
import { OrchestratorCommandClient } from "./modules/orchestrator/OrchestratorCommandClient";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  if (config.jukeboxTokens.length === 0) {
    const client = new QuantumClient(config, logger);
    client.registerCommands(commands);
    await client.start();
    return;
  }

  const orchestrator = new QuantumClient(config, logger.child({ role: "orchestrator" }), {
    role: "orchestrator",
    enablePanelSystem: false,
    enablePlaybackRuntime: false
  });
  orchestrator.registerCommands(orchestratorCommands);

  const jukeboxClients = config.jukeboxTokens.map((token, index) => {
    const jukeboxConfig: AppConfig = {
      ...config,
      discordToken: token,
      discordClientId: `${config.discordClientId}-jukebox-${index + 1}`
    };

    return new QuantumClient(jukeboxConfig, logger.child({ role: "jukebox", slot: index + 1 }), {
      role: "jukebox",
      enableInteractions: false,
      enableCommandPublishing: false,
      enablePanelSystem: false
    });
  });

  const coordinator = new ChannelBoundJukeboxCoordinator(
    orchestrator,
    jukeboxClients,
    config.jukeboxFixedNames,
    logger.child({ scope: "coordinator" })
  );
  coordinator.initialize();
  orchestrator.musicControlSurface.attachCoordinator(coordinator);

  const commandClient = new OrchestratorCommandClient(orchestrator, coordinator);
  orchestrator.setCommandExecutionClient(commandClient as unknown as QuantumClient);

  await Promise.all(jukeboxClients.map((client) => client.start()));
  await orchestrator.start();

  logger.info(
    { jukeboxCount: jukeboxClients.length },
    "Mode orchestrateur actif: routing channel-bound vers pool jukebox"
  );
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Erreur fatale au demarrage", error);
  process.exit(1);
});
