#!/usr/bin/env node
// Testy no_operator_commands.mjs. Prvý prípad je odpoveď Cyrila z 15. 10. 2026,
// ktorú operátor odmietol.

import "../lib/git_isolate.mjs";
import { findCommand, findWaitingProblem } from "../hooks/no_operator_commands.mjs";

const cases = [
  ["V Termináli na Macu spusti namiesto neho tento:\n\n```\nssh root@example.ts.net -t /root/server/host/agents/login.sh adam\n```\n", true],
  ["```bash\nnpm run dev\n```", true],
  ["```\n$ git pull\n```", true],
  ["```\n./install.sh\n```", true],
  ["Otvor tento odkaz: https://claude.com/cai/oauth/authorize?code=true", false],
  ["Prompt pre Cyrila:\n```\nV agenti/boris/CLAUDE.md:24 chýba adresa. Overenie: výstup nižšie.\n```", false],
  ["Názov `ssh` v texte bez bloku kódu nevadí.", false],
  ["Príkaz pre teba, lebo hooky nenájdu node a moje nástroje stoja.\n\n```\nsudo ln -sf ~/.nvm/versions/node/v22.23.4/bin/node /usr/local/bin/node\n```", false],
  ["Zadaj toto, lebo to nevie nikto iný.\n\n```\nsudo ln -sf a b\n```", true],
];
let bad = 0;
for (const [text, want] of cases) {
  const got = Boolean(findCommand(text));
  if (got !== want) { bad++; console.log(`✗ chcem ${want}, mám ${got}: ${text.slice(0, 60)}`); }
}
// Prvý prípad je zoznam z odpovede 16. 10. 2026, ktorý operátor odmietol.
const waiting = [
  ["Boris hľadá príčinu.\n\nČaká na teba:\n- V správcovi úloh znova pripoj predplatné Claude, AI pripojenie f25a3597.\n- Nový API kľúč Borisa v správcovi úloh.\n- Úloha 2 na Cancelled a N17 Beszel v úlohe 7.\n", true],
  ["Čaká na teba:\n- Znova pripoj predplatné Claude v správcovi úloh (tvoj účet)\n- Beszel ako monitoring servera, odporúčam áno (rozhodnutie)\n", false],
  ["Čaká na teba:\n- Zruš úlohu v správcovi úloh (tvoj účet)\n", true],
  ["Čaká na teba:\n- Pripoj predplatné\n", true],
  ["Čaká na teba:\n- Zoznam relácií z claude.ai, Settings, Account (tvoj účet).\n", false],
  ["Bez zoznamu.", false],
  ["Hotovo.\n\nČaká na teba:\n- zapísať DNSSEC kľúč Cloudflare pri oboch doménach vo Websupporte (tvoj účet)", false],
  ["Hotovo.\n\nČaká na teba:\n- pridať deploy kľúč na GitHub (tvoj účet)", true],
];
for (const [text, want] of waiting) {
  const got = Boolean(findWaitingProblem(text));
  if (got !== want) { bad++; console.log(`✗ zoznam: chcem ${want}, mám ${got}: ${text.slice(0, 60)}`); }
}
const total = cases.length + waiting.length;
console.log(bad ? `${bad}/${total} zlyhalo` : `${total} prípadov v poriadku`);
process.exit(bad ? 1 : 0);
