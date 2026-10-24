// Meno agenta pre hooky: TASKER_USER, AGENT_NAME, inak "# Meno" z PERSONA.md
// v projekte (malými). Vlákno T3 agenta nemá TASKER_USER ani AGENT_NAME,
// meno nesie len persona (úloha Taskera 425).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function agentName(input = {}, env = process.env) {
  if (env.TASKER_USER) return env.TASKER_USER;
  if (env.AGENT_NAME) return env.AGENT_NAME;
  try {
    const root = env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    return readFileSync(join(root, "PERSONA.md"), "utf8").match(/^# (.+)$/m)?.[1].trim().toLowerCase() || null;
  } catch {
    return null;
  }
}
