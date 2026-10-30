#!/usr/bin/env node
// Testy project_data.mjs. Prvé dva prípady sú príkazy z incidentov
// 16. a 17. 10. 2026.

import { verdict } from "./project_data.mjs";

const cases = [
  ["gh repo clone example-org/webproject-web scratch/kubo/web", true],
  ["git clone git@github.com:example-org/x.git scratch/x", true],
  ['cp "$HOME/Desktop/jakub stranka.zip" scratch/clientsite_zaloha/jakub_stranka.zip', true],
  ["mkdir -p scratch/x && unzip -q ~/Downloads/a.zip -d scratch/x", true],
  ["cp scratch/a.json scratch/b.json", false],
  ["cat > scratch/adam.json <<'X'\n{}\nX", false],
  ["git clone git@github.com:example-org/x.git myscratch/x", false],
  ["git clone git@github.com:example-org/clientsite-archiv.git ~/Work/vyvoj/clientsite/clientsite-archiv", false],
  ["ls ~/Desktop", false],
];
let bad = 0;
for (const [cmd, want] of cases) {
  const got = Boolean(verdict(cmd));
  if (got !== want) { bad++; console.log(`✗ chcem ${want}, mám ${got}: ${cmd}`); }
}
console.log(bad ? `${bad}/${cases.length} zlyhalo` : `${cases.length} prípadov v poriadku`);
process.exit(bad ? 1 : 0);
