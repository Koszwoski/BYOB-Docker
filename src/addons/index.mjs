// Addon registry. Each addon lives in its own .mjs file in this
// directory and is only imported the first time it is enabled, so a
// bot with zero addons pays zero memory cost for the addon system.
//
// To add a new addon:
// 1. Create backend/src/addons/<name>.mjs that exports { meta, init }
// 2. Append the name to AVAILABLE below.

const AVAILABLE = ["sign-switcher"];

const cache = new Map();

async function load(name) {
  if (!AVAILABLE.includes(name)) {
    throw new Error(`unknown_addon:${name}`);
  }
  if (cache.has(name)) return cache.get(name);
  const mod = await import(`./${name}.mjs`);
  if (typeof mod.init !== "function" || !mod.meta) {
    throw new Error(`invalid_addon:${name}`);
  }
  cache.set(name, mod);
  return mod;
}

export function listAddonNames() {
  return [...AVAILABLE];
}

export async function getAddonMeta(name) {
  const mod = await load(name);
  return mod.meta;
}

export async function listAddonsWithMeta() {
  const out = [];
  for (const name of AVAILABLE) {
    try {
      const meta = await getAddonMeta(name);
      out.push({ name, description: meta.description, defaultConfig: meta.defaultConfig ?? {} });
    } catch (err) {
      out.push({ name, description: `(error: ${err.message})`, defaultConfig: {} });
    }
  }
  return out;
}

export async function instantiateAddon(name, bot, userConfig, ctx) {
  const mod = await load(name);
  const config = { ...(mod.meta.defaultConfig ?? {}), ...(userConfig ?? {}) };
  const instance = await mod.init(bot, config, ctx);
  return instance ?? { cleanup() {} };
}
