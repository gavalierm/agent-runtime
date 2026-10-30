// session_id.mjs: reťaz relácií vlákna (úloha 656). Súbory vznikajú v mkdtemp.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as mkdtempRaw, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordChain, chainedSessions } from "../lib/session_id.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const tmp = () => mkdtempSync(join(tmpdir(), "session_id-"));

test("recordChain vytvorí súbor, pridá id po jednom na riadok a bez duplicít", () => {
  const dir = tmp();
  recordChain(dir, "aaa", ["aaa", "bbb"]);
  assert.equal(readFileSync(join(dir, "aaa.sessions"), "utf8"), "aaa\nbbb\n");
  recordChain(dir, "aaa", ["bbb", "ccc", "ccc", "", null]);
  assert.equal(readFileSync(join(dir, "aaa.sessions"), "utf8"), "aaa\nbbb\nccc\n");
});

test("chainedSessions vráti všetky id zo súboru, ktorý id obsahuje alebo ho nazýva", () => {
  const dir = tmp();
  recordChain(dir, "aaa", ["bbb", "ccc"]);
  recordChain(dir, "xxx", ["yyy"]);
  assert.deepEqual([...chainedSessions(dir, "ccc")].sort(), ["aaa", "bbb", "ccc"]);
  assert.deepEqual([...chainedSessions(dir, "aaa")].sort(), ["aaa", "bbb", "ccc"]);
  assert.deepEqual([...chainedSessions(dir, "yyy")].sort(), ["xxx", "yyy"]);
  assert.equal(chainedSessions(dir, "zzz").size, 0);
});

test("chainedSessions: viac súborov s rovnakým id sa spojí, chyba čítania je prázdna množina", () => {
  const dir = tmp();
  writeFileSync(join(dir, "aaa.sessions"), "bbb\n");
  writeFileSync(join(dir, "ddd.sessions"), "bbb\neee\n");
  assert.deepEqual([...chainedSessions(dir, "bbb")].sort(), ["aaa", "bbb", "ddd", "eee"]);
  assert.equal(chainedSessions(join(dir, "neexistuje"), "bbb").size, 0);
});
