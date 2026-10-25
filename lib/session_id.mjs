// ID relácie vlákna T3 pre clear_bridge.mjs a kontext.mjs. T3 0.1.0 spúšťa
// proces claude s --resume na ID z prvého štartu vlákna, to sa /clear
// nemení, preto je stále aj pre odovzdávku čistého kontextu.
import { readFileSync } from "node:fs";

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
