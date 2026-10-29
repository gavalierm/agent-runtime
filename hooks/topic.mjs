#!/usr/bin/env node
// topic.mjs — agent vedie viac tém naraz, každú v jednom vlákne (rozhodnutie
// z 16. 10. 2026). Nahradil single_session.mjs, ktorý púšťal k zápisu len
// poslednú spustenú reláciu.
//
//   start    SessionStart z .claude/settings.json repa. Po /clear dá novej
//            relácii tému predchádzajúcej relácie toho istého procesu
//            Claude Code (CLAUDE_PID sa pri /clear nemení, ID relácie áno).
//            Povie relácii jej tému, alebo že ju má určiť, a pridá zoznam.
//   check    PreToolUse pre všetky nástroje. Relácii bez témy alebo s témou,
//            ktorú drží iná relácia, povolí len nástroje z READ_ONLY
//            a príkaz `node <repo kódu>/hooks/topic.mjs set|list|whoami`. Relácii
//            s témou zamietne git príkazy, ktoré v zdieľanom checkoute
//            zahodia prácu inej relácie. Zamietne aj zápis do súboru, ktorý
//            si v sekcii "## Súbory témy" svojho súboru v pamäti vyhradila
//            iná téma (16. 10. 2026: relácia nesmie skĺznuť do práce
//            inej témy, napríklad z webového projektu do refaktoru kánonu).
//   set X    Spustí relácia cez Bash. Tému X priradí relácii
//            z CLAUDE_CODE_SESSION_ID. Keď tému drží relácia, ktorej proces
//            ešte beží, treba `set X --take`, použije sa, keď operátor
//            výslovne povie, že tému chce v tomto vlákne.
//   list     Vypíše témy, kto ich drží a čo v nich čaká na operátora.
//   whoami   Vypíše tému relácie z CLAUDE_CODE_SESSION_ID.
//
// Stav je v .scratch/topics hlavného checkoutu repa agenta (aj z worktree):
// sessions/<id> téma relácie, locks/<téma> ID držiteľa, pids/<id> PID
// procesu Claude Code. Stav témy pre ďalšiu reláciu je v
// memory/topics/<téma>.md, sekcia "## Čaká na <operátor>" (AGENT_OPERATOR_NAME
// v genitíve, inak "operátora") sa zbiera do list.
// Premenná TOPIC_STATE_DIR mení priečinok stavu, TOPIC_MEMORY_DIR priečinok pamäte,
// používa ich test. Hook je fail-closed: bez ID relácie zamietne a príkaz
// v settings.json končí `|| exit 2`, keď node chýba alebo hook spadne.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_REPO } from "./agent_repo.mjs";
import { SHARED_GIT, SHARED_GIT_MESSAGE, SHARED_GIT_POSTUP, hooksBypass, HOOKS_BYPASS_MESSAGE, HOOKS_BYPASS_POSTUP } from "./shared_git.mjs";
import { denyTool } from "../lib/deny.mjs";
import { operatorForms } from "../lib/agent_env.mjs";

const OP = operatorForms();

