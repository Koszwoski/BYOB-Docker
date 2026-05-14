// Bot main process.
//
// This process is intentionally tiny: it loads .env, opens state.json,
// starts the Discord client, and waits. Heavy modules are lazy-imported
// on demand:
//   - prismarine-auth  -> first .auth command
//   - mineflayer       -> first .connect command
//   - addons           -> first .enable command for that addon
//
// The web dashboard is NOT part of this process. It used to live here,
// but website code (Next.js, the HTTP API, WebSocket events) has been
// removed from the runtime path. When/if the dashboard is needed it
// will run as its own separate process that reads the same state.json.

import fs from "node:fs";
import path from "node:path";

import {
  addBot,
  addCommandAllowlistUser,
  bots,
  findOrCreateServerByHost,
  flushStateSync,
  getBot,
  getBotAddons,
  getDiscordEntry,
  getDiscordLink,
  getProfilesDir,
  getServer,
  removeCommandAllowlistUser,
  removeDiscordLink,
  setBotAddon,
  setBotStatus,
  setCommandAllowlistEnabled,
  setDiscordLink,
  setDiscordServer,
  getDiscordServerId,
  updateBot,
  initNumberedBots,
} from "./data.mjs";
import { listAddonsWithMeta } from "./addons/index.mjs";
import { startDiscordControl } from "./plugins/discord-control.mjs";
import {
  disableBotAddon,
  enableBotAddon,
  getBotRuntimeInfo,
  isBotRunning,
  runAddonCommand,
  startBotRuntime,
  stopAllBotRuntimes,
  stopBotRuntime,
} from "./plugins/mineflayer-runtime.mjs";

function runtimeUpdate(update) {
  // Persist the latest known position/status. No broadcast - nothing
  // is listening because there is no HTTP server in this process.
  const bot = getBot(update.id);
  if (!bot) return null;
  updateBot(update.id, {
    status: update.status ?? bot.status,
    ping: update.ping ?? bot.ping,
    x: update.x ?? bot.x,
    y: update.y ?? bot.y,
    z: update.z ?? bot.z,
    lastCallback: new Date().toISOString(),
  });
  return getBot(update.id);
}

async function runBotAction(id, action, options = {}) {
  const bot = getBot(id);
  if (!bot) return { error: "not_found" };

  if (action === "stop") {
    stopBotRuntime(id);
    updateBot(id, { shouldRun: false });
    const stoppedBot = setBotStatus(id, "offline");
    return { bot: stoppedBot, runtime: "stopped" };
  }

  if (action === "reconnect") {
    stopBotRuntime(id);
  }

  // Microsoft auth caches tokens by username; our convention is
  // username === bot.id (same key .auth uses). Older bots may have
  // a different username - fix here so every code path (manual
  // connect + auto-resume) hits the right cache.
  if (bot.auth === "microsoft" && bot.username !== bot.id) {
    updateBot(id, { username: bot.id });
  }

  updateBot(id, { shouldRun: true });
  const connectingBot = setBotStatus(id, "connecting");

  const result = await startBotRuntime({
    botConfig: connectingBot,
    serverConfig: getServer(connectingBot.serverId),
    onUpdate: runtimeUpdate,
    onDeviceCode: options.onDeviceCode,
  });

  if (!result.ok) {
    const offlineBot = setBotStatus(id, "offline");
    return { error: result.error, bot: offlineBot };
  }

  return { bot: connectingBot, runtime: result.alreadyRunning ? "already_running" : "starting" };
}

async function resumePersistedBots() {
  const toResume = bots.filter((bot) => bot.shouldRun);
  if (toResume.length === 0) return;
  console.log(`[resume] starting ${toResume.length} persisted bot(s)`);
  for (const bot of toResume) {
    const result = await runBotAction(bot.id, "start");
    if (result.error) {
      console.warn(`[resume] ${bot.id} failed: ${result.error}`);
    } else {
      console.log(`[resume] ${bot.id} -> ${bot.serverId}`);
    }
  }
}

// Cache the Authflow constructor so we only pay the prismarine-auth
// import cost the first time someone runs .auth. Subsequent calls
// reuse the cached reference.
let cachedAuthflow = null;
let cachedTitles = null;
async function loadAuthflow() {
  if (cachedAuthflow) return { Authflow: cachedAuthflow, Titles: cachedTitles };
  const mod = await import("prismarine-auth");
  cachedAuthflow = mod.default?.Authflow ?? mod.Authflow;
  cachedTitles = mod.default?.Titles ?? mod.Titles;
  return { Authflow: cachedAuthflow, Titles: cachedTitles };
}

