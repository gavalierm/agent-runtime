// agent_env.mjs: hodnoty prostredia pre hooky bez mien a adries v kóde.
// Hook beží v relácii claude, kde `runtime.env` agenta nie je načítaný, preto
// ho `hookEnv` číta sám: AGENT_RUNTIME_ENV (cesta k súboru), inak
// ~/.config/<agent>/runtime.env, agent je z lib/agent_name.mjs (TASKER_USER,
// AGENT_NAME, inak "# Meno" z PERSONA.md). Premenné procesu majú prednosť
// pred súborom, prázdna hodnota ho neprekrýva. Chýbajúci súbor nie je chyba, hook dostane predvolené hodnoty.
//
// Premenné, ktoré hooky čítajú (opis v README, časť Premenné prostredia):
// AGENT_OPERATOR_NAME, AGENT_RULES_REPO, AGENT_TASKER_USER, AGENT_TK,
// TASKER_WEB_URL, TASKER_HOME, TASKER_DB, AR_ROZHODNUTIA.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentName } from "./agent_name.mjs";

// KEY=VALUE po riadkoch, voliteľný `export `, hodnota v úvodzovkách, komentáre.
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2].trim();
    const q = /^(["'])(.*)\1/.exec(v);
    v = q ? q[2] : v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

// Prostredie hooku: runtime.env agenta pod premennými procesu.
export function hookEnv(input = {}, env = process.env) {
  let file = env.AGENT_RUNTIME_ENV;
  if (!file) {
    const name = agentName(input, env);
    if (name && /^[a-z0-9_-]+$/.test(name)) file = join(env.HOME || homedir(), ".config", name, "runtime.env");
  }
  let vals = {};
  if (file) {
    try { vals = parseEnvFile(readFileSync(file, "utf8")); } catch {}
  }
  const merged = { ...vals };
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== "") merged[k] = v;
  return merged;
}

// Prepínač kontrol rozhodnutí (kontroly waitingProblem a decisionProblem
// v reply_guard.mjs a sledovanie rozhodnutia/ v rules_delta.mjs).
export const zapnute = (env = process.env) => env.AR_ROZHODNUTIA === "1";

// Klon repa pravidiel: AR_CLONE (skúšky), AGENT_RULES_REPO, inak Mac
// ~/Work/agent-rules a server /opt/agent-rules.
export function rulesRepo(env = process.env, platform = process.platform) {
  return env.AR_CLONE || env.AGENT_RULES_REPO
    || (platform === "darwin" ? join(env.HOME || homedir(), "Work/agent-rules") : "/opt/agent-rules");
}

// Tvary mena operátora v textoch pre model: nominatív, datív (-ovi), genitív
// (-a). Bez AGENT_OPERATOR_NAME je to slovo "operátor".
export function operatorForms(env = process.env) {
  const nom = String(env.AGENT_OPERATOR_NAME || "").trim() || "operátor";
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return { nom, dat: `${nom}ovi`, gen: `${nom}a`, cap };
}
