#!/usr/bin/env node
// Testy objection_fix.mjs. Prvý prípad je odpoveď Cyrila z 15. 10. 2026,
// ktorú operátor odmietol ako "len si mi dal za pravdu".

import "../lib/git_isolate.mjs";
import { verdict } from "../hooks/objection_fix.mjs";

const cases = [
  [{ text: "Pravdu máš, príkaz som ti dať nemal.", cmds: ["ask_ron.sh ..."] }, true],
  [{ text: "Námietku prijímam, opravené v 9a1d4b9.", cmds: ["chyba.sh --trieda x --subor y; git add PERSONA.md && git commit -qm x && git push -q"] }, false],
  [{ text: "Predplatné je prihlásené.", cmds: [] }, false],
  [{ text: "Máš pravdu, opravím to.", cmds: ["git status"] }, true],
  // 18. 10. 2026: oprava len v pamäti, operátor: "diff z memory nestačí".
  [{ text: "Je to moja chyba, zapísal som si to do pamäte (9d14386).", cmds: ["chyba.sh --trieda x --subor y; git add memory/one-login-per-owner.md memory/MEMORY.md && git commit -qm x && git push -q"] }, true],
  [{ text: "Je to moja chyba. Opravil som PERSONA.md v commite 1a2b3c4.", cmds: ["chyba.sh --trieda x --subor y; git add PERSONA.md hooks/objection_fix.mjs && git commit -qm x && git push -q"] }, false],
  [{ text: "Moja chyba, opravené v persone.", cmds: ["chyba.sh --trieda x --subor y; git add PERSONA.md && git commit -qm x"] }, true],
  [{ text: "Uznávam, Borisovi som opravil povolenia v 82b2f4d.", cmds: ["cd ~/Work/agenti/boris && chyba.sh --trieda x --subor y; git add runtime/permissions.json install.sh && git commit -qm x"] }, false],
  // D0142: commit bez chyba.sh zastaví, 390 a 420 (23. 10. 2026).
  [{ text: "Máš pravdu, úloha 390 ostala todo. Opravil som hook v 1a2b3c4.", cmds: ["git add hooks/todo_after_comment.mjs && git commit -qm x"] }, true],
  [{ text: "Moja chyba, úloha 420 ostala todo. Hook 1a2b3c4.", cmds: ["git add hooks/todo_after_comment.mjs && git commit -qm x && /opt/agentic-workflow/bin/chyba.sh --trieda todo --subor hooks/todo_after_comment.mjs"] }, false],
  // Commit so zoznamom za `--` bez git add, štýl servera (23. 10. 2026).
  [{ text: "Moja chyba, opravené v 1a2b3c4.", cmds: ["chyba.sh --trieda x --subor PERSONA.md; git commit -m x -- PERSONA.md && git push -q"] }, false],
  [{ text: "Moja chyba, opravené v 1a2b3c4.", cmds: ["chyba.sh --trieda x --subor y; git commit -m x -- memory/MEMORY.md"] }, true],
];
let bad = 0;
for (const [turn, want] of cases) {
  const got = Boolean(verdict(turn));
  if (got !== want) { bad++; console.log(`✗ chcem ${want}, mám ${got}: ${turn.text}`); }
}
console.log(bad ? `${bad}/${cases.length} zlyhalo` : `${cases.length} prípadov v poriadku`);
process.exit(bad ? 1 : 0);
