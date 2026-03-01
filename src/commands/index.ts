import type { SlashCommand } from "../core/types";
import { autoplayCommand } from "./autoplay";
import { filterCommand } from "./filter";
import { leaveCommand } from "./leave";
import { mode247Command } from "./mode247";
import { nowPlayingCommand } from "./nowplaying";
import { pauseCommand } from "./pause";
import { panelCommand } from "./panel";
import { pingCommand } from "./ping";
import { playCommand } from "./play";
import { playlistCommand } from "./playlist";
import { queueCommand } from "./queue";
import { resumeCommand } from "./resume";
import { skipCommand } from "./skip";
import { stopCommand } from "./stop";
import { volumeCommand } from "./volume";

export const commands: SlashCommand[] = [
  pingCommand,
  playCommand,
  queueCommand,
  nowPlayingCommand,
  skipCommand,
  stopCommand,
  pauseCommand,
  panelCommand,
  resumeCommand,
  leaveCommand,
  volumeCommand,
  autoplayCommand,
  mode247Command,
  filterCommand,
  playlistCommand
];

export const orchestratorCommands: SlashCommand[] = commands;