async function authDiscordUser({ discordUserId, onCode }) {
  if (!discordUserId) return { ok: false, error: "missing_discord_user" };

  const profilesFolder = path.join(getProfilesDir(), discordUserId);
  fs.mkdirSync(profilesFolder, { recursive: true });

  const cacheId = `dc-${discordUserId}`;
  let codeFired = false;
  try {
    const { Authflow, Titles } = await loadAuthflow();
    const flow = new Authflow(
      cacheId,
      profilesFolder,
      {
        flow: "live",
        authTitle: Titles.MinecraftNintendoSwitch,
        deviceType: "Nintendo",
      },
      (code) => {
        codeFired = true;
        try { onCode?.(code); } catch (err) { console.error("[auth] onCode failed", err); }
      },
    );
    const token = await flow.getMinecraftJavaToken({ fetchProfile: true });
    return {
      ok: true,
      cached: !codeFired,
      profile: token.profile,
      profilesFolder,
    };
  } catch (error) {
    return { ok: false, error: error.message || "auth_failed" };
  }
}

function setDiscordUserServer({ discordUserId, host, port }) {
  if (!discordUserId) return { ok: false, error: "missing_discord_user" };
  const serverResult = findOrCreateServerByHost(host, port);
  if (serverResult.error) return { ok: false, error: serverResult.error };
  const server = serverResult.server;

  setDiscordServer(discordUserId, server.id);

  const bot = getDiscordLink(discordUserId);
  if (bot) updateBot(bot.id, { serverId: server.id });

  return { ok: true, server };
}

async function connectDiscordUser({ discordUserId, discordUsername }) {
  if (!discordUserId) return { ok: false, error: "missing_discord_user" };

  const serverId = getDiscordServerId(discordUserId);
  if (!serverId) return { ok: false, error: "no_server_set" };
  const server = getServer(serverId);
  if (!server) return { ok: false, error: "server_not_found" };

  const profilesFolder = path.join(getProfilesDir(), discordUserId);
  if (!fs.existsSync(profilesFolder)) {
    return { ok: false, error: "not_authenticated" };
  }

  const entry = getDiscordEntry(discordUserId);
  let botId = entry?.botId && getBot(entry.botId) ? entry.botId : null;
  if (!botId) botId = `dc-${discordUserId}`;

  let bot = getBot(botId);
  if (!bot) {
    if (botId !== `dc-${discordUserId}`) {
      return { ok: false, error: "bot_not_found" };
    }
    const created = addBot({
      id: botId,
      name: discordUsername || botId,
      username: botId,
      auth: "microsoft",
      serverId,
      profilesFolder,
      discordUserId,
    });
    if (created.error) return { ok: false, error: created.error };
    bot = created.bot;
  } else {
    bot = updateBot(botId, {
      auth: "microsoft",
      serverId,
      profilesFolder,
      username: botId.startsWith("dc-") ? botId : (bot.username || botId),
      discordUserId,
    });
  }

  setDiscordLink(discordUserId, botId);

  const result = await runBotAction(botId, "start");
  if (result.error) return { ok: false, error: result.error, bot };
  return { ok: true, bot: result.bot, server };
}

async function disconnectDiscordUser(discordUserId) {
  const bot = getDiscordLink(discordUserId);
  if (!bot) return { ok: false, error: "no_linked_account" };
  const result = await runBotAction(bot.id, "stop");
  return { ok: true, bot: result.bot };
}

function getDiscordUserStatus(discordUserId) {
  const bot = getDiscordLink(discordUserId);
  if (!bot) return { ok: false, error: "no_linked_account" };
  const server = bot.serverId ? getServer(bot.serverId) : null;
  const runtime = getBotRuntimeInfo(bot.id);
  return { ok: true, bot, server, runtime };
}

async function listDiscordUserAddons(discordUserId) {
  const available = await listAddonsWithMeta();
  const bot = getDiscordLink(discordUserId);
  const botAddons = bot ? getBotAddons(bot.id) ?? {} : {};
  const runtime = bot ? getBotRuntimeInfo(bot.id) : null;
  const activeNow = new Set(runtime?.activeAddons ?? []);
  return {
    ok: true,
    bot,
    addons: available.map((addon) => ({
      ...addon,
      enabled: Boolean(botAddons[addon.name]?.enabled),
      active: activeNow.has(addon.name),
      config: { ...(addon.defaultConfig ?? {}), ...(botAddons[addon.name]?.config ?? {}) },
    })),
  };
}

