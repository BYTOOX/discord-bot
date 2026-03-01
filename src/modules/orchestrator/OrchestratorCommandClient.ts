import type { QuantumClient } from "../../core/QuantumClient";
import type { ChannelBoundJukeboxCoordinator } from "./ChannelBoundJukeboxCoordinator";

export class OrchestratorCommandClient {
  public constructor(
    private readonly orchestrator: QuantumClient,
    private readonly coordinator: ChannelBoundJukeboxCoordinator
  ) {}

  public get config() {
    return this.orchestrator.config;
  }

  public get logger() {
    return this.orchestrator.logger;
  }

  public get channels() {
    return this.orchestrator.channels;
  }

  public get accessPolicy() {
    return this.orchestrator.accessPolicy;
  }

  public get playlistService() {
    return this.orchestrator.playlistService;
  }

  public get musicService() {
    return this.coordinator;
  }

  public async refreshRegisteredMusicPanel(guildId: string, status?: string): Promise<boolean> {
    return this.orchestrator.refreshRegisteredMusicPanel(guildId, status);
  }

  public async forceRebuildMusicControlSurface(guildId: string): Promise<boolean> {
    return this.orchestrator.forceRebuildMusicControlSurface(guildId);
  }

  public async cleanMusicControlSurface(guildId: string): Promise<boolean> {
    return this.orchestrator.cleanMusicControlSurface(guildId);
  }
}
