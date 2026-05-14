import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import {
  loadPresets,
  savePresets,
  matchesAnyPreset,
  getRandomPreset,
} from './sign-switcher-presets.mjs';

const { GoalNear } = goals;

export const meta = {
  name: 'sign-switcher',
  description: 'Wanders and replaces signs with random preset text.',
  defaultConfig: {
    scanIntervalTicks: 20,
    wanderRange: 100,
    writeDelayMs: 250,
  },
};

export function init(bot, config, ctx) {
  const log = ctx?.log ?? (() => {});

  bot.loadPlugin(pathfinder);

  let presets = {};
  let busy = false;
  let stopped = false;
  let scanTick = 0;
  let tickTimer = null;

  // Cache sign text from block entity packets for loop prevention
  const signTextCache = new Map();
  bot._client.on('block_entity_data', (packet) => {
    const { x, y, z } = packet.location;
    const nbt = packet.nbtData;
    if (!nbt) return;
    const frontText = nbt.value?.front_text?.value;
    if (!frontText) return;
    const msgs = frontText.messages?.value?.value ?? [];
    const lines = msgs.map((m) => {
      try { return JSON.parse(m.value ?? m).text ?? ''; } catch { return ''; }
    });
    signTextCache.set(`${x},${y},${z}`, lines);
  });

  async function reloadPresets() {
    presets = await loadPresets();
  }

  function startWander() {
    if (stopped) return;
    const pos = bot.entity.position;
    const range = config.wanderRange ?? 100;
    const x = Math.floor(pos.x) + Math.floor(Math.random() * (range * 2 + 1)) - range;
    const z = Math.floor(pos.z) + Math.floor(Math.random() * (range * 2 + 1)) - range;
    bot.pathfinder.setGoal(new GoalNear(x, Math.floor(pos.y), z, 3));
  }

  function findNearbySign() {
    if (!Object.keys(presets).length) return null;
    const block = bot.findBlock({
      matching: (b) => b.name.includes('sign'),
      maxDistance: 64,
    });
    if (!block) return null;
    const key = `${block.position.x},${block.position.y},${block.position.z}`;
    const lines = signTextCache.get(key) ?? [];
    if (matchesAnyPreset(lines, presets)) return null;
    // Only target floor-standing signs (solid block directly below)
    const below = bot.blockAt(block.position.offset(0, -1, 0));
    if (!below || below.name === 'air') return null;
    return block.position;
  }

  function waitForInventorySign(timeoutMs) {
    return new Promise((resolve) => {
      if (bot.inventory.items().some((i) => i.name.includes('sign'))) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        bot.removeListener('playerCollect', handler);
        resolve(false);
      }, timeoutMs);
      function handler() {
        if (bot.inventory.items().some((i) => i.name.includes('sign'))) {
          clearTimeout(timer);
          bot.removeListener('playerCollect', handler);
          resolve(true);
        }
      }
      bot.on('playerCollect', handler);
    });
  }

  async function runPipeline(targetPos) {
    const localPresets = { ...presets };
    busy = true;
    try {
      log(`[sign-switcher] approaching sign at ${targetPos}`);

      // Navigate to sign
      await bot.pathfinder.goto(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 3));
      if (stopped) return;

      // Break sign
      const signBlock = bot.blockAt(targetPos);
      if (!signBlock?.name.includes('sign')) {
        log('[sign-switcher] sign gone before break');
        return;
      }
      await bot.dig(signBlock);
      if (stopped) return;

      // Collect — wait up to 5s for sign to appear in inventory
      await waitForInventorySign(5000);
      if (stopped) return;

      const signItem = bot.inventory.items().find((i) => i.name.includes('sign'));
      if (!signItem) {
        log('[sign-switcher] no sign in inventory after break');
        return;
      }

      // Navigate back to placement position
      await bot.pathfinder.goto(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 3));
      if (stopped) return;

      // Place sign on the block below the original position
      const refBlock = bot.blockAt(targetPos.offset(0, -1, 0));
      if (!refBlock || refBlock.name === 'air') {
        log('[sign-switcher] no block to place sign on');
        return;
      }
      await bot.equip(signItem, 'hand');
      await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
      if (stopped) return;

      // Write text after a short delay
      await new Promise((r) => setTimeout(r, config.writeDelayMs ?? 250));
      if (stopped) return;

      const placedSign = bot.blockAt(targetPos);
      if (!placedSign?.name.includes('sign')) {
        log('[sign-switcher] sign not found after place');
        return;
      }
      const preset = getRandomPreset(localPresets);
      if (preset) {
        await bot.updateSign(placedSign, preset, true);
        log(`[sign-switcher] replaced sign at ${targetPos}`);
      }
    } catch (err) {
      log(`[sign-switcher] pipeline error: ${err.message}`);
    } finally {
      busy = false;
    }
  }

  function tick() {
    if (stopped || busy) return;
    if (!bot.pathfinder.isMoving()) startWander();
    if (++scanTick >= (config.scanIntervalTicks ?? 20)) {
      scanTick = 0;
      const target = findNearbySign();
      if (target) {
        bot.pathfinder.stop();
        runPipeline(target).catch((err) => log(`[sign-switcher] unhandled pipeline error: ${err.message}`));
      }
    }
  }

  reloadPresets().then(() => {
    if (stopped) return;
    const movements = new Movements(bot);
    bot.pathfinder.setMovements(movements);
    startWander();
    tickTimer = setInterval(tick, 50);
  });

  return {
    cleanup() {
      stopped = true;
      clearInterval(tickTimer);
      try { bot.pathfinder.stop(); } catch {}
    },

    async command(sub, args) {
      await reloadPresets();

      if (sub === 'add') {
        const [name, l1, l2, l3, l4] = args;
        if (!name) return 'Usage: `.addon sign-switcher add <name> <l1> <l2> <l3> <l4>`';
        presets[name] = [l1 ?? '', l2 ?? '', l3 ?? '', l4 ?? ''];
        await savePresets(presets);
        return `Preset \`${name}\` saved: "${l1 ?? ''}" / "${l2 ?? ''}" / "${l3 ?? ''}" / "${l4 ?? ''}"`;
      }

      if (sub === 'remove') {
        const [name] = args;
        if (!name) return 'Usage: `.addon sign-switcher remove <name>`';
        if (!presets[name]) return `Preset \`${name}\` not found.`;
        delete presets[name];
        await savePresets(presets);
        return `Preset \`${name}\` removed.`;
      }

      if (sub === 'list') {
        const names = Object.keys(presets);
        if (!names.length) return 'No presets. Use `.addon sign-switcher add <name> <l1> <l2> <l3> <l4>`';
        return `Presets (${names.length}): ${names.map((n) => `\`${n}\``).join(', ')}`;
      }

      return `Unknown subcommand \`${sub}\`. Available: add, remove, list`;
    },
  };
}

