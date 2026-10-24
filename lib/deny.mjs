// deny.mjs — jediné miesto, ktoré hook použije na zamietnutie
// (D0141, úloha 424). Zamietnutie bez konkrétneho správneho postupu model
// donúti hádať a skúšať znova, každý pokus stojí volanie s celým kontextom.
// Helper preto vyžaduje neprázdny postup (príkaz, skript alebo súbor, nie
// "skús inak") a vypíše dôvod a riadok "Správny postup: <krok>".
// Strážca: lib/deny_check.mjs repa pravidiel (D0141, úloha 424), ten kontroluje aj hooky tohto repa.

export const LABEL = "Správny postup:";

const VAGUE = /^(skús|skus|try)\s+(inak|znova|again|otherwise)\.?$/i;

// Dôvod a postup v jednom texte. Prázdny alebo nejasný postup hodí chybu.
export function withPostup(reason, postup) {
  const r = String(reason ?? "").trim();
  const p = String(postup ?? "").trim();
  if (!r) throw new Error("deny: chýba dôvod zamietnutia");
  if (!p || VAGUE.test(p)) throw new Error("deny: chýba správny postup (príkaz, skript alebo súbor)");
  return `${r}\n${LABEL} ${p}`;
}

// PreToolUse: JSON s permissionDecision deny na stdout, hook potom skončí kódom 0.
export function denyTool(reason, postup, out = process.stdout) {
  out.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: withPostup(reason, postup),
      },
    }),
  );
}

// Stop a SubagentStop: JSON s decision block na stdout.
export function blockStop(reason, postup, log = console.log) {
  log(JSON.stringify({ decision: "block", reason: withPostup(reason, postup) }));
}

// Hook, ktorý zamieta cez stderr a kód 2.
export function exitDeny(reason, postup, exit = process.exit) {
  const text = withPostup(reason, postup);
  process.stderr.write(text + "\n");
  exit(2);
}
