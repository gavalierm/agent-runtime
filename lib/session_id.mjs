// ID relácie vlákna T3 pre clear_bridge.mjs a kontext.mjs. T3 0.1.0 spúšťa
// proces claude s --resume na ID z prvého štartu vlákna, to sa /clear
// nemení, preto je stále aj pre odovzdávku čistého kontextu.
//
// Reťaz relácií vlákna (úloha 656): po druhom /clear je predošlý prepis
// obyčajný súbor bez väzby na novú reláciu. clear_bridge.mjs preto zapíše
// všetky id vlákna do `<pôvodné id>.sessions` (recordChain) a tasker_work.mjs
// podľa nich pozná vlastnú starú reláciu (chainedSessions).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Pôvodné ID relácie z príkazového riadku najbližšieho predka claude.
export function originalId(pid = process.ppid) {
  for (let i = 0; i < 6 && pid > 1; i++) {
    let args = [];
    try { args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { return null; }
    for (let j = 0; j < args.length; j++) {
      const m = args[j].match(/^--(?:resume|session-id)=(.+)$/);
      const v = m ? m[1] : (args[j] === "--resume" || args[j] === "--session-id") ? args[j + 1] : null;
      if (v && ID.test(v)) return v;
    }
    try {
      pid = Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[1]);
    } catch { return null; }
  }
  return null;
}

const SUFFIX = ".sessions";

// Pridá id do `<dir>/<originalId>.sessions` (jedno na riadok, bez duplicít, súbor vytvorí).
export function recordChain(dir, originalId, ids) {
  const file = join(dir, `${originalId}${SUFFIX}`);
  let known = [];
  try { known = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean); } catch {}
  const all = [...known];
  for (const id of ids ?? []) {
    const v = String(id ?? "").trim();
    if (v && !all.includes(v)) all.push(v);
  }
  writeFileSync(file, all.length ? `${all.join("\n")}\n` : "");
  return all;
}

// Množina id zo všetkých `*.sessions` v dir, ktoré id obsahujú alebo ktorých názov je id
// (vrátane názvu). Chyba čítania: prázdna množina.
export function chainedSessions(dir, id) {
  const out = new Set();
  const want = String(id);
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(SUFFIX)) continue;
      const name = f.slice(0, -SUFFIX.length);
      let ids = [];
      try { ids = readFileSync(join(dir, f), "utf8").split("\n").map((l) => l.trim()).filter(Boolean); } catch { continue; }
      if (name !== want && !ids.includes(want)) continue;
      out.add(name);
      for (const i of ids) out.add(i);
    }
  } catch { return new Set(); }
  return out;
}
