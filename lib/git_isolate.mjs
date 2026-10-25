// Izolácia testov od globálneho git configu (úloha 570): globálny
// core.hooksPath roota by commity v dočasných repách pustil cez cudzí hook.
// Import ako prvý v teste, ktorý spúšťa git. Potomkovia dedia premennú.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "gitcfg-"));
const file = join(dir, "gitconfig");
writeFileSync(file, "");
process.env.GIT_CONFIG_GLOBAL = file;
process.env.GIT_CONFIG_NOSYSTEM = "1";
