// doc_paths.mjs — odkaz na súbor v pokynoch agenta musí ukazovať na súbor,
// ktorý existuje. Zastaraný odkaz, napríklad na zmazaný skript, dá agentovi
// po čistom kontexte pokyn, ktorý neplatí (DECISIONS.md 2026-10-15,
// "zastarané pokyny blokuje kontrola").
//
// Číta cesty a mená súborov v spätných apostrofoch. Cesta s lomkou sa hľadá
// voči priečinku dokumentu, koreňu repa a koreňom v `roots`. Holé meno
// súboru s príponou stačí nájsť kdekoľvek v `roots`. Cesty servera
// (/root, /opt, /home, /var, /etc ...) z Macu overiť nejde, overí sa len
// ich meno súboru. Preskočí príkazy s lomkou (`/clear`), zástupné mená
// (RRRR, <meno>, *) a úseky medzi `<!-- doc_paths: off -->`
// a `<!-- doc_paths: on -->`, napríklad zoznam zamietnutých návrhov.
// Riadok, ktorý zmazanú vec spomína zámerne, nesie slovo "zmazan", "zrušen"
// alebo "neexistuj". Riadok o súbore v kontajneri nesie slovo "kontajner".
//
//   node lib/doc_paths.mjs <repo> [koreň ...]   kód 1 pri zastaranom odkaze
// Na serveri ho volá hook pre-commit agenta, napríklad
//   node /opt/agentic-workflow/lib/doc_paths.mjs /root/adam /root/boris /opt/agentic-workflow
//
// Druhá kontrola: tvrdenie, ktoré rozhodnutie zrušilo, nesmie ostať v pokynoch
// ani v pamäti. Vzory sú v `retired_claims.txt` vedľa skriptu, riadok je
// regulárny výraz, tabulátor a dôvod. Kto zruší tvrdenie, pridá jeho vzor
// (rozhodnutie zo 16. 10. 2026, "zrušené tvrdenie blokuje kontrola").

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDir, zrusenaTvrdenia } from "./rozhodnutia.mjs";

