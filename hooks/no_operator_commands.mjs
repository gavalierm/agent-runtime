#!/usr/bin/env node
// requires: none
// no_operator_commands.mjs — agent nedá operátorovi príkaz na spustenie.
// Krok pre operátora je len klik v jeho prehliadači alebo účte, príkaz spustí
// agent. Chyba sa opakovala 15. 10. 2026, preto kontrola a nie próza.
//
// Stop zo settings.json prostredia alebo .claude/settings.json repa. Prečíta
// poslednú odpoveď v prepise a keď má blok kódu s príkazom shellu, odpoveď
// zastaví s dôvodom. Agent potom krok urobí sám alebo cez iného agenta
// a odpoveď prepíše. Príkaz prejde, keď odpoveď nesie riadok "Príkaz pre
// teba, lebo ...": agent ho spustiť nevie alebo oň operátor požiadal. Pri
// druhom zastavení v rade (stop_hook_active) mlčí, aby sa nezacyklil.
// Meno operátora v dôvodoch je AGENT_OPERATOR_NAME (lib/agent_env.mjs),
// bez neho slovo "operátor".

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { blockStop } from "../lib/deny.mjs";
import { hookEnv, operatorForms } from "../lib/agent_env.mjs";

const CMDS = new Set(["ssh", "sudo", "cd", "git", "npm", "npx", "node", "brew", "curl", "wget", "bash", "sh", "zsh",
  "export", "mkdir", "rm", "cp", "mv", "chmod", "chown", "docker", "systemctl", "tmux", "claude", "python", "python3",
  "pip", "pip3", "open", "defaults", "launchctl", "scp", "rsync", "make", "tailscale", "gh", "kill", "killall"]);
const SHELL_LANG = /^(sh|bash|zsh|shell|console|terminal)$/i;

const JUSTIFIED = /^Príkaz pre teba, lebo \S/m;

// Vráti prvý riadok s príkazom v bloku kódu alebo null.
export function findCommand(text) {
  if (JUSTIFIED.test(text)) return null;
  for (const m of text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)) {
    const lang = m[1].trim();
    const lines = m[2].split("\n").map((l) => l.trim()).filter(Boolean);
    if (SHELL_LANG.test(lang) && lines.length) return lines[0];
    for (const l of lines) {
      const w = l.replace(/^\$\s+/, "").split(/\s+/)[0];
      if (l.startsWith("$ ") || l.startsWith("./") || CMDS.has(w)) return l;
    }
  }
  return null;
}

// Zoznam "Čaká na teba:" nesie len to, čo agent urobiť nesmie ani nevie.
// Každá položka končí značkou (rozhodnutie), (hodnota) alebo (tvoj účet).
// Úkon, na ktorý operátor dal správcovi agentov oprávnenie všeobecne (kľúče
// agentov, stav úloh), do zoznamu nepatrí ani so značkou. Chyba sa opakovala
// 16. 10. 2026.
// Bodka za značkou nevadí, položky v memory/topics/ ju majú.
const TAG = /\((rozhodnutie|hodnota|tvoj účet)\)\.?\s*$/;
// Kľúč DNSSEC v účte registrátora operátora agent nemá (17. 10. 2026).
const AGENT_WORK = [/^(?!.*DNSSEC).*kľúč/i, /cancel/i, /zruš/i, /\bGAV-\d+/];
export function findWaitingProblem(text) {
  const m = text.match(/Čaká na teba:\s*\n([\s\S]*)$/);
  if (!m) return null;
  for (const raw of m[1].split("\n")) {
    const l = raw.trim();
    if (!l.startsWith("- ")) { if (l) break; continue; }
    const item = l.slice(2);
    for (const re of AGENT_WORK) if (re.test(item)) return `položka "${item.slice(0, 80)}" je úkon, ktorý urobí agent`;
    if (!TAG.test(item)) return `položka "${item.slice(0, 80)}" nemá značku (rozhodnutie), (hodnota) alebo (tvoj účet)`;
  }
  return null;
}

// Text odpovede modelu od poslednej skutočnej správy operátora.
export function lastReply(transcript) {
  let parts = [];
  for (const line of transcript.split("\n")) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const c = e.message?.content;
    if (e.type === "user") {
      const human = typeof c === "string" || (Array.isArray(c) && c.some((b) => b.type === "text"));
      if (human) parts = [];
    } else if (e.type === "assistant" && Array.isArray(c)) {
      for (const b of c) if (b.type === "text") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  if (input.stop_hook_active) process.exit(0);
  let text = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
  if (!text && input.transcript_path) {
    try { text = lastReply(readFileSync(input.transcript_path, "utf8")); } catch {}
  }
  const op = operatorForms(hookEnv(input));
  const waiting = findWaitingProblem(text);
  if (waiting) {
    blockStop(
      `Zoznam "Čaká na teba": ${waiting}. ${op.cap(op.dat)} patrí len rozhodnutie, hodnota alebo krok v jeho účte, `
        + "ktorý agent nemá. Úkon, na ktorý máš oprávnenie, urob sám alebo ho zadaj agentovi a odpoveď prepíš.",
      "úkon urob sám, alebo ho zadaj agentovi úlohou (`tasker task add --assign <agent>`), z \"Čaká na teba\" ho vyhoď "
        + "a každá zostávajúca položka končí značkou (rozhodnutie), (hodnota) alebo (tvoj účet); potom odpoveď prepíš.",
    );
    process.exit(0);
  }
  const hit = findCommand(text);
  if (hit) {
    blockStop(
      `Odpoveď dáva ${op.dat} príkaz na spustenie: "${hit.slice(0, 80)}". Krok pre ${op.gen} `
        + "je klik v prehliadači alebo účte. Príkaz spusti sám alebo ho zadaj agentovi a odpoveď prepíš. "
        + `Keď ho nevie spustiť žiadny agent alebo oň ${op.nom} požiadal, daj nad blok riadok "Príkaz pre teba, lebo <dôvod>".`,
      "príkaz spusti sám cez Bash a v odpovedi napíš výsledok; keď ho nevie spustiť žiadny agent alebo oň " + op.nom + " požiadal, "
        + "daj nad blok riadok \"Príkaz pre teba, lebo <dôvod>\" (global/CLAUDE.md §6).",
    );
  }
}
