#!/usr/bin/env node
// requires: none
// implementator_model.mjs — sub-agent `implementator` beží na Sonnete, preto
// hook zamietne volanie nástroja Agent, ktoré mu parametrom `model` vnúti iný
// model. Parameter `model` pri volaní má prednosť pred `model` vo frontmatteri
// agents/implementator.md (docs sub-agents, 25. 10. 2026), bez hooku by
// `model: "opus"` frontmatter obišlo. Úloha Taskera 602.
//
// Zapisujúci sub-agent beží vo worktree (hlavný klon je jediný zapisovateľ,
// env/server/CLAUDE.md Git na serveri, úloha 616), preto hook pri `implementator`
// vyžaduje aj `isolation: "worktree"`.
//
// PreToolUse pre Agent a Task. Model "sonnet", id začínajúce "claude-sonnet"
// a chýbajúci model (platí frontmatter) prejdú. Iný subagent_type prejde vždy.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { denyTool } from "../lib/deny.mjs";

export const TYPE = "implementator";

export function isSonnet(model) {
  return /^(sonnet|claude-sonnet)/i.test(String(model).trim());
}

// Vráti zamietnutý model, alebo null.
export function badModel(input) {
  if (!input || (input.tool_name !== "Agent" && input.tool_name !== "Task")) return null;
  const t = input.tool_input || {};
  if (t.subagent_type !== TYPE) return null;
  if (t.model === undefined || t.model === null || t.model === "") return null;
  return isSonnet(t.model) ? null : String(t.model);
}

// Vráti true, ak volanie implementatora nemá `isolation: "worktree"`.
export function noWorktree(input) {
  if (!input || (input.tool_name !== "Agent" && input.tool_name !== "Task")) return false;
  const t = input.tool_input || {};
  if (t.subagent_type !== TYPE) return false;
  return t.isolation !== "worktree";
}

export const MESSAGE =
  "Sub-agent `implementator` beží na Sonnete (global §6), volanie s iným modelom zamietnem: parameter `model` by prebil frontmatter agents/implementator.md.";

export const POSTUP =
  "zavolaj Agent so subagent_type `implementator` bez parametra `model` (platí `model: sonnet` z definície), alebo s model `sonnet`.";

export const ISOLATION_MESSAGE =
  "Sub-agent `implementator` zapisuje, preto beží vo worktree: hlavný klon je jediný zapisovateľ svojho repa. Volanie bez `isolation: \"worktree\"` zamietnem.";

export const ISOLATION_POSTUP =
  "zavolaj Agent s isolation: \"worktree\" (hlavný klon je jediný zapisovateľ, env/server/CLAUDE.md Git na serveri).";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  const bad = badModel(input);
  if (bad) denyTool(`${MESSAGE} Model: ${bad}`, POSTUP);
  if (noWorktree(input)) denyTool(ISOLATION_MESSAGE, ISOLATION_POSTUP);
}
