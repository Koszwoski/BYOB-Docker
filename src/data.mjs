import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const PROFILES_DIR = path.join(DATA_DIR, "profiles");

const defaultState = {
  servers: [],
  bots: [],
  discordLinks: {},
  // When enabled, only users in `users` (+ admins/superusers) may run
  // bot commands. Everyone else is ignored silently (anti-spam).
  commandAllowlist: { enabled: false, users: [] },
};

function ensureStateFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(defaultState, null, 2));
  }
}

function loadState() {
  ensureStateFile();
  const raw = fs.readFileSync(STATE_FILE, "utf8");
  const state = JSON.parse(raw);
  const rawCl = state.commandAllowlist;
  const commandAllowlist = rawCl && typeof rawCl === "object" && Array.isArray(rawCl.users)
    ? { enabled: Boolean(rawCl.enabled), users: rawCl.users.map(String) }
    : { enabled: false, users: [] };

  return {
    servers: Array.isArray(state.servers) ? state.servers : [],
    bots: Array.isArray(state.bots) ? state.bots : [],
    discordLinks: state.discordLinks && typeof state.discordLinks === "object" ? state.discordLinks : {},
    commandAllowlist,
  };
}

// Coalesces writes so a burst of state mutations (e.g. position
// updates from a connected bot) only produces one disk write per
// SAVE_FLUSH_MS. saveState() returns immediately; the actual
// fs.writeFileSync runs on a debounced timer. SIGINT/SIGTERM in
// server.mjs calls flushStateSync() to guarantee no data is lost
// on shutdown.
const SAVE_FLUSH_MS = 2000;
let saveTimer = null;
let saveDirty = false;

function writeStateNow() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ servers, bots, discordLinks, commandAllowlist }, null, 2));
  saveDirty = false;
}

function saveState() {
  saveDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (saveDirty) writeStateNow();
  }, SAVE_FLUSH_MS);
  saveTimer.unref?.();
}

export function flushStateSync() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (saveDirty) writeStateNow();
}

function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const state = loadState();
export const servers = state.servers;
export const bots = state.bots;
export const discordLinks = state.discordLinks;
export const commandAllowlist = state.commandAllowlist;

export function getServer(id) {
  return servers.find((server) => server.id === id);
}

export function findServerByHost(host, port) {
  const p = Number(port || 25565);
  return servers.find((server) => server.host === host && Number(server.port) === p);
}

export function addServer(input) {
  const id = slugify(input.id || input.name || `${input.host}-${input.port || 25565}`);
  if (!id || !input.host) {
    return { error: "missing_required_fields" };
  }
  if (getServer(id)) {
    return { error: "server_exists" };
  }

  const server = {
    id,
    name: String(input.name || input.host).trim(),
    host: String(input.host).trim(),
    port: Number(input.port || 25565),
    version: input.version ? String(input.version).trim() : "",
    mapRadius: Number(input.mapRadius || 1200),
  };

  servers.push(server);
  saveState();
  return { server };
}

export function findOrCreateServerByHost(host, port) {
  const existing = findServerByHost(host, port);
  if (existing) return { server: existing };
  return addServer({ host, port });
}

export function getBot(id) {
  return bots.find((bot) => bot.id === id);
}

export function addBot(input) {
  const id = slugify(input.id || input.name);
  if (!id || !input.name || !input.serverId) {
    return { error: "missing_required_fields" };
  }
  if (!getServer(input.serverId)) {
    return { error: "server_not_found" };
  }
  if (getBot(id)) {
    return { error: "bot_exists" };
  }

  const bot = {
    id,
    name: String(input.name).trim(),
    username: String(input.username || input.name).trim(),
    auth: String(input.auth || "offline"),
    status: "offline",
    ping: null,
    serverId: input.serverId,
    profilesFolder: input.profilesFolder || null,
    discordUserId: input.discordUserId || null,
    shouldRun: Boolean(input.shouldRun),
    x: Number(input.x ?? 0),
    y: Number(input.y ?? 64),
    z: Number(input.z ?? 0),
    lastCallback: null,
  };

  bots.push(bot);
  saveState();
  return { bot };
}

export function updateBot(id, patch) {
  const bot = getBot(id);
  if (!bot) return null;
  Object.assign(bot, patch);
  saveState();
  return bot;
}

export function setBotStatus(id, status) {
  const bot = getBot(id);
  if (!bot) return null;
  bot.status = status;
  bot.ping = status === "online" ? bot.ping ?? 42 : null;
  bot.lastCallback = status === "offline" ? null : new Date().toISOString();
  saveState();
  return bot;
}