// Stav a pamäť sú v hlavnom checkoute repa agenta (REPO, hooks/agent_repo.mjs),
// aj z jeho worktree. HERE je checkout repa pravidiel, v ktorom leží tento súbor.
const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = AGENT_REPO;
// Príkaz, ktorým relácia volá tento hook, s absolútnou cestou.
const SELF = `node ${join(HERE, "hooks/topic.mjs")}`;
// Koreň hlavného checkoutu alebo ktoréhokoľvek jeho worktree. Vyhradenie
// súboru témy platí vo všetkých, IN_REPO vráti cestu v repe ako skupinu 1.
const ANY_CHECKOUT = `${REPO.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/\\.worktrees/[^/]+)?`;
const IN_REPO = new RegExp(`^${ANY_CHECKOUT}/(.+)$`);
export const STATE = process.env.TOPIC_STATE_DIR || join(REPO, ".scratch", "topics");
const MEMORY = process.env.TOPIC_MEMORY_DIR || join(REPO, "memory");
// Nástroje, ktoré nič nemenia. Všetko ostatné, aj MCP, Monitor, SendMessage
// a EnterWorktree, potrebuje tému. Agent je tu, lebo sub-agent má ID relácie
// rodiča a jeho nástroje prejdú tým istým hookom.
const READ_ONLY = new Set([
  "Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "ToolSearch", "Skill", "AskUserQuestion",
  "TodoWrite", "ListAgents", "ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool",
  "Agent", "Task", "TaskOutput", "LSP",
  "mcp__svelte__get-documentation", "mcp__svelte__list-sections",
  "mcp__claude_ai_Claude_Docs__guide", "mcp__claude_ai_Claude_Docs__query", "mcp__claude_ai_Claude_Docs__read",
]);
const NAME = /^[a-z][a-z0-9_]{1,40}$/;
// Príkazy, ktoré smie relácia spustiť aj bez témy, presne v tomto tvare.
// Cesta je relatívna alebo absolútna cesta tohto súboru, nič iné, inak by
// "$(príkaz)/hooks/topic.mjs" alebo cudzí topic.mjs obišli zámok.
const OWN_ARGS = /^(?:set [a-z][a-z0-9_]{1,40}(?: --take)?|list|whoami)$/;
// Aj tvar s ~ namiesto domova, tak ho píše CLAUDE.md agenta.
const tildeOf = (p) => (process.env.HOME && p.startsWith(process.env.HOME + "/") ? `~${p.slice(process.env.HOME.length)}` : p);
const OWN_PATHS = ["hooks/topic.mjs", "./hooks/topic.mjs", ...[...new Set([REPO, HERE])].flatMap((r) => [join(r, "hooks/topic.mjs"), `"${join(r, "hooks/topic.mjs")}"`, tildeOf(join(r, "hooks/topic.mjs"))])];
export function isOwn(cmd) {
  if (typeof cmd !== "string" || /[^ -~]/.test(cmd)) return false; // len tlačiteľné ASCII, žiadny nový riadok
  const m = cmd.trim().match(/^node ([^ ]+) (.+)$/);
  return Boolean(m && OWN_PATHS.includes(m[1]) && OWN_ARGS.test(m[2]));
}
const read = (p) => {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
};
const write = (p, text) => {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, text + "\n");
  renameSync(tmp, p);
};
const safeId = (id) => /^[A-Za-z0-9-]{8,80}$/.test(id || "");
const safePid = (pid) => /^[0-9]{1,10}$/.test(pid || "");
const pidOf = (id) => (safeId(id) ? read(join(STATE, "pids", id)) : "");
const alive = (pid) => {
  if (!safePid(pid)) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

export const topicOf = (id) => (safeId(id) ? read(join(STATE, "sessions", id)) : "");
export const holderOf = (topic) => (NAME.test(topic) ? read(join(STATE, "locks", topic)) : "");
// Téma, v ktorej relácia smie písať, alebo "".
export const activeTopic = (id) => {
  const t = topicOf(id);
  return t && holderOf(t) === id ? t : "";
};

// Vzájomné vylúčenie pre čítanie a zápis zámku témy. mkdir je atomický,
// zámok starší ako 5 s patrí procesu, ktorý spadol.
function exclusive(topic, fn) {
  const m = join(STATE, "mutex", topic);
  mkdirSync(dirname(m), { recursive: true });
  const until = Date.now() + 3000;
  for (;;) {
    try {
      mkdirSync(m);
      break;
    } catch {
      try {
        if (Date.now() - statSync(m).mtimeMs > 5000) rmdirSync(m);
      } catch {}
      if (Date.now() > until) throw new Error(`zámok témy ${topic} je obsadený`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(m);
  }
}

function claim(id, topic, pid) {
  if (safePid(pid)) write(join(STATE, "pids", id), pid);
  write(join(STATE, "sessions", id), topic);
  write(join(STATE, "locks", topic), id);
}

// Po /clear: téma predchádzajúcej relácie toho istého procesu.
export function inherit(id, source, pid) {
  if (source !== "clear" || !safeId(id) || !safePid(pid) || topicOf(id)) return "";
  const dir = join(STATE, "locks");
  if (!existsSync(dir)) return "";
  for (const t of readdirSync(dir)) {
    const holder = read(join(dir, t));
    if (NAME.test(t) && holder && holder !== id && pidOf(holder) === pid) {
      const won = exclusive(t, () => {
        if (holderOf(t) !== holder) return false;
        claim(id, t, pid);
        return true;
      });
      if (won) return t;
    }
  }
  return "";
}

// Súbory, ktoré si témy vyhradili: cesta relatívna k repu -> téma. Riadok
// sekcie "## Súbory témy" je "- `cesta`", cesta s lomkou na konci je priečinok.
export function owners() {
  const dir = join(MEMORY, "topics");
  const map = new Map();
  if (!existsSync(dir)) return map;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const m = read(join(dir, f)).match(/^## Súbory témy\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
    if (!m) continue;
    for (const l of m[1].split("\n")) {
      const p = l.match(/^- `([^`]+)`/);
      if (p) map.set(p[1].replace(/^\.\//, ""), f.slice(0, -3));
    }
  }
  return map;
}
const BASH_WRITE = /(?:^|[\s;&|(])(?:sed\s+-i|perl\s+-[a-z]*i|tee|mv|cp|rm|truncate|python3?|node)\b|>/;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// [súbor, téma], keď nástroj zapisuje do súboru inej témy, inak null.
export function foreignOwner(topic, tool, inp) {
  const own = owners();
  const rel = (p) => (typeof p !== "string" ? "" : (p.match(IN_REPO)?.[1] ?? p.replace(/^\.\//, "")));
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const path = rel(inp.file_path || inp.notebook_path);
    for (const [o, t] of own) if (t !== topic && (o.endsWith("/") ? path.startsWith(o) : path === o)) return [o, t];
  }
  if (tool === "Bash" && BASH_WRITE.test(inp.command || "")) {
    const cmd = inp.command;
    for (const [o, t] of own)
      if (t !== topic && (new RegExp(`${ANY_CHECKOUT}/${escape(o)}`).test(cmd) || new RegExp(`(?:^|[\\s'"=])(?:\\./)?${escape(o)}`).test(cmd))) return [o, t];
  }
  return null;
}

// Vráti [dôvod, správny postup] alebo null.
export function verdict({ session_id: id, tool_name: tool, tool_input: inp = {} }) {
  if (READ_ONLY.has(tool)) return null;
  if (!safeId(id))
    return [
      `Hook topic.mjs nedostal ID relácie a zápis zamieta. Povedz to ${OP.dat}.`,
      `oznám ${OP.dat}, že hook topic.mjs nedostal ID relácie (chyba nastavenia hooku v settings.json), kým ho neopraví, zápis nepôjde`,
    ];
  if (tool === "Bash" && isOwn(inp.command)) return null;
  const topic = topicOf(id);
  if (!topic)
    return [
      `Táto relácia nemá tému. Pred prvým zápisom alebo príkazom ju urči: \`${SELF} set <tema>\`, meno snake_case. Existujúce témy vypíše \`${SELF} list\`. Keď tému nevieš zo správy ${OP.gen}, spýtaj sa ho.`,
      `\`${SELF} set <tema>\` (meno snake_case, existujúce témy vypíše \`${SELF} list\`), potom prečítaj memory/topics/<tema>.md`,
    ];
  const holder = holderOf(topic);
  if (holder !== id)
    return [
      `Tému ${topic} prevzala iná relácia (${holder.slice(0, 8) || "nikto"}). Táto relácia v nej už nezapisuje ani nedáva pokyny. Povedz to ${OP.dat}, alebo si vezmi inú tému príkazom \`${SELF} set <tema>\`.`,
      `\`${SELF} set <tema>\` s inou témou (zoznam \`${SELF} list\`), alebo ukonči ťah a povedz ${OP.dat}, že tému ${topic} drží iná relácia`,
    ];
  if (tool === "Bash" && SHARED_GIT.test(inp.command || ""))
    return [SHARED_GIT_MESSAGE, SHARED_GIT_POSTUP];
  if (tool === "Bash" && hooksBypass(inp.command || ""))
    return [HOOKS_BYPASS_MESSAGE, HOOKS_BYPASS_POSTUP];
  const f = foreignOwner(topic, tool, inp);
  if (f)
    return [
      `\`${f[0]}\` patrí téme ${f[1]}, táto relácia má tému ${topic}. Prácu inej témy nerob, zapíš ju do memory/topics/${f[1]}.md do sekcie Otvorené a vráť sa k svojej téme.`,
      `zapíš prácu do memory/topics/${f[1]}.md do sekcie Otvorené a vráť sa k téme ${topic}`,
    ];
  return null;
}

export function decide(input) {
  return verdict(input)?.[0] ?? null;
}

function waiting(topic) {
  const text = read(join(MEMORY, "topics", `${topic}.md`));
  const m = text.match(new RegExp(`^## Čaká na ${OP.gen}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
  return m ? m[1].split("\n").filter((l) => l.startsWith("- ")) : [];
}

export function list() {
  const topics = new Set();
  for (const d of [join(STATE, "locks"), join(MEMORY, "topics")]) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      const t = f.replace(/\.md$/, "");
      if (NAME.test(t)) topics.add(t);
    }
  }
  const out = [];
  for (const t of [...topics].sort()) {
    const lock = join(STATE, "locks", t);
    const holder = read(lock);
    const when = holder ? statSync(lock).mtime.toISOString().slice(0, 16).replace("T", " ") : "";
    const state = holder ? `relácia ${holder.slice(0, 8)} od ${when} UTC${alive(pidOf(holder)) ? "" : ", proces nebeží"}` : "nikto";
    const file = existsSync(join(MEMORY, "topics", `${t}.md`)) ? `memory/topics/${t}.md` : "bez súboru stavu";
    out.push(`${t}: ${state}, ${file}`);
    for (const w of waiting(t)) out.push(`  ${w}`);
  }
  return out.length ? out.join("\n") : "Žiadna téma.";
}

function cli(cmd, arg, flag) {
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  const pid = process.env.CLAUDE_PID;
  if (cmd === "list") return console.log(list());
  if (!safeId(id)) {
    console.error("Chýba CLAUDE_CODE_SESSION_ID, príkaz beží len v relácii Claude Code.");
    process.exit(1);
  }
  if (cmd === "whoami") return console.log(activeTopic(id) || "bez témy");
  if (cmd !== "set" || !NAME.test(arg || "") || (flag && flag !== "--take")) {
    console.error(`Použitie: ${SELF} set <tema> [--take] | list | whoami. Téma je snake_case, 2 až 41 znakov.`);
    process.exit(1);
  }
  // Kontrola držiteľa a zápis bežia pod zámkom, dva súbežné set tej istej
  // témy sa zoradia a druhý vidí prvého ako držiteľa.
  const before = exclusive(arg, () => {
    const b = holderOf(arg);
    const busy = b && b !== id && alive(pidOf(b)) && pidOf(b) !== pid;
    if (busy && flag !== "--take") return { busy: b };
    claim(id, arg, pid);
    return b;
  });
  if (before?.busy) {
    console.error(
      `Tému ${arg} drží relácia ${before.busy.slice(0, 8)}, ktorej vlákno ešte beží. Prevezmi ju len, keď ${OP.nom} výslovne chce tému v tomto vlákne: ${SELF} set ${arg} --take`,
    );
    process.exit(1);
  }
  const file = join(MEMORY, "topics", `${arg}.md`);
  console.log(`Téma ${arg} patrí relácii ${id.slice(0, 8)}.`);
  if (before && before !== id) console.log(`Prevzatá od relácie ${before.slice(0, 8)}, tá v nej už nezapisuje.`);
  console.log(existsSync(file) ? `Stav témy: memory/topics/${arg}.md, prečítaj ho.` : `Nová téma, stav zapíš do memory/topics/${arg}.md.`);
}

const main = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) {
  const [cmd, arg, flag] = process.argv.slice(2);
  if (cmd === "start" || cmd === "check") {
    let input = {};
    try {
      input = JSON.parse(readFileSync(0, "utf8"));
    } catch {}
    if (cmd === "start") {
      const inherited = inherit(input.session_id, input.source, process.env.CLAUDE_PID);
      const topic = activeTopic(input.session_id);
      const head = topic
        ? `${inherited ? `Po /clear pokračuje téma ${topic} z predchádzajúcej relácie tohto vlákna. ` : ""}Téma tejto relácie je ${topic}, stav je v memory/topics/${topic}.md, prečítaj ho. Ohlás ju v prvej odpovedi riadkom \`téma: ${topic}\`.`
        : `Táto relácia nemá tému, zápis a príkazy zamietne hook topic.mjs. Tému urč zo správy ${OP.gen} a nastav ju ako prvý krok príkazom \`${SELF} set <tema>\`, potom prečítaj memory/topics/<tema>.md, ak existuje, a v odpovedi ohlás riadok \`téma: <tema>\`. Keď správa tému neurčuje, spýtaj sa ${OP.gen}.`;
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `${head}\nTémy:\n${list()}` } }),
      );
    } else {
      const v = verdict(input);
      if (v) denyTool(v[0], v[1]);
    }
  } else cli(cmd, arg, flag);
}
