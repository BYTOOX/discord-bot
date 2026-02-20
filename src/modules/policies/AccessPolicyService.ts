import { PermissionFlagsBits, type GuildMember } from "discord.js";

import type { AppConfig } from "../../config/env";

export class AccessPolicyService {
  public constructor(private readonly config: AppConfig) {}

  public canManagePlayback(member: GuildMember): boolean {
    if (
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageGuild)
    ) {
      return true;
    }

    if (this.config.djRoleIds.length === 0) {
      return true;
    }

    return this.config.djRoleIds.some((roleId) => member.roles.cache.has(roleId));
  }
}