export function upsertBotPosition(update) {
  const existing = getBot(update.id);
  const bot = {
    id: update.id,
    name: update.name ?? existing?.name ?? update.id,
    username: update.username ?? update.name ?? existing?.username ?? update.id,
    auth: update.auth ?? existing?.auth ?? "offline",
    status: update.status ?? "online",
    ping: update.ping ?? null,
    serverId: update.serverId ?? existing?.serverId,
    profilesFolder: existing?.profilesFolder ?? null,
    discordUserId: existing?.discordUserId ?? null,
    shouldRun: existing?.shouldRun ?? false,
    x: Number(update.x),
    y: Number(update.y),
    z: Number(update.z),
    lastCallback: new Date().toISOString(),
  };

  if (existing) {
    Object.assign(existing, bot);
  } else {
    bots.push(bot);
  }

  saveState();
  return existing ?? bot;
}

export function randomWalkBot(bot) {
  if (bot.status !== "online") return bot;

  const server = servers.find((item) => item.id === bot.serverId);
  const radius = server?.mapRadius ?? 1000;
  bot.x = Math.max(-radius, Math.min(radius, bot.x + Math.round(Math.random() * 40 - 20)));
  bot.z = Math.max(-radius, Math.min(radius, bot.z + Math.round(Math.random() * 40 - 20)));
  bot.y = Math.max(40, Math.min(120, bot.y + Math.round(Math.random() * 2 - 1)));
  bot.ping = 25 + Math.round(Math.random() * 90);
  bot.lastCallback = new Date().toISOString();
  saveState();
  return bot;
}

function ensureDiscordEntry(discordId) {
  let entry = discordLinks[discordId];
  if (typeof entry === "string") {
    // legacy format: bare botId string
    entry = { botId: entry };
    discordLinks[discordId] = entry;
  } else if (!entry || typeof entry !== "object") {
    entry = {};
    discordLinks[discordId] = entry;
  }
  return entry;
}

export function getDiscordEntry(discordId) {
  const entry = discordLinks[discordId];
  if (!entry) return null;
  if (typeof entry === "string") return { botId: entry };
  return entry;
}

export function getDiscordLink(discordId) {
  const entry = getDiscordEntry(discordId);
  if (!entry?.botId) return null;
  return getBot(entry.botId);
}

export function setDiscordLink(discordId, botId) {
  const entry = ensureDiscordEntry(discordId);
  entry.botId = botId;
  saveState();
}

export function setDiscordServer(discordId, serverId) {
  const entry = ensureDiscordEntry(discordId);
  entry.serverId = serverId;
  saveState();
}

export function getDiscordServerId(discordId) {
  return getDiscordEntry(discordId)?.serverId ?? null;
}

export function getProfilesDir() {
  return PROFILES_DIR;
}

function ensureBotAddons(bot) {
  if (!bot.addons || typeof bot.addons !== "object") bot.addons = {};
  return bot.addons;
}

export function getBotAddons(botId) {
  const bot = getBot(botId);
  if (!bot) return null;
  return { ...ensureBotAddons(bot) };
}

export function setBotAddon(botId, name, patch) {
  const bot = getBot(botId);
  if (!bot) return null;
  const addons = ensureBotAddons(bot);
  const prev = addons[name] ?? { enabled: false, config: {} };
  const next = {
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : prev.enabled,
    config: patch.config !== undefined
      ? { ...(prev.config ?? {}), ...(patch.config ?? {}) }
      : (prev.config ?? {}),
  };
  addons[name] = next;
  saveState();
  return next;
}

export function removeBotAddon(botId, name) {
  const bot = getBot(botId);
  if (!bot?.addons || !(name in bot.addons)) return false;
  delete bot.addons[name];
  saveState();
  return true;
}

export function getCommandAllowlist() {
  return { enabled: Boolean(commandAllowlist.enabled), users: [...commandAllowlist.users] };
}

export function setCommandAllowlistEnabled(enabled) {
  commandAllowlist.enabled = Boolean(enabled);
  saveState();
}

export function addCommandAllowlistUser(userId) {
  const id = String(userId);
  if (!/^\d{10,25}$/.test(id)) return { ok: false, error: "invalid_snowflake" };
  if (!commandAllowlist.users.includes(id)) {
    commandAllowlist.users.push(id);
    saveState();
  }
  return { ok: true, count: commandAllowlist.users.length };
}

export function removeCommandAllowlistUser(userId) {
  const id = String(userId);
  const i = commandAllowlist.users.indexOf(id);
  if (i < 0) return { ok: false, error: "not_on_list" };
  commandAllowlist.users.splice(i, 1);
  saveState();
  return { ok: true };
}

export function removeDiscordLink(discordId) {
  const id = String(discordId);
  if (discordLinks[id]) {
    delete discordLinks[id];
    saveState();
    return true;
  }
  return false;
}