async function enableDiscordUserAddon(discordUserId, name) {
  const bot = getDiscordLink(discordUserId);
  if (!bot) return { ok: false, error: "no_linked_account" };
  setBotAddon(bot.id, name, { enabled: true });
  if (isBotRunning(bot.id)) {
    const state = (getBotAddons(bot.id) ?? {})[name] ?? {};
    const result = await enableBotAddon(bot.id, name, state.config);
    if (!result.ok) return { ok: false, error: result.error, hotApplied: false };
    return { ok: true, hotApplied: true };
  }
  return { ok: true, hotApplied: false };
}

function disableDiscordUserAddon(discordUserId, name) {
  const bot = getDiscordLink(discordUserId);
  if (!bot) return { ok: false, error: "no_linked_account" };
  setBotAddon(bot.id, name, { enabled: false });
  if (isBotRunning(bot.id)) {
    disableBotAddon(bot.id, name);
    return { ok: true, hotApplied: true };
  }
  return { ok: true, hotApplied: false };
}

async function runDiscordUserAddonCommand(discordUserId, addonName, sub, args) {
  const bot = getDiscordLink(discordUserId);
  if (!bot) return { ok: false, error: "no_linked_account" };
  return runAddonCommand(bot.id, addonName, sub, args);
}

function getBotCount() {
  return parseInt(process.env.BOT_COUNT ?? "0", 10);
}

async function runBotActionById(botId, action) {
  return runBotAction(botId, action);
}

function getStatusById(botId) {
  const bot = getBot(botId);
  if (!bot) return { ok: false, error: "bot_not_found" };
  const server = bot.serverId ? getServer(bot.serverId) : null;
  const runtime = getBotRuntimeInfo(botId);
  return { ok: true, bot, server, runtime };
}

function setServerById(botId, host, port) {
  const serverResult = findOrCreateServerByHost(host, port);
  if (serverResult.error) return;
  updateBot(botId, { serverId: serverResult.server.id });
}

async function enableAddonById(botId, name) {
  setBotAddon(botId, name, { enabled: true });
  if (isBotRunning(botId)) {
    const state = (getBotAddons(botId) ?? {})[name] ?? {};
    const result = await enableBotAddon(botId, name, state.config);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, hotApplied: true };
  }
  return { ok: true, hotApplied: false };
}

function disableAddonById(botId, name) {
  setBotAddon(botId, name, { enabled: false });
  if (isBotRunning(botId)) {
    disableBotAddon(botId, name);
    return { ok: true, hotApplied: true };
  }
  return { ok: true, hotApplied: false };
}

async function runAddonCommandById(botId, addonName, sub, args) {
  return runAddonCommand(botId, addonName, sub, args);
}

async function authBotById(botId, onCode) {
  const profilesFolder = path.join(getProfilesDir(), botId);
  fs.mkdirSync(profilesFolder, { recursive: true });
  updateBot(botId, { profilesFolder });
  let codeFired = false;
  try {
    const { Authflow, Titles } = await loadAuthflow();
    const flow = new Authflow(
      botId,
      profilesFolder,
      { flow: "live", authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo" },
      (code) => { codeFired = true; try { onCode?.(code); } catch (e) { console.error("[auth] onCode failed", e); } },
    );
    const token = await flow.getMinecraftJavaToken({ fetchProfile: true });
    return { ok: true, cached: !codeFired, profile: token.profile };
  } catch (error) {
    return { ok: false, error: error.message || "auth_failed" };
  }
}

process.on("SIGINT", () => { stopAllBotRuntimes(); flushStateSync(); process.exit(0); });
process.on("SIGTERM", () => { stopAllBotRuntimes(); flushStateSync(); process.exit(0); });

const memMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
console.log(`Minecraft Bot starting (idle RSS: ${memMb} MB)`);

resumePersistedBots().catch((err) => console.error("[resume] failed", err));

const botCount = parseInt(process.env.BOT_COUNT ?? "0", 10);
if (botCount > 0) {
  initNumberedBots(botCount);
  console.log(`[init] ${botCount} numbered bot(s) ready`);
}

if (process.env.DISCORD_ENABLED === "true") {
  startDiscordControl({
    authDiscordUser,
    setDiscordUserServer,
    connectDiscordUser,
    disconnectDiscordUser,
    getDiscordUserStatus,
    listDiscordUserAddons,
    enableDiscordUserAddon,
    disableDiscordUserAddon,
    runDiscordUserAddonCommand,
    runBotActionById,
    getStatusById,
    setServerById,
    enableAddonById,
    disableAddonById,
    runAddonCommandById,
    authBotById,
    getBotCount,
  }).catch((error) => {
    console.error("[discord-control] failed to start", error);
  });
} else {
  console.log("[discord-control] disabled (set DISCORD_ENABLED=true in .env)");
}
