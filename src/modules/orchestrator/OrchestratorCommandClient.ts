import type { MusicPanelDisplay } from "../music/types";
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

  public async refreshRegisteredMusicPanel(_guildId: string, _status?: string): Promise<boolean> {
    return true;
  }

  public async registerMusicPanelMessage(
    _guildId: string,
    _channelId: string,
    _messageId: string
  ): Promise<void> {}

  public async getRegisteredMusicPanel(
    _guildId: string
  ): Promise<{ channelId: string; messageId: string } | null> {
    return null;
  }

  public async clearRegisteredMusicPanel(_guildId: string): Promise<boolean> {
    return false;
  }

  public async getPanelDisplayOrFallback(
    _guildId: string,
    _requestedById?: string
  ): Promise<MusicPanelDisplay> {
    throw new Error("Le panneau musique est desactive en mode orchestrateur multi-jukebox.");
  }
}

