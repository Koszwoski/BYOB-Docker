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

  // Cache sign text from block entity packets for loop prevention.
  // ownWrites tracks positions we wrote ourselves so server echoes can't overwrite our cache.
  const signTextCache = new Map();
  const ownWrites = new Set();

  function extractMsgText(m) {
    try {
      const raw = (m !== null && typeof m === 'object' && 'value' in m) ? m.value : m;
      if (typeof raw === 'string') {
        const p = JSON.parse(raw);
        if (typeof p === 'string') return p;
        if (p && typeof p.text === 'string') return p.text;
        return '';
      }
      if (raw && typeof raw === 'object') {
        const t = raw.text;
        if (typeof t === 'string') return t;
        if (t && typeof t.value === 'string') return t.value;
      }
    } catch {}
    return '';
  }

  bot._client.on('block_entity_data', (packet) => {
    const { x, y, z } = packet.location;
    const key = `${x},${y},${z}`;
    if (ownWrites.has(key)) return; // we wrote this — trust our own cache, ignore server echo
    const nbt = packet.nbtData;
    if (!nbt) return;
    const frontText = nbt.value?.front_text?.value;
    if (!frontText) return;
    const msgs = frontText.messages?.value?.value ?? [];
    if (msgs.length === 0) return;
    const lines = msgs.map(extractMsgText);
    signTextCache.set(key, lines);
  });

  function packetBreak(block) {
    const pos = block.position;
    return new Promise((resolve, reject) => {
      const eventName = `blockUpdate:${pos}`;
      const timeout = setTimeout(() => {
        bot.removeListener(eventName, onUpdate);
        reject(new Error('packetBreak timeout'));
      }, 3000);
      function onUpdate(_old, newBlock) {
        if (newBlock?.type !== 0) return;
        clearTimeout(timeout);
        bot.removeListener(eventName, onUpdate);
        resolve();
      }
      bot.on(eventName, onUpdate);
      bot._client.write('block_dig', { status: 0, location: pos, face: 1 });
      bot._client.write('block_dig', { status: 2, location: pos, face: 1 });
    });
  }

  async function reloadPresets() {
    presets = await loadPresets();
  }

  function startWander() {
    if (stopped || !bot.entity) return;
    const pos = bot.entity.position;
    const range = config.wanderRange ?? 100;
    const x = Math.floor(pos.x) + Math.floor(Math.random() * (range * 2 + 1)) - range;
    const z = Math.floor(pos.z) + Math.floor(Math.random() * (range * 2 + 1)) - range;
    bot.pathfinder.setGoal(new GoalNear(x, Math.floor(pos.y), z, 3));
  }

  // Returns {pos, breakFirst: true} for an existing sign with wrong text
  function findSignToReplace() {
    if (!Object.keys(presets).length) return null;
    const positions = bot.findBlocks({
      matching: (b) => b.name.includes('sign'),
      maxDistance: 64,
      count: 20,
    });
    for (const pos of positions) {
      const key = `${pos.x},${pos.y},${pos.z}`;
      const lines = signTextCache.get(key);
      // No cache entry yet = block_entity_data not received — skip to avoid false positives
      if (lines === undefined) continue;
      if (matchesAnyPreset(lines, presets)) continue;
      const below = bot.blockAt(pos.offset(0, -1, 0));
      if (!below || below.name === 'air') continue;
      return { pos, breakFirst: true };
    }
    return null;
  }

  // Returns {pos, breakFirst: false} for an empty spot to place a sign from inventory
  function findPlacementSpot() {
    if (!bot.inventory.items().some((i) => i.name.includes('sign'))) return null;
    if (!Object.keys(presets).length) return null;
    const botPos = bot.entity?.position;
    if (!botPos) return null;
    const block = bot.findBlock({
      matching: (b) => {
        if (b.name === 'air' || b.name.includes('sign') || b.name.includes('water') || b.name.includes('lava')) return false;
        if (b.position.distanceTo(botPos) < 2) return false;
        const above = bot.blockAt(b.position.offset(0, 1, 0));
        const above2 = bot.blockAt(b.position.offset(0, 2, 0));
        return above?.name === 'air' && above2?.name === 'air';
      },
      maxDistance: 8,
    });
    if (!block) return null;
    return { pos: block.position.offset(0, 1, 0), breakFirst: false };
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

  async function runPipeline({ pos: targetPos, breakFirst }) {
    const localPresets = { ...presets };
    busy = true;
    try {
      log(`[sign-switcher] ${breakFirst ? 'replacing sign' : 'placing sign'} at ${targetPos}`);

      await bot.pathfinder.goto(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 3));
      if (stopped) return;

      if (breakFirst) {
        const signBlock = bot.blockAt(targetPos);
        if (!signBlock?.name.includes('sign')) {
          log('[sign-switcher] sign gone before break');
          return;
        }
        await packetBreak(signBlock);
        if (stopped) return;

        await bot.pathfinder.goto(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 1));
        if (stopped) return;
        await waitForInventorySign(5000);
        if (stopped) return;
      }

      const signItem = bot.inventory.items().find((i) => i.name.includes('sign'));
      if (!signItem) {
        log('[sign-switcher] no sign in inventory');
        return;
      }

      await bot.pathfinder.goto(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 3));
      if (stopped) return;

      const refBlock = bot.blockAt(targetPos.offset(0, -1, 0));
      if (!refBlock || refBlock.name === 'air') {
        log('[sign-switcher] no block to place sign on');
        return;
      }
      await bot.equip(signItem, 'hand');
      await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
      if (stopped) return;

      await new Promise((r) => setTimeout(r, config.writeDelayMs ?? 250));
      if (stopped) return;

      const placedSign = bot.blockAt(targetPos);
      if (!placedSign?.name.includes('sign')) {
        log('[sign-switcher] sign not found after place');
        return;
      }
      const preset = getRandomPreset(localPresets);
      if (preset) {
        await bot.updateSign(placedSign, preset.join('\n'), true);
        // Update cache immediately so the next scan doesn't re-target this sign
        // before the server's block_entity_data packet arrives
        const writtenKey = `${targetPos.x},${targetPos.y},${targetPos.z}`;
        signTextCache.set(writtenKey, preset);
        ownWrites.add(writtenKey);
        log(`[sign-switcher] wrote sign at ${targetPos}`);
      }
    } catch (err) {
      log(`[sign-switcher] pipeline error: ${err.message}`);
    } finally {
      busy = false;
    }
  }

  function tick() {
    if (stopped || busy) return;
    try {
      if (!bot.pathfinder.isMoving()) startWander();
      if (++scanTick >= (config.scanIntervalTicks ?? 20)) {
        scanTick = 0;
        const hasSign = bot.inventory.items().some((i) => i.name.includes('sign'));
        // If we already have signs, just place them — no need to break anything
        const target = hasSign ? findPlacementSpot() : findSignToReplace();
        if (target) {
          runPipeline(target).catch((err) => log(`[sign-switcher] unhandled: ${err.message}`));
        }
      }
    } catch (err) {
      log(`[sign-switcher] tick error: ${err.message}`);
    }
  }

  reloadPresets().then(() => {
    if (stopped) return;
    const movements = new Movements(bot);
    bot.pathfinder.setMovements(movements);
    startWander();
    tickTimer = setInterval(tick, 50);
  }).catch((err) => log(`[sign-switcher] init error: ${err.message}`));

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
