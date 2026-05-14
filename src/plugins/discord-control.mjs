import { Client, EmbedBuilder, GatewayIntentBits } from "discord.js";
import {
  addCommandAllowlistUser,
  bots,
  getBot,
  getCommandAllowlist,
  removeCommandAllowlistUser,
  removeDiscordLink,
  setCommandAllowlistEnabled,
  setDiscordLink,
  setDiscordServer,
  updateBot,
} from "../data.mjs";

const PREFIX = ".";

function parseSuperuserIds() {
  return (process.env.DISCORD_SUPERUSER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((id) => /^\d{10,25}$/.test(id));
}

function isSuperuser(userId) {
  return parseSuperuserIds().includes(String(userId));
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  if (m || h || d) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function statusColor(status) {
  if (status === "online") return 0x57f287;
  if (status === "connecting") return 0xfee75c;
  return 0xed4245;
}

function statusEmoji(status) {
  if (status === "online") return "🟢";
  if (status === "connecting") return "🟡";
  return "🔴";
}

function hasRoleAdmin(message, adminRoleId) {
  if (!adminRoleId) return false;
  return message.member?.roles?.cache?.has(String(adminRoleId)) ?? false;
}

/** Legacy gate: when allowlist is off, empty admin role = everyone in channel. */
function hasPermission(message, adminRoleId) {
  if (!adminRoleId) return true;
  return hasRoleAdmin(message, adminRoleId);
}

function isGuildOwner(message) {
  return Boolean(message.guild?.ownerId && message.author.id === message.guild.ownerId);
}

function hasManagementPermission(message, adminRoleId) {
  if (isSuperuser(message.author.id)) return true;
  if (isGuildOwner(message)) return true;
  return hasRoleAdmin(message, adminRoleId);
}

function canRunUserCommands(message, adminRoleId) {
  const cl = getCommandAllowlist();
  if (!cl.enabled) return hasPermission(message, adminRoleId);
  if (hasManagementPermission(message, adminRoleId)) return true;
  return cl.users.includes(String(message.author.id));
}

function helpText() {
  return [
    "**Build-Your-Own-Bot**",
    "`.auth` — Microsoft login",
    "`.server <ip> [port]` — set server",
    "`.connect` (or `.c`) — connect bot",
    "`.disconnect` (or `.dc`) — disconnect, will not auto-reconnect",
    "`.status` (or `.s`) — show bot status",
    "",
    "**Addons**",
    "`.addons` (or `.a`) — list available addons",
    "`.enable <name>` (or `.e`) — turn on an addon",
    "`.disable <name>` (or `.d`) — turn off an addon",
    "`.addon <name> <sub> [args]` — run an addon-specific command",
    "",
    "**Access control** (admins / guild owner / `DISCORD_SUPERUSER_IDS`)",
    "`.allowlist on` — only allow-listed users + admins can use commands",
    "`.allowlist off` — disable allowlist (falls back to role gate only)",
    "`.allowlist` — show allowlist status",
    "`.bind @user` — add a Discord user to the allow list",
    "`.bind @user <botId>` — allow list + link them to an existing bot row",
    "`.unbind @user` — remove from allow list and clear their Discord link",
    "",
    "`.help` — this list",
  ].join("\n");
}

function buildStatusEmbed({ bot, server, runtime }) {
  const now = Date.now();
  const status = bot.status || "offline";
  const embed = new EmbedBuilder()
    .setColor(statusColor(status))
    .setTitle(`${statusEmoji(status)} ${runtime?.mcUsername || bot.name}`)
    .setTimestamp(new Date());

  const fields = [];
  fields.push({ name: "Status", value: status, inline: true });

  if (server) {
    fields.push({
      name: "Server",
      value: `\`${server.host}:${server.port}\``,
      inline: true,
    });
  }

  if (runtime?.connectedAt) {
    fields.push({
      name: "Uptime",
      value: formatDuration(now - runtime.connectedAt),
      inline: true,
    });
  }

  if (runtime?.spawnedAt) {
    fields.push({
      name: "Online Duration",
      value: formatDuration(now - runtime.spawnedAt),
      inline: true,
    });
  } else if (runtime) {
    fields.push({ name: "Online Duration", value: "Not Online!", inline: true });
  }

  if (runtime?.health !== null && runtime?.health !== undefined) {
    fields.push({
      name: "Health",
      value: `${runtime.health.toFixed(1)} / 20`,
      inline: true,
    });
  }

  if (runtime?.food !== null && runtime?.food !== undefined) {
    fields.push({
      name: "Hunger",
      value: `${runtime.food} / 20`,
      inline: true,
    });
  }

  if (runtime?.dimension) {
    fields.push({
      name: "Dimension",
      value: runtime.dimension.replace(/^minecraft:/, ""),
      inline: true,
    });
  }

  if (runtime?.ping !== null && runtime?.ping !== undefined) {
    fields.push({ name: "Ping", value: `${runtime.ping}ms`, inline: true });
  }

  if (runtime?.playerCount !== undefined && runtime.playerCount !== null) {
    fields.push({
      name: "Players Online",
      value: String(runtime.playerCount),
      inline: true,
    });
  }

  if (runtime?.position) {
    fields.push({
      name: "Coordinates",
      value: `x: ${runtime.position.x}  y: ${runtime.position.y}  z: ${runtime.position.z}`,
      inline: false,
    });
  } else if (bot.x !== undefined) {
    fields.push({
      name: "Coordinates",
      value: `x: ${bot.x}  y: ${bot.y}  z: ${bot.z}`,
      inline: false,
    });
  }

  embed.addFields(fields);

  if (runtime?.serverBrand) {
    embed.setFooter({ text: `Server brand: ${runtime.serverBrand}` });
  }

  return embed;
}

function buildAddonsEmbed({ bot, addons }) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Bot Addons")
    .setTimestamp(new Date());

  if (bot) {
    embed.setDescription(`For \`${bot.name}\` — use \`.enable <name>\` / \`.disable <name>\``);
  } else {
    embed.setDescription("No bot linked yet.");
  }

  if (!addons?.length) {
    embed.addFields({ name: "(empty)", value: "No addons registered in this build.", inline: false });
    return embed;
  }

  for (const addon of addons) {
    const state = addon.active ? "🟢 active"
      : addon.enabled ? "🟡 enabled (not loaded)"
      : "⚪ off";
    embed.addFields({
      name: `${addon.name} — ${state}`,
      value: addon.description || "(no description)",
      inline: false,
    });
  }
  return embed;
}

async function postDeviceCode(message, code) {
  const url = code.verification_uri || "https://www.microsoft.com/link";
  const userCode = code.user_code;
  await message.channel.send([
    "**Microsoft Device Code Login**",
    `Login Here: ${url}${url.includes("?") ? "&" : "?"}otc=${userCode}`,
    `Code: \`${userCode}\``,
  ].join("\n"));
}

function resolveTargetUserId(message, arg0) {
  const mention = message.mentions.users.first();
  if (mention) return mention.id;
  if (arg0 && /^\d{10,25}$/.test(arg0)) return arg0;
  return null;
}

function pickOptionalBotId(args, targetId) {
  for (const a of args) {
    const mid = a.match(/^<@!?(\d+)>$/);
    if (mid) continue;
    if (a === targetId) continue;
    if (/^[a-z0-9-]+$/i.test(a)) return a;
  }
  return null;
}

function bindUserToBot(targetUserId, botIdOptional) {
  const add = addCommandAllowlistUser(targetUserId);
  if (!add.ok) return add;
  if (!botIdOptional) return { ok: true, mode: "allowlist_only" };

  const bot = getBot(botIdOptional);
  if (!bot) return { ok: false, error: "bot_not_found" };
  if (bot.discordUserId && String(bot.discordUserId) !== String(targetUserId)) {
    return { ok: false, error: "bot_claimed_by_other_discord" };
  }

  setDiscordLink(targetUserId, botIdOptional);
  if (bot.serverId) setDiscordServer(targetUserId, bot.serverId);
  updateBot(botIdOptional, { discordUserId: String(targetUserId) });
  return { ok: true, mode: "bound_bot", botId: botIdOptional };
}

function unbindUser(targetUserId) {
  removeCommandAllowlistUser(targetUserId);
  removeDiscordLink(targetUserId);
  for (const b of bots) {
    if (String(b.discordUserId) === String(targetUserId)) {
      updateBot(b.id, { discordUserId: null });
    }
  }
  return { ok: true };
}

export async function startDiscordControl({
  authDiscordUser,
  setDiscordUserServer,
  connectDiscordUser,
  disconnectDiscordUser,
  getDiscordUserStatus,
  listDiscordUserAddons,
  enableDiscordUserAddon,
  disableDiscordUserAddon,
  runDiscordUserAddonCommand,
  logger = console,
}) {
  const token = process.env.DISCORD_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID;

  if (!token || !channelId) {
    logger.log("[discord-control] disabled: DISCORD_TOKEN or DISCORD_CHANNEL_ID missing");
    return null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once("clientReady", () => {
    logger.log(`[discord-control] logged in as ${client.user?.tag}`);
  });

  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (String(message.channelId) !== String(channelId)) return;
    if (!message.content.startsWith(PREFIX)) return;

    const [commandRaw, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = commandRaw?.toLowerCase();
    if (!command) return;

    const cl = getCommandAllowlist();

    if (command === "help") {
      if (cl.enabled && !canRunUserCommands(message, adminRoleId)) {
        await message.reply(
          "This bot uses an **allow list**. Ask an admin to `.bind` you. "
          + "Admins: set `DISCORD_ADMIN_ROLE_ID`, use the server owner account, or list yourself in `DISCORD_SUPERUSER_IDS` in `.env`.",
        );
        return;
      }
      await message.reply(helpText());
      return;
    }

    if (cl.enabled && !canRunUserCommands(message, adminRoleId)) {
      return;
    }

    if (!cl.enabled && !hasPermission(message, adminRoleId)) {
      await message.reply("You do not have permission to manage bots.");
      return;
    }

    const discordUserId = message.author.id;
    const discordUsername = message.author.username;

    try {
      if (command === "allowlist") {
        const sub = (args[0] ?? "").toLowerCase();
        if (!hasManagementPermission(message, adminRoleId)) {
          await message.reply("Only a server admin (role, owner, or superuser) can manage the allow list.");
          return;
        }
        if (!adminRoleId && !isGuildOwner(message) && !isSuperuser(message.author.id)) {
          await message.reply(
            "Set `DISCORD_ADMIN_ROLE_ID` in `.env`, or add your user ID to `DISCORD_SUPERUSER_IDS`, "
            + "otherwise only the **guild owner** can use `.allowlist` / `.bind`.",
          );
          return;
        }
        if (sub === "on") {
          setCommandAllowlistEnabled(true);
          addCommandAllowlistUser(message.author.id);
          await message.reply("Allow list **on**. You were added automatically. Use `.bind @user` to add others.");
          return;
        }
        if (sub === "off") {
          setCommandAllowlistEnabled(false);
          await message.reply("Allow list **off**. Commands fall back to the normal role gate (`DISCORD_ADMIN_ROLE_ID`).");
          return;
        }
        const snap = getCommandAllowlist();
        const preview = snap.users.slice(0, 15).map((id) => `\`${id}\``).join(", ") || "(none)";
        const more = snap.users.length > 15 ? ` … +${snap.users.length - 15} more` : "";
        await message.reply(
          `Allow list: **${snap.enabled ? "ON" : "OFF"}** — ${snap.users.length} user(s)\n${preview}${more}`,
        );
        return;
      }

      if (command === "bind") {
        if (!hasManagementPermission(message, adminRoleId)) {
          await message.reply("Only a server admin (role, owner, or superuser) can `.bind` users.");
          return;
        }
        if (!adminRoleId && !isGuildOwner(message) && !isSuperuser(message.author.id)) {
          await message.reply("Configure `DISCORD_ADMIN_ROLE_ID` or `DISCORD_SUPERUSER_IDS` (or use the guild owner account) before using `.bind`.");
          return;
        }
        const target = resolveTargetUserId(message, args[0]);
        if (!target) {
          await message.reply("Usage: `.bind @user` or `.bind @user <botId>` (mention or numeric user id).");
          return;
        }
        const botIdOpt = pickOptionalBotId(args, target);
        const result = bindUserToBot(target, botIdOpt);
        if (!result.ok) {
          await message.reply(`Bind failed: ${result.error}`);
          return;
        }
        if (result.mode === "allowlist_only") {
          await message.reply(`User <@${target}> added to the allow list.`);
        } else {
          await message.reply(`User <@${target}> added to the allow list and linked to bot \`${result.botId}\`.`);
        }
        return;
      }

      if (command === "unbind") {
        if (!hasManagementPermission(message, adminRoleId)) {
          await message.reply("Only a server admin (role, owner, or superuser) can `.unbind` users.");
          return;
        }
        if (!adminRoleId && !isGuildOwner(message) && !isSuperuser(message.author.id)) {
          await message.reply("Configure `DISCORD_ADMIN_ROLE_ID` or `DISCORD_SUPERUSER_IDS` first.");
          return;
        }
        const target = resolveTargetUserId(message, args[0]);
        if (!target) {
          await message.reply("Usage: `.unbind @user`");
          return;
        }
        unbindUser(target);
        await message.reply(`User <@${target}> removed from the allow list and their Discord link cleared.`);
        return;
      }

      if (command === "auth") {
        await message.reply("Starting Microsoft login...");
        const result = await authDiscordUser({
          discordUserId,
          onCode: (code) => postDeviceCode(message, code),
        });
        if (!result.ok) {
          await message.reply(`Auth failed: ${result.error}`);
          return;
        }
        if (result.cached) {
          await message.reply(`Already linked as **${result.profile.name}**. Use \`.server <ip>\` then \`.connect\`.`);
        } else {
          await message.reply(`Linked as **${result.profile.name}**. Use \`.server <ip>\` then \`.connect\`.`);
        }
        return;
      }

      if (command === "server") {
        const [host, portRaw] = args;
        if (!host) {
          await message.reply("Usage: `.server <ip> [port]`");
          return;
        }
        const port = portRaw ? Number(portRaw) : 25565;
        if (Number.isNaN(port)) {
          await message.reply("Port must be a number.");
          return;
        }
        const result = setDiscordUserServer({ discordUserId, host, port });
        if (!result.ok) {
          await message.reply(`Failed to set server: ${result.error}`);
          return;
        }
        await message.reply(`Server set to \`${result.server.host}:${result.server.port}\`. Use \`.connect\` to join.`);
        return;
      }

      if (command === "connect" || command === "c") {
        const result = await connectDiscordUser({ discordUserId, discordUsername });
        if (!result.ok) {
          if (result.error === "no_server_set") {
            await message.reply("No server set. Use `.server <ip>` first.");
          } else if (result.error === "not_authenticated") {
            await message.reply("Not logged in. Use `.auth` first.");
          } else if (result.error === "bot_not_found") {
            await message.reply("Linked bot id not found. Ask an admin to `.bind` you to a valid bot id.");
          } else {
            await message.reply(`Connect failed: ${result.error}`);
          }
          return;
        }
        await message.reply(`Connecting \`${result.bot.name}\` to \`${result.server.host}:${result.server.port}\`...`);
        return;
      }

      if (command === "status" || command === "s") {
        const result = getDiscordUserStatus(discordUserId);
        if (!result.ok) {
          await message.reply(result.error === "no_linked_account"
            ? "No bot linked yet. Use `.auth` then `.server <ip>` then `.connect`."
            : `Status failed: ${result.error}`);
          return;
        }
        const embed = buildStatusEmbed(result);
        await message.reply({ embeds: [embed] });
        return;
      }

      if (command === "disconnect" || command === "dc" || command === "stop") {
        const result = await disconnectDiscordUser(discordUserId);
        if (!result.ok) {
          await message.reply(result.error === "no_linked_account"
            ? "Nothing to disconnect."
            : `Disconnect failed: ${result.error}`);
          return;
        }
        await message.reply("Bot disconnected. It will **not** auto-reconnect (use `.connect` to bring it back).");
        return;
      }

      if (command === "addons" || command === "a") {
        if (!listDiscordUserAddons) {
          await message.reply("Addon system not wired up.");
          return;
        }
        const result = await listDiscordUserAddons(discordUserId);
        if (!result.ok) {
          await message.reply(`Failed to list addons: ${result.error}`);
          return;
        }
        await message.reply({ embeds: [buildAddonsEmbed(result)] });
        return;
      }

      if (command === "enable" || command === "e") {
        const [name] = args;
        if (!name) {
          await message.reply("Usage: `.enable <addon>` (see `.addons`)");
          return;
        }
        const result = await enableDiscordUserAddon(discordUserId, name);
        if (!result.ok) {
          await message.reply(result.error === "no_linked_account"
            ? "No bot linked. Use `.auth` then `.server <ip>` then `.connect` first."
            : `Enable failed: ${result.error}`);
          return;
        }
        await message.reply(result.hotApplied
          ? `Addon \`${name}\` enabled and loaded now.`
          : `Addon \`${name}\` enabled. Will activate next time the bot connects.`);
        return;
      }

      if (command === "disable" || command === "d") {
        const [name] = args;
        if (!name) {
          await message.reply("Usage: `.disable <addon>`");
          return;
        }
        const result = disableDiscordUserAddon(discordUserId, name);
        if (!result.ok) {
          await message.reply(result.error === "no_linked_account"
            ? "No bot linked."
            : `Disable failed: ${result.error}`);
          return;
        }
        await message.reply(result.hotApplied
          ? `Addon \`${name}\` unloaded and disabled.`
          : `Addon \`${name}\` disabled.`);
        return;
      }

      if (command === "addon") {
        const [addonName, sub, ...addonArgs] = args;
        if (!addonName || !sub) {
          await message.reply("Usage: `.addon <name> <subcommand> [args...]`");
          return;
        }
        if (!runDiscordUserAddonCommand) {
          await message.reply("Addon command system not wired up.");
          return;
        }
        const result = await runDiscordUserAddonCommand(discordUserId, addonName, sub, addonArgs);
        if (!result.ok) {
          await message.reply(`Addon command failed: ${result.error}`);
          return;
        }
        await message.reply(result.result);
        return;
      }

      await message.reply(helpText());
    } catch (error) {
      logger.error("[discord-control] command error", error);
      await message.reply(`Command failed: ${error.message}`);
    }
  });

  await client.login(token);
  return client;
}
