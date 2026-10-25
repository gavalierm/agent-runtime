// deny_check.mjs — strážca D0141 (úloha 424): hook nezamieta mimo lib/deny.mjs
// a lib/deny.sh, aby každé zamietnutie nieslo "Správny postup:".
//
//   denyProblems(root)  zoznam problémov repa v `root` (prázdny = v poriadku)
//
// Hľadá v hooks/*.mjs (bez testov, replay a deny.mjs) surové
// permissionDecision "deny", decision "block" a process.exit(2). V git
// hookoch (lib/*guard*.sh, lib/retired_names.sh, .githooks/*) hľadá echo alebo
// printf na stderr bez značky `# info`, exit 1 alebo 2 na riadku s echo
// a súbor, ktorý nastavuje kód odmietnutia (rc=1, status=1, bad=1), no nenačíta
// deny.sh alebo volá deny_postup s prázdnym postupom. Informačná poznámka
// hooku, ktorá nič neodmieta, nesie na konci riadka `# info`.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MJS_RAW = [
  [/permissionDecision["']?\s*:\s*["']deny["']/, 'surové permissionDecision "deny"'],
  [/\bdecision["']?\s*:\s*["']block["']/, 'surové decision "block"'],
  [/process\.exit\(\s*2\s*\)/, "surové process.exit(2)"],
  [/process\.exitCode\s*=\s*2\b/, "surové exitCode = 2"],
];
const SH_RAW = [
  [/^\s*(echo|printf)\b[^\n]*>&2(?![^\n]*#\s*info\s*$)/, "echo/printf na stderr mimo deny_postup (informačný riadok označ `# info`)"],
  [/\b(echo|printf)\b[^\n]*;\s*exit\s+[12]\b/, "echo s exit 1/2 mimo deny_postup"],
];
const REJECTS = /\b(rc|status|bad)=1\b/;

const code = (text) => text.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => !/^\s*(#|\/\/)/.test(l));

export function denyProblems(root) {
  const out = [];
  const hooks = join(root, "hooks");
  if (existsSync(hooks)) {
    for (const f of readdirSync(hooks).sort()) {
      if (!f.endsWith(".mjs") || /\.(test|replay)\.mjs$/.test(f)) continue;
      for (const [n, line] of code(readFileSync(join(hooks, f), "utf8")))
        for (const [re, what] of MJS_RAW) if (re.test(line)) out.push(`hooks/${f}:${n}: ${what}, použi lib/deny.mjs (denyTool, blockStop, exitDeny)`);
    }
  }
  const sh = [];
  const lib = join(root, "lib");
  if (existsSync(lib)) for (const f of readdirSync(lib).sort()) if (/guard.*\.sh$/.test(f) && !/\.test\.sh$/.test(f) || f === "retired_names.sh") sh.push(["lib/" + f, join(lib, f)]);
  const gh = join(root, ".githooks");
  if (existsSync(gh)) for (const f of readdirSync(gh).sort()) sh.push([".githooks/" + f, join(gh, f)]);
  for (const [name, path] of sh) {
    const text = readFileSync(path, "utf8");
    const lines = code(text);
    for (const [n, line] of lines)
      for (const [re, what] of SH_RAW) if (re.test(line)) out.push(`${name}:${n}: ${what}, použi deny_postup z lib/deny.sh`);
    for (const [n, line] of lines) {
      const m = line.match(/(?:^|[\s{(;&|])deny_postup\s+(.*)$/);
      if (!m) continue;
      const args = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"';&|)}]+)/g)].map((x) => x[1] ?? x[2] ?? x[3]);
      if (args.length < 2 || !args[1].trim()) out.push(`${name}:${n}: deny_postup bez správneho postupu`);
    }
    const rejects = lines.some(([, l]) => REJECTS.test(l));
    const uses = lines.some(([, l]) => /\bdeny_postup\b/.test(l));
    const sources = lines.some(([, l]) => /^\s*(source|\.)\s+.*deny\.sh/.test(l));
    if (rejects && !uses) out.push(`${name}: odmieta (rc/status/bad=1), no nevolá deny_postup z lib/deny.sh`);
    if (uses && !sources) out.push(`${name}: volá deny_postup, no nenačíta lib/deny.sh (source)`);
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("deny_check.mjs")) {
  const root = process.argv[2] || new URL("..", import.meta.url).pathname;
  const p = denyProblems(root);
  for (const l of p) console.log(l);
  process.exit(p.length ? 1 : 0);
}
