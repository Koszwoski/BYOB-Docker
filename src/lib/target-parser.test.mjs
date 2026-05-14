// src/lib/target-parser.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTargets } from "./target-parser.mjs";

test("range: 1-3 returns [1,2,3]", () => {
  assert.deepEqual(parseTargets("1-3", 5), [1, 2, 3]);
});

test("list: 1,3,5 returns [1,3,5]", () => {
  assert.deepEqual(parseTargets("1,3,5", 5), [1, 3, 5]);
});

test("mixed: 1-3,5 returns [1,2,3,5]", () => {
  assert.deepEqual(parseTargets("1-3,5", 5), [1, 2, 3, 5]);
});

test("all: returns all bots 1..maxBots", () => {
  assert.deepEqual(parseTargets("all", 3), [1, 2, 3]);
});

test("clamps to maxBots: 1-10 with maxBots=3 returns [1,2,3]", () => {
  assert.deepEqual(parseTargets("1-10", 3), [1, 2, 3]);
});

test("deduplicates: 1-3,2 returns [1,2,3]", () => {
  assert.deepEqual(parseTargets("1-3,2", 3), [1, 2, 3]);
});

test("invalid input returns []", () => {
  assert.deepEqual(parseTargets("abc", 3), []);
});
