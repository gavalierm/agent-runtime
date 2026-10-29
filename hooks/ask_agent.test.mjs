#!/usr/bin/env node
// Test bin/ask_agent.sh --replies a hostu ssh. Všetko v dočasnom adresári
// (ASK_VAR_LIB), ssh je atrapa v PATH, ktorá spustí príkaz lokálne. Živá
// schránka ani skutočné ssh sa nedotkne.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "ask_agent.sh");
const tmp = mkdtempSync(join(tmpdir(), "ask-agent-"));
const cases = [];
try {
  const bin = join(tmp, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), `#!/bin/bash\necho "$1" >> "${tmp}/ssh.log"\nbash -c "$2"\n`);
  chmodSync(join(bin, "ssh"), 0o755);
  const lib = join(tmp, "lib");
  const inbox = join(lib, "cyril", "inbox");
  mkdirSync(inbox, { recursive: true }); mkdirSync(join(lib, "cyril", "processed"));
  const msg = (name, tema) => writeFileSync(join(inbox, name), `odpoveď: na vedomie\nid: ${name}\nod: adam\nkomu: cyril\ntéma: ${tema}\nk: x\n\ntext ${name}\n`);
  msg("adam-spravy-1-1.md", "spravy");       // odpoveď --k bola v starom tvare bez témy v názve
  msg("adam-20261020-111.md", "spravy");     // názov bez témy, téma v hlavičke
  msg("adam-ina-2-2.md", "ina");             // iná téma
  msg("adam-3-3.md", "");                    // hlavné vlákno
  const run = (args, extra = {}) => spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ASK_VAR_LIB: lib, AGENT_NAME: "cyril", ASK_HOST: "", ADAM_HOST: "", BORIS_HOST: "", ASK_TOPIC: "", ...extra },
  });
  const r = run(["--replies"], { ASK_HOST: "x@y", ASK_TOPIC: "spravy" });
  cases.push([r.status, 0]);
  cases.push([/text adam-spravy-1-1\.md/.test(r.stdout) && /text adam-20261020-111\.md/.test(r.stdout), true]);
  cases.push([/text adam-3-3\.md/.test(r.stdout), true]);
  cases.push([/text adam-ina-2-2\.md/.test(r.stdout), false]);
  cases.push([existsSync(join(inbox, "adam-ina-2-2.md")), true]);
  cases.push([existsSync(join(inbox, "adam-spravy-1-1.md")), false]);
  // Mac (na stroji nie je žiadna schránka) bez ASK_HOST: skript nič nepošle a povie, čo nastaviť.
  const log = join(tmp, "ssh.log");
  rmSync(log, { force: true });
  const none = run(["--replies"], { ASK_HOST: "", ASK_VAR_LIB: join(tmp, "prazdny") });
  cases.push([none.status, 1]);
  cases.push([/ASK_HOST/.test(none.stderr), true]);
  cases.push([existsSync(log), false]);
  // Bez AGENT_NAME a ASK_FROM chýba odosielateľ.
  const nofrom = run(["--replies"], { ASK_HOST: "x@y", AGENT_NAME: "" });
  cases.push([nofrom.status, 1]);
  cases.push([/ASK_FROM/.test(nofrom.stderr), true]);
  // Adresát z ASK_URGENT_ONLY prijíma z Macu len súrne správy.
  const urgent = run(["boris", "tema", "text"], { ASK_HOST: "x@y", ASK_URGENT_ONLY: "boris" });
  cases.push([urgent.status, 1]);
  cases.push([/ASK_URGENT=1/.test(urgent.stderr), true]);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
let bad = 0;
for (const [got, want] of cases) if (got !== want) { bad++; console.log(`✗ chcem ${want}, mám ${got}`); }
console.log(bad ? `${bad}/${cases.length} zlyhalo` : `${cases.length} prípadov v poriadku`);
process.exit(bad ? 1 : 0);
