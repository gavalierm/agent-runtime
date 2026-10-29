#!/usr/bin/env node
// Kľúče prepusteného agenta na agent-cyril a agent-boris (16. 10. 2026).
import { staleKeys } from "./deploy_keys.mjs";
const living = ["cyril", "adam", "boris", "teo"];
const cases = [
  [staleKeys("agent-cyril", [{ id: 1, title: "nex@examplehost", read_only: false }], living).length, 1],
  [staleKeys("agent-boris", [{ id: 2, title: "nexo@examplehost", read_only: false }], living).length, 1],
  [staleKeys("agent-boris", [{ id: 3, title: "boris@examplehost", read_only: false }], living).length, 0],
  [staleKeys("agent-cyril", [{ id: 4, title: "examplehost read-only", read_only: true }], living).length, 0],
  [staleKeys("agent-adam", [{ id: 5, title: "pc-gma adam rw", read_only: false }], living).length, 0],
  [staleKeys("agent-adam", [{ id: 6, title: "pc-gma teon rw", read_only: false }], living).length, 1],
];
let bad = 0;
for (const [got, want] of cases) if (got !== want) { bad++; console.log(`✗ chcem ${want}, mám ${got}`); }
console.log(bad ? `${bad}/${cases.length} zlyhalo` : `${cases.length} prípadov v poriadku`);
process.exit(bad ? 1 : 0);
