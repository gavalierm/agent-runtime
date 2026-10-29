#!/usr/bin/env node
// requires: mac
// server_work.mjs — službu na serveri spúšťa správca servera, nie zástupca
// operátora na Macu. 18. 10. 2026 kontrola povolení zamietla agentovi štart
// služby správcu úloh a zástupca na Macu ho spustil sám cez root SSH. Operátor to vytkol:
// zástupca beží na Macu, ktorý spí, a správna oprava bola oprava povolení agenta,
// tú robí správca agentov (rozhodnutia z 18. a 19. 10. 2026).
//
// PreToolUse Bash z .claude/settings.json repa. Príkaz cez ssh, ktorý
// spúšťa alebo reštartuje systemd službu, zamietne. Výnimkou sú služby
// samotných agentov (agent-driver@, t3code, v ktorom bežia agenti ako vlákna,
// a mená z SERVER_WORK_AGENTS cez čiarku), ich beh a cesta k nim sú
// práca správcu agentov.

import { fileURLToPath } from "node:url";
import { exitDeny } from "../lib/deny.mjs";

const START = /systemctl\s+(?:--user\s+)?(?:-M\s+\S+\s+)?(?:start|restart|enable\s+--now)\s+([\w@.-]+)/g;
const OWN = ["agent", "t3code", ...(process.env.SERVER_WORK_AGENTS || "").split(",").map((x) => x.trim().replace(/[^\w-]/g, "")).filter(Boolean)];
const AGENT = new RegExp(`^(${OWN.join("|")})[\\w@.-]*$`);

export const POSTUP =
  "pošli správcovi agentov `bin/ask_agent.sh <správca agentov> <téma>` s textom na stdin, opravu povolení robí on.";

export function verdict(cmd) {
  if (!/\bssh\b/.test(cmd)) return null;
  for (const m of cmd.matchAll(START)) {
    if (!AGENT.test(m[1])) {
      return `Štart služby ${m[1]} na serveri je práca správcu servera, nie zástupcu operátora na Macu. `
        + "Keď mu ho zamietne kontrola povolení, pošli to správcovi agentov skriptom ask_agent.sh <správca agentov> <téma>, "
        + "opravu povolení robí on.";
    }
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = "";
  process.stdin.on("data", (c) => (input += c)).on("end", () => {
    let e; try { e = JSON.parse(input); } catch { process.exit(0); }
    if (e.tool_name !== "Bash") process.exit(0);
    const v = verdict(e.tool_input?.command || "");
    if (v) exitDeny(v, POSTUP);
  });
}
