// src/lib/target-parser.mjs

/**
 * Parse a target string into a sorted, deduplicated array of bot numbers.
 * @param {string} input - e.g. "1-3", "1,3,5", "1-3,5", "all"
 * @param {number} maxBots - upper bound (inclusive)
 * @returns {number[]}
 */
export function parseTargets(input, maxBots) {
  if (!input || !maxBots) return [];
  if (input.trim().toLowerCase() === "all") {
    return Array.from({ length: maxBots }, (_, i) => i + 1);
  }

  const result = new Set();
  const parts = input.split(",");

  for (const part of parts) {
    const trimmed = part.trim();
    const range = trimmed.match(/^(\d+)-(\d+)$/);
    if (range) {
      const from = Math.max(1, parseInt(range[1], 10));
      const to = Math.min(maxBots, parseInt(range[2], 10));
      for (let i = from; i <= to; i++) result.add(i);
      continue;
    }
    const single = trimmed.match(/^(\d+)$/);
    if (single) {
      const n = parseInt(single[1], 10);
      if (n >= 1 && n <= maxBots) result.add(n);
    }
  }

  return [...result].sort((a, b) => a - b);
}