const OWNER_REPO = process.env.AGENT_GH_OWNER ? new RegExp(`^${process.env.AGENT_GH_OWNER.replace(/[^\w-]/g, "")}/`) : null;
const SERVER = /^\/(root|opt|home|var|etc|usr|srv|tmp|run)\//;
const EXT = /\.(sh|mjs|js|py|service|timer|conf|json)$/;
const HISTORY = /zmazan|zrušen|neexistuj|kontajner/i;
const PLACEHOLDER = /[*<>${}|?\[\]"]|RRRR|YYYY|MMDD|HHMMSS|\bmeno\b|nazov|\.\.\.|^\.\.\/|@/;
const SKIP_DIRS = new Set([".git", ".scratch", "node_modules", "vendor", "build", "dist", ".svelte-kit", "archiv", ".worktrees"]);

export function indexNames(roots, depth = 5) {
  const names = new Set();
  const walk = (dir, d) => {
    if (d > depth) return;
    let list;
    try { list = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (SKIP_DIRS.has(e.name)) continue;
      names.add(e.name);
      if (e.isDirectory()) walk(join(dir, e.name), d + 1);
    }
  };
  for (const r of roots) walk(r, 0);
  return names;
}

function candidates(text) {
  const out = [];
  let off = false;
  for (const [i, line] of text.split("\n").entries()) {
    if (line.includes("<!-- doc_paths: off -->")) off = true;
    if (line.includes("<!-- doc_paths: on -->")) off = false;
    if (off || HISTORY.test(line)) continue;
    for (const m of line.matchAll(/`([^`\s]+)`/g)) {
      const p = m[1].replace(/[),.:;]+$/, "");
      if (PLACEHOLDER.test(p) || /^[a-z]+:|^https?:|^-|=/.test(p)) continue;
      if (/^\/[^/]+$/.test(p)) continue; // príkaz s lomkou
      if (OWNER_REPO && OWNER_REPO.test(p)) continue; // repo na GitHube
      if (/^\.[^/]*$|^origin\//.test(p)) continue; // skrytý súbor, vetva gitu
      if (/(^|\/)settings\.local\.json$/.test(p)) continue; // lokálne nastavenie mimo gitu, zakladá ho install
      if (/(^|\/)\.claude\/settings\.json$/.test(p)) continue; // nastavenie agenta v jeho repe, vzniká nasadením
      if (/^t3code(-\w+)?\.service$/.test(p)) continue; // jednotka servera T3, nie z tohto repa
      if (/^~\/\.local\/state\//.test(p)) continue; // stav za behu (register chýb), vznikne pri prvom zápise
      if (/^(topics|inflight|rotation|routes|supervise|clear_watch)\.json$/.test(p)) continue; // stavové súbory budiča, vznikajú za behu v schránke a v stave agenta
      const slash = p.replace(/\/$/, "").includes("/");
      // Súbor agenta má príponu skriptu alebo konfigurácie. Cesta bez nej je
      // príklad pomenovania (`vyvoj/klient/klient_web/`), tá sa neoveruje.
      if (!EXT.test(p) && !/^~\/|^\/Users\//.test(p)) continue;
      out.push({ line: i + 1, path: p, slash });
    }
  }
  return out;
}

function found(c, bases, names, home) {
  const p = c.path.replace(/\/$/, "");
  if (SERVER.test(p)) return names.has(basename(p)) || !/\.(sh|mjs|py|service|timer)$/.test(p);
  // Cesta ~/ v pokynoch je cesta na Macu operátora, na serveri sa neoverí.
  if (p.startsWith("~/")) return !existsSync(join(home, "Work")) || existsSync(join(home, p.slice(2)));
  if (p.startsWith("/")) return existsSync(p);
  if (!c.slash) return names.has(p);
  return bases.some((b) => existsSync(join(b, p)));
}

// Zdroje: ručný zoznam retired_claims.txt a zrušené záznamy rozhodnutí
// (priečinok ROZHODNUTIA_DIR, inak decisionsDir()).
export function retiredClaims(file = join(dirname(fileURLToPath(import.meta.url)), "retired_claims.txt"), dir = defaultDir()) {
  const rucne = !existsSync(file) ? [] : readFileSync(file, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => {
    const [re, why = ""] = l.split("\t");
    return { re: new RegExp(re, "i"), why };
  });
  return [...rucne, ...zrusenaTvrdenia(dir)];
}

// `local(p)` vráti true pre súbor, ktorý nie je v gite a leží len v hlavnom
// checkoute, napríklad `.claude/settings.local.json`. Check vo worktree ho
// cez neho nájde, inak by odkaz na lokálny súbor hlásil ako zastaraný.
export function stalePaths(files, roots, home, claims = retiredClaims(), local = () => false) {
  const names = indexNames(roots);
  const problems = [];
  for (const f of files) {
    let off = false;
    for (const [i, line] of readFileSync(f, "utf8").split("\n").entries()) {
      if (line.includes("<!-- doc_paths: off -->")) off = true;
      if (line.includes("<!-- doc_paths: on -->")) off = false;
      if (off) continue;
      for (const c of claims) if (c.re.test(line)) problems.push(`${f}:${i + 1} zrušené tvrdenie, ${c.why}`);
    }
  }
  for (const f of files) {
    const bases = [dirname(f), ...roots];
    for (const c of candidates(readFileSync(f, "utf8"))) {
      if (!found(c, bases, names, home) && !local(c.path)) problems.push(`${f}:${c.line} \`${c.path}\` neexistuje`);
    }
  }
  return problems;
}

// Pokyny agenta: persona, súbory runtime, kánon, README, pamäť, tests/README.
// DECISIONS.md je história a skilly sú všeobecné postupy, tie sa nečítajú.
export function agentDocs(repo) {
  const top = ["PERSONA.md", "CLAUDE.md", "RULES.md", "AGENTS.md", "README.md", "STRUCTURE.md", "WORKFLOW.md", "BLUEPRINT.md",
    "work/CLAUDE.md", "tests/README.md", "roles/ROLES.md", "roles/agents.md", "env/mac/RULES.md", "env/mac/STRUCTURE.md",
    "env/mac/WORKFLOW.md", "env/mac/BLUEPRINT.md", "env/server/RULES.md",
    "artifacts/dashboard-playbook/PLAYBOOK.md", "artifacts/dashboard-playbook/reference/anti-slop-design.md"];
  const out = top.map((n) => join(repo, n)).filter(existsSync);
  const rolesDir = join(repo, "roles");
  if (existsSync(rolesDir)) for (const n of readdirSync(rolesDir)) if (n.endsWith(".md") && !top.includes(`roles/${n}`)) out.push(join(rolesDir, n));
  const mem = join(repo, "memory");
  if (existsSync(mem)) for (const n of readdirSync(mem)) if (n.endsWith(".md")) out.push(join(mem, n));
  return out;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [repo, ...rest] = process.argv.slice(2);
  if (!repo) { console.error("použitie: node doc_paths.mjs <repo> [koreň ...]"); process.exit(2); }
  const problems = stalePaths(agentDocs(repo), [repo, ...rest], process.env.HOME || "");
  for (const p of problems) console.error(`zastaraný odkaz: ${p}`);
  process.exit(problems.length ? 1 : 0);
}
