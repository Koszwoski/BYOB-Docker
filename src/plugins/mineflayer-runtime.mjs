import { instantiateAddon } from "../addons/index.mjs";

// mineflayer is the largest dependency in the bot - it eagerly pulls
// in minecraft-data, prismarine-block, prismarine-chunk and all the
// protocol code (tens of MB). We import it lazily the first time a
// bot actually connects, so the idle bot process never pays that cost.
let mineflayerModule = null;
async function loadMineflayer() {
  if (mineflayerModule) return mineflayerModule;
  const mod = await import("mineflayer");
  mineflayerModule = mod.default ?? mod;
  return mineflayerModule;
}

const runningBots = new Map();

export function getBotRuntimeInfo(botId) {
  const runtime = runningBots.get(botId);
  if (!runtime) return null;
  const mb = runtime.mineflayerBot;
  return {
    connectedAt: runtime.connectedAt ?? null,
    spawnedAt: runtime.spawnedAt ?? null,
    health: typeof mb.health === "number" ? mb.health : null,
    food: typeof mb.food === "number" ? mb.food : null,
    dimension: mb.game?.dimension ?? null,
    gameMode: mb.game?.gameMode ?? null,
    serverBrand: mb.game?.serverBrand ?? null,
    ping: typeof mb.player?.ping === "number" ? mb.player.ping : null,
    playerCount: mb.players ? Object.keys(mb.players).length : 0,
    position: mb.entity?.position
      ? {
          x: Math.round(mb.entity.position.x),
          y: Math.round(mb.entity.position.y),
          z: Math.round(mb.entity.position.z),
        }
      : null,
    mcUsername: mb.username ?? null,
    activeAddons: [...runtime.activeAddons.keys()],
  };
}

function getPosition(botConfig) {
  return {
    x: Number(botConfig.x ?? 0),
    y: Number(botConfig.y ?? 64),
    z: Number(botConfig.z ?? 0),
  };
}

export function isBotRunning(botId) {
  return runningBots.has(botId);
}

async function loadAddonForRuntime(runtime, name, userConfig, onLog) {
  const ctx = { botId: runtime.botId, log: onLog };
  const instance = await instantiateAddon(name, runtime.mineflayerBot, userConfig, ctx);
  runtime.activeAddons.set(name, instance);
  return instance;
}

function unloadAddonFromRuntime(runtime, name, onLog) {
  const instance = runtime.activeAddons.get(name);
  if (!instance) return false;
  try { instance.cleanup?.(); } catch (err) {
    onLog?.(`[mineflayer-runtime] addon cleanup error (${name}): ${err.message}`);
  }
  runtime.activeAddons.delete(name);
  return true;
}

