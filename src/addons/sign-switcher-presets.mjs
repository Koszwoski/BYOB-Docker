import { promises as fs } from 'node:fs';
import path from 'node:path';

export const DEFAULT_PATH = path.join(process.cwd(), 'data', 'sign-switcher-presets.json');

export async function loadPresets(filePath = DEFAULT_PATH) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw).presets ?? {};
  } catch {
    return {};
  }
}

export async function savePresets(presets, filePath = DEFAULT_PATH) {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ presets }, null, 2));
  } catch (err) {
    throw new Error(`Failed to save presets to ${filePath}: ${err.message}`);
  }
}

export function matchesAnyPreset(lines, presets) {
  return Object.values(presets).some(
    (preset) =>
      preset.length === 4 &&
      preset.every((line, i) => (line ?? '') === (lines[i] ?? ''))
  );
}

export function getRandomPreset(presets) {
  const values = Object.values(presets);
  if (!values.length) return null;
  return values[Math.floor(Math.random() * values.length)];
}

