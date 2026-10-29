// paths.mjs: cesty ku klonom, v ktorých leží kód a spoločný mozog agentov.
// Jediné miesto, ktoré ich pozná; hook alebo skript, ktorý potrebuje vlastný
// koreň repa, ho berie z import.meta.url, nie odtiaľto.
//   workflowDir        klon tohto repa (AGENT_WORKFLOW)
//   brainGlobalDir     klon spoločného mozgu agentov (AGENT_BRAIN_GLOBAL)
//   decisionsDir       register rozhodnutí v spoločnom mozgu, súbory D0001.md
// Bez premennej je to na macOS ~/Work/<repo>, inak /opt/<repo>.
import { homedir } from "node:os";
import { join } from "node:path";

const home = (env) => env.HOME || homedir();

export function workflowDir(env = process.env, platform = process.platform) {
  return env.AGENT_WORKFLOW || (platform === "darwin" ? join(home(env), "Work/agentic-workflow") : "/opt/agentic-workflow");
}

export function brainGlobalDir(env = process.env, platform = process.platform) {
  return env.AGENT_BRAIN_GLOBAL || (platform === "darwin" ? join(home(env), "Work/agentic-brain-global") : "/opt/agentic-brain-global");
}

export function decisionsDir(env = process.env, platform = process.platform) {
  return join(brainGlobalDir(env, platform), "decisions");
}