export async function enableBotAddon(botId, name, userConfig, onLog = console.log) {
  const runtime = runningBots.get(botId);
  if (!runtime) return { ok: false, error: "bot_not_running" };
  if (runtime.activeAddons.has(name)) return { ok: true, alreadyActive: true };
  try {
    await loadAddonForRuntime(runtime, name, userConfig, onLog);
    return { ok: true };
  } catch (err) {
    onLog(`[mineflayer-runtime] failed to load addon ${name}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

export function disableBotAddon(botId, name, onLog = console.log) {
  const runtime = runningBots.get(botId);
  if (!runtime) return { ok: false, error: "bot_not_running" };
  const removed = unloadAddonFromRuntime(runtime, name, onLog);
  return { ok: true, wasActive: removed };
}

// startBotRuntime is async because the first invocation lazy-imports
// mineflayer. Subsequent invocations resolve immediately from cache.
export async function startBotRuntime({ botConfig, serverConfig, onUpdate, onDeviceCode, onLog = console.log }) {
  if (runningBots.has(botConfig.id)) {
    return { ok: true, alreadyRunning: true };
  }

  if (!serverConfig) {
    return { ok: false, error: "server_not_found" };
  }

  const username = botConfig.username || botConfig.name || botConfig.id;
  const host = serverConfig.host;
  const port = Number(serverConfig.port ?? 25565);
  const auth = botConfig.auth || "offline";
  const version = serverConfig.version || false;

  onLog(`[mineflayer-runtime] starting ${botConfig.id} (${username}) -> ${host}:${port}`);

  const mineflayer = await loadMineflayer();
  const mineflayerBot = mineflayer.createBot({
    host,
    port,
    username,
    auth,
    version,
    profilesFolder: botConfig.profilesFolder,
    onMsaCode: onDeviceCode,
    // Low-memory mode: chunk data is by far the largest RAM
    // consumer for mineflayer; "tiny" asks the server to send only
    // a 2-chunk radius. Overridable for users who actually need
    // visibility (e.g. pathfinding addon).
    viewDistance: process.env.BOT_VIEW_DISTANCE || "tiny",
    chatLengthLimit: Number(process.env.BOT_CHAT_LIMIT) || 100,
    hideErrors: true,
  });

  const runtime = {
    botId: botConfig.id,
    mineflayerBot,
    callbackTimer: undefined,
    stopping: false,
    connectedAt: Date.now(),
    spawnedAt: null,
    activeAddons: new Map(),
  };

  function emit(status, partial = {}) {
    const position = mineflayerBot.entity?.position ?? getPosition(botConfig);
    onUpdate({
      id: botConfig.id,
      name: mineflayerBot.username || botConfig.name || username,
      username: mineflayerBot.username || username,
      auth,
      serverId: botConfig.serverId,
      status,
      ping: typeof mineflayerBot.player?.ping === "number" ? mineflayerBot.player.ping : null,
      x: Math.round(partial.x ?? position.x),
      y: Math.round(partial.y ?? position.y),
      z: Math.round(partial.z ?? position.z),
    });
  }

  mineflayerBot.once("spawn", async () => {
    runtime.spawnedAt = Date.now();
    onLog(`[mineflayer-runtime] ${botConfig.id} spawned`);
    emit("online");
    runtime.callbackTimer = setInterval(() => emit("online"), Number(botConfig.callbackIntervalMs ?? 10000));

    const addonState = botConfig.addons ?? {};
    for (const [name, state] of Object.entries(addonState)) {
      if (!state?.enabled) continue;
      try {
        await loadAddonForRuntime(runtime, name, state.config, onLog);
        onLog(`[mineflayer-runtime] addon ${name} loaded for ${botConfig.id}`);
      } catch (err) {
        onLog(`[mineflayer-runtime] addon ${name} failed to load: ${err.message}`);
      }
    }
  });

  mineflayerBot.on("kicked", (reason) => {
    onLog(`[mineflayer-runtime] ${botConfig.id} kicked: ${JSON.stringify(reason)}`);
  });

  mineflayerBot.on("error", (error) => {
    onLog(`[mineflayer-runtime] ${botConfig.id} error: ${error.message}`);
  });

  mineflayerBot.on("end", () => {
    onLog(`[mineflayer-runtime] ${botConfig.id} ended`);
    clearInterval(runtime.callbackTimer);
    for (const name of [...runtime.activeAddons.keys()]) {
      unloadAddonFromRuntime(runtime, name, onLog);
    }
    runningBots.delete(botConfig.id);
    emit("offline");
  });

  runningBots.set(botConfig.id, runtime);
  emit("connecting");
  return { ok: true };
}

export function stopBotRuntime(botId) {
  const runtime = runningBots.get(botId);
  if (!runtime) return { ok: true, wasRunning: false };

  runtime.stopping = true;
  clearInterval(runtime.callbackTimer);
  for (const name of [...runtime.activeAddons.keys()]) {
    unloadAddonFromRuntime(runtime, name);
  }
  runningBots.delete(botId);
  runtime.mineflayerBot.quit("Stopped from Minecraft Bot Panel");
  return { ok: true, wasRunning: true };
}

export function stopAllBotRuntimes() {
  for (const botId of [...runningBots.keys()]) {
    stopBotRuntime(botId);
  }
}

export async function runAddonCommand(botId, addonName, sub, args) {
  const runtime = runningBots.get(botId);
  if (!runtime) return { ok: false, error: "bot_not_running" };
  const instance = runtime.activeAddons.get(addonName);
  if (!instance) return { ok: false, error: "addon_not_active" };
  if (typeof instance.command !== "function") return { ok: false, error: "addon_has_no_commands" };
  try {
    const result = await instance.command(sub, args);
    return { ok: true, result: String(result ?? "Done.") };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
