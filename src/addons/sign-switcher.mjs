import _pf from 'mineflayer-pathfinder';
const { pathfinder, Movements, goals } = _pf;
import { Vec3 } from 'vec3';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  loadPresets,
  savePresets,
  matchesAnyPreset,
  getRandomPreset,
} from './sign-switcher-presets.mjs';

const CLAIMED_PATH = path.join(process.cwd(), 'data', 'sign-switcher-claimed.json');

async function loadClaimed() {
  try {
    return new Set(JSON.parse(await fs.readFile(CLAIMED_PATH, 'utf8')));
  } catch {
    return new Set();
  }
}

async function saveClaimed(set) {
  try {
    await fs.writeFile(CLAIMED_PATH, JSON.stringify([...set]));
  } catch {}
}

const { GoalNear } = goals;

export const meta = {
  name: 'sign-switcher',
  description: 'Wanders and replaces signs with random preset text.',
  defaultConfig: {
    scanIntervalTicks: 20,
    wanderRange: 16,
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

  // claimed: shared across all bot instances and persists across restarts.
  // Loaded once at init, written to disk whenever a sign is claimed or skipped.
  let claimed = new Set();

  function extractMsgText(m) {
    try {
      // m may be a raw string, a prismarine-nbt {type,value} wrapper, or an NBT compound
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

  // Read sign lines directly from mineflayer's stored block entity (works for all versions).
  function getSignLines(pos) {
    const block = bot.blockAt(pos);
    if (!block?.entity) return null;
    const nbt = block.entity;
    // 1.18+ format: front_text.messages
    const frontText = nbt.value?.front_text?.value;
    if (frontText) {
      const msgs = frontText.messages?.value?.value ?? [];
      if (!msgs.length) return null;
      return msgs.map(extractMsgText);
    }
    // 1.12.2 format: Text1-Text4
    const texts = [nbt.value?.Text1?.value, nbt.value?.Text2?.value, nbt.value?.Text3?.value, nbt.value?.Text4?.value];
    if (texts.every((t) => t === undefined)) return null;
    return texts.map((t) => extractMsgText(t ?? '{"text":""}'));
  }

  async function packetBreak(block) {
    await bot.dig(block, true);
  }

  async function reloadPresets() {
    presets = await loadPresets();
  }

  function startWander() {
    if (stopped || !bot.entity) return;
    const pos = bot.entity.position;
    const angle = Math.random() * Math.PI * 2;
    const dist = 50 + Math.floor(Math.random() * 50);
    const x = Math.floor(pos.x + Math.cos(angle) * dist);
    const z = Math.floor(pos.z + Math.sin(angle) * dist);
    bot.pathfinder.setGoal(new GoalNear(x, Math.floor(pos.y), z, 3));
  }

  // Returns {pos, breakFirst: true} for an existing sign with wrong text
  function findSignToReplace() {
    if (!Object.keys(presets).length) return null;
    const positions = bot.findBlocks({
      matching: (b) => b.name.includes('sign'),
      maxDistance: 24,
      count: 20,
    });
    for (const pos of positions) {
      const key = `${pos.x},${pos.y},${pos.z}`;
      if (claimed.has(key)) continue;
      const lines = getSignLines(pos);
      if (lines === null) continue;
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
        if (!b.position || b.position.distanceTo(botPos) < 2) return false;
        const above = bot.blockAt(b.position.offset(0, 1, 0));
        const above2 = bot.blockAt(b.position.offset(0, 2, 0));
        return above?.name === 'air' && above2?.name === 'air';
      },
      maxDistance: 32,
    });
    if (!block) return null;
    return { pos: block.position.offset(0, 1, 0), breakFirst: false };
  }

  async function waitForInventorySign(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (bot.inventory.items().some((i) => i.name.includes('sign'))) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  async function runPipeline({ pos: targetPos, breakFirst }) {
    const localPresets = { ...presets };
    const key = `${targetPos.x},${targetPos.y},${targetPos.z}`;
    busy = true;
    try {
      log(`[sign-switcher] ${breakFirst ? 'replacing sign' : 'placing sign'} at ${targetPos}`);

      await bot.pathfinder.goto(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 2));
      if (stopped) return;

      if (breakFirst) {
        const signBlock = bot.blockAt(targetPos);
        if (!signBlock?.name.includes('sign')) {
          log('[sign-switcher] sign gone before break');
          return;
        }
        try {
          await packetBreak(signBlock);
        } catch (digErr) {
          log(`[sign-switcher] dig failed: ${digErr.message}`);
          claimed.add(key); saveClaimed(claimed);
          return;
        }
        if (stopped) return;

        // Bot is already within 2 blocks — wait for item auto-pickup
        await waitForInventorySign(4000);
        if (stopped) return;
      }

      const signItem = bot.inventory.items().find((i) => i.name.includes('sign'));
      if (!signItem) {
        log('[sign-switcher] no sign in inventory');
        claimed.add(key); saveClaimed(claimed);
        return;
      }

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
        const trimmed = [...preset];
        while (trimmed.length && trimmed[trimmed.length - 1] === '') trimmed.pop();
        await bot.updateSign(placedSign, trimmed.join('\n'), false);
        claimed.add(key); saveClaimed(claimed);
        log(`[sign-switcher] wrote sign at ${targetPos}`);
      }
    } catch (err) {
      // Navigation or placement failure — don't block the position, it may work next scan
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
        // Always prefer replacing existing signs — if we have signs in inventory
        // findSignToReplace still breaks and replaces (wasting the dropped item but that's fine).
        // Fall back to placing on empty spots only when no replaceable sign is in range.
        const target = findSignToReplace() ?? findPlacementSpot();
        if (target) {
          runPipeline(target).catch((err) => log(`[sign-switcher] unhandled: ${err.message}`));
        }
      }
    } catch (err) {
      log(`[sign-switcher] tick error: ${err.message}`);
    }
  }

  Promise.all([reloadPresets(), loadClaimed().then((c) => { claimed = c; })]).then(() => {
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
