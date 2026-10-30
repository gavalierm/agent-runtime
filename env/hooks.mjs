#!/usr/bin/env node
// hooks.mjs: jediná tabuľka hookov relácie claude. Z nej sa píše hooks a pár
// ďalších kľúčov do settings.json na serveri (root, používateľ behov správcu
// úloh) aj na Macu; env/server/install.sh a env/mac/install.sh nemajú vlastný
// zoznam hookov. Zmena hooku (udalosť, matcher, timeout, kde beží) sa robí tu a
// jedným spustením install.sh platí na všetkých strojoch.
//
// Riadok tabuľky: súbor hooku, udalosť, matcher (null = bez matchera), timeout
// v sekundách (null = predvolený), requires (musí sedieť s druhým riadkom
// `// requires:` v hooks/<súbor>, kontrola je v check.mjs a v env/hooks.test.mjs),
// kde beží. Meno súboru bez lomky je v hooks/. Cesta s lomkou, napríklad
// brain/bin/repeat_guard.mjs, je od koreňa klonu a nemá hlavičku requires, lebo
// ten istý súbor ide aj do samostatnej kópie mozgu; kontrola overí len jeho
// existenciu. V args je {brain} cesta spoločného mozgu (AGENT_BRAIN_GLOBAL) a
// {machine} je server pre main a runs, mac pre mac. Druhy:
//   main   interaktívne relácie na serveri (root)
//   runs   behy správcu úloh pod používateľom behov
//   mac    interaktívne relácie na Macu
//   agent  hook, ktorý si zapína repo agenta vo vlastnom .claude/settings.json
//          (napríklad schránka agenta na Macu); generátor ho pre main, runs
//          a mac nezapíše, tabuľka ho vedie pre evidenciu a kontrolu
// Súbežné riadky s rovnakou udalosťou a matcherom hneď po sebe tvoria jednu
// skupinu v settings.json, poradie riadkov je poradie hookov.
//
// Použitie z install.sh: node env/hooks.mjs apply <main|runs|mac> <settings.json> [--base <súbor>]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brainGlobalDir } from "../lib/paths.mjs";

export const KINDS = ["main", "runs", "mac", "agent"];
export const REQUIRES = ["none", "tasker", "t3", "inbox", "mac"];

const R = (file, event, matcher, timeout, requires, where, args = "") => ({ file, event, matcher, timeout, requires, where, args });
const BASH_WRITE = "^(Write|Edit|MultiEdit|NotebookEdit|Bash)$";
const BASH_EDIT = "^(Edit|Write|MultiEdit|NotebookEdit|Bash)$";
const BASH_ALL = "^(Bash|Edit|Write|MultiEdit|NotebookEdit)$";
const AGENT_TASK = "^(Agent|Task)$";

export const TABLE = [
  // SessionStart
  R("check.mjs", "SessionStart", null, null, ["none"], ["mac"], "--quiet"),
  R("unslop.mjs", "SessionStart", null, null, ["none"], ["main", "mac"]),
  R("identity.mjs", "SessionStart", null, null, ["t3"], ["main"]),
  R("memory_context.mjs", "SessionStart", null, null, ["none"], ["main"]),
  R("clear_bridge.mjs", "SessionStart", null, null, ["t3"], ["main"]),
  R("rozhodnutia_context.mjs", "SessionStart", null, null, ["tasker"], ["main", "mac"]),
  R("topic.mjs", "SessionStart", null, null, ["mac"], ["agent"], "start"),
  // UserPromptSubmit
  R("context_warning.mjs", "UserPromptSubmit", null, null, ["none"], ["main"]),
  R("agreement_scope.mjs", "UserPromptSubmit", null, null, ["none"], ["main", "mac"]),
  R("rules_delta.mjs", "UserPromptSubmit", null, null, ["none"], ["main", "mac"]),
  R("tasker_work.mjs", "UserPromptSubmit", null, null, ["tasker"], ["main"]),
  R("agent_inbox.mjs", "UserPromptSubmit", null, null, ["mac"], ["agent"]),
  // PreToolUse
  R("guard.mjs", "PreToolUse", BASH_WRITE, null, ["mac"], ["mac"]),
  R("topic.mjs", "PreToolUse", ".*", null, ["mac"], ["agent"], "check"),
  R("no_model_wait.mjs", "PreToolUse", "Bash", null, ["none"], ["main", "mac"]),
  R("foreign_git.mjs", "PreToolUse", "Bash", null, ["none"], ["main"]),
  R("git_pull.mjs", "PreToolUse", "Bash", null, ["none"], ["main", "mac"]),
  R("tasker_root.mjs", "PreToolUse", "Bash", null, ["tasker"], ["main"]),
  R("web_review.mjs", "PreToolUse", "Bash", null, ["tasker"], ["main"]),
  R("human_question.mjs", "PreToolUse", "Bash", null, ["tasker"], ["main"]),
  R("own_mechanism.mjs", "PreToolUse", "Bash", null, ["tasker"], ["main", "runs"]),
  R("task_title.mjs", "PreToolUse", "Bash", null, ["tasker"], ["main", "runs"]),
  R("task_concurrency.mjs", "PreToolUse", "Bash", null, ["tasker"], ["main", "runs"]),
  R("task_fresh.mjs", "PreToolUse", "Bash", 10, ["tasker"], ["main", "runs"]),
  R("project_branch.mjs", "PreToolUse", "Bash", null, ["none"], ["main", "runs"]),
  R("tool_failure_block.mjs", "PreToolUse", "Bash", null, ["none"], ["main", "runs"]),
  R("rm_target.mjs", "PreToolUse", "Bash", null, ["none"], ["main", "runs"]),
  R("sed_line.mjs", "PreToolUse", "Bash", null, ["none"], ["main", "runs", "mac"]),
  R("secret_read.mjs", "PreToolUse", "Bash", null, ["none"], ["main", "runs", "mac"]),
  R("agreement_send.mjs", "PreToolUse", "Bash", null, ["inbox"], ["main", "mac"]),
  R("brain/bin/repeat_guard.mjs", "PreToolUse", "Bash", null, ["none"], ["main", "runs", "mac"], "--allow {brain}/env/{machine}/repeat_guard.allow"),
  R("project_data.mjs", "PreToolUse", "Bash", null, ["mac"], ["agent"]),
  R("server_work.mjs", "PreToolUse", "Bash", null, ["mac"], ["agent"]),
  R("deploy_readonly.mjs", "PreToolUse", BASH_EDIT, null, ["none"], ["main", "runs"]),
  R("subagent_foreground.mjs", "PreToolUse", "^(Bash|Monitor)$", 3, ["none"], ["main"]),
  R("sonnet_delegation.mjs", "PreToolUse", BASH_ALL, 3, ["none"], ["main"]),
  R("no_retest.mjs", "PreToolUse", "Bash", 3, ["none"], ["main"]),
  R("rozhodnutia_guard.mjs", "PreToolUse", BASH_WRITE, null, ["none"], ["main", "mac"]),
  R("own_rule_scope.mjs", "PreToolUse", "^(Write|Edit|MultiEdit|Bash)$", null, ["none"], ["main", "mac"]),
  R("tasker_work.mjs", "PreToolUse", AGENT_TASK, 3, ["tasker"], ["main", "mac"]),
  R("implementator_model.mjs", "PreToolUse", AGENT_TASK, 3, ["none"], ["main"]),
  R("tasker_work.mjs", "PreToolUse", BASH_ALL, 10, ["tasker"], ["main"]),
  // PostToolUse a PostToolUseFailure
  R("topic_task.mjs", "PostToolUse", "Bash", null, ["tasker", "t3"], ["agent"]),
  R("tool_failure_log.mjs", "PostToolUseFailure", "Bash", 5, ["none"], ["main", "runs"]),
  // SubagentStop
  R("tasker_work.mjs", "SubagentStop", null, 3, ["tasker"], ["main", "mac"]),
  R("tool_failure_report.mjs", "SubagentStop", null, 10, ["tasker"], ["main", "runs"]),
  // Stop
  R("reply_guard.mjs", "Stop", null, null, ["tasker", "t3"], ["main", "mac"]),
  R("todo_after_comment.mjs", "Stop", null, null, ["tasker"], ["main", "mac"]),
  R("done_related.mjs", "Stop", null, null, ["tasker"], ["main"]),
  R("objection_fix.mjs", "Stop", null, null, ["none"], ["main", "mac"]),
  R("no_operator_commands.mjs", "Stop", null, null, ["none"], ["agent"]),
  R("tool_failure_report.mjs", "Stop", null, 10, ["tasker"], ["main", "runs"]),
  R("dokonci_open.mjs", "Stop", null, 5, ["tasker"], ["main", "runs"]),
  R("idle_wake.mjs", "Stop", null, 15, ["tasker"], ["agent"]),
  // PreCompact: kompakcia je zakázaný stav, plný kontext skončí chybou limitu
  R("compact_block.mjs", "PreCompact", null, 3, ["none"], ["main", "runs", "mac"]),
];

// Súbory v hooks/, ktoré nie sú hook, ale modul, ktorý hooky importujú.
export const HELPERS = ["agent_repo.mjs", "shared_git.mjs"];

// Kľúče settings.json mimo hooks, ktoré generátor píše podľa druhu.
const COMMON = { autoCompactEnabled: false, outputStyle: "operator" };
const EXTRA = { attribution: { commit: "", pr: "", sessionUrl: false }, env: { AR_ROZHODNUTIA: "1" } };

// check.mjs a cesty s lomkou ležia od koreňa klonu, ostatné hooky v hooks/.
const fromRoot = (file) => file === "check.mjs" || file.includes("/");

export const rowsFor = (kind) => TABLE.filter((r) => r.where.includes(kind));

// Príkaz hooku. Na Macu s cestou pod domovom `node "$HOME/..."`, inde holá cesta.
function pathArg(p, kind, home) {
  if (kind === "mac" && home && (p === home || p.startsWith(home + "/"))) return `"$HOME${p.slice(home.length)}"`;
  return /\s/.test(p) ? `"${p}"` : p;
}

function command(row, kind, hooksDir, workflowDir, home, brain) {
  const script = fromRoot(row.file) ? join(workflowDir, row.file) : join(hooksDir, row.file);
  const machine = kind === "mac" ? "mac" : "server";
  const args = row.args
    .split(" ")
    .map((w) => (/\{(brain|machine)\}/.test(w) ? pathArg(w.replaceAll("{brain}", brain).replaceAll("{machine}", machine), kind, home) : w))
    .join(" ");
  return `node ${pathArg(script, kind, home)}${args ? " " + args : ""}`;
}

// Objekt `hooks` pre druh: skupiny { matcher?, hooks: [{ type, command, timeout? }] }
// podľa poradia tabuľky.
export function hooksFor(kind, hooksDir, workflowDir, { home = homedir(), brain = brainGlobalDir() } = {}) {
  const out = {};
  let prev = null;
  for (const r of rowsFor(kind)) {
    const list = (out[r.event] ??= []);
    const h = { type: "command", command: command(r, kind, hooksDir, workflowDir, home, brain) };
    if (r.timeout != null) h.timeout = r.timeout;
    const last = list[list.length - 1];
    if (last && prev && prev.event === r.event && prev.matcher === r.matcher) last.hooks.push(h);
    else list.push({ ...(r.matcher != null ? { matcher: r.matcher } : {}), hooks: [h] });
    prev = r;
  }
  return out;
}

// Kľúče settings.json, ktoré píše generátor: hooks a pár nastavení hookov.
export function settingsFor(kind, hooksDir, workflowDir, opts = {}) {
  if (!KINDS.includes(kind)) throw new Error(`neznámy druh ${kind}, čakám ${KINDS.join("|")}`);
  const s = { hooks: hooksFor(kind, hooksDir, workflowDir, opts) };
  if (kind === "agent") return s;
  Object.assign(s, structuredClone(COMMON));
  if (kind !== "runs") Object.assign(s, structuredClone(EXTRA));
  return s;
}

// Meno súboru hooku z príkazu `node <cesta>/hooks/<meno>.mjs ...`, `check.mjs`
// alebo cesty od koreňa klonu z tabuľky (`brain/bin/repeat_guard.mjs`). Pred
// `brain/` stojí lomka, takže samostatná kópia `agentic-brain/bin/...` nie je naša.
const rx = (f) => f.replace(".mjs", "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const names = (pred) => [...new Set(TABLE.map((r) => r.file).filter(pred))].map(rx).join("|");
const OURS = new RegExp(
  `^node\\s+"?\\S*/(?:hooks/(${names((f) => !fromRoot(f))})\\.mjs|(check)\\.mjs"?\\s+--quiet|(${names((f) => f.includes("/"))})\\.mjs)"?(\\s.*)?$`,
);
export const isOurs = (command) => OURS.test(String(command ?? ""));

const clone = (v) => structuredClone(v);

// Zlúči vygenerované kľúče do existujúceho objektu settings. Skupiny s naším
// hookom (z ľubovoľnej cesty, napríklad zo starého klonu) nahradí, cudzie ostanú.
export function mergeSettings(existing, kind, hooksDir, workflowDir, opts = {}) {
  const gen = settingsFor(kind, hooksDir, workflowDir, opts);
  const d = clone(existing ?? {});
  const hooks = (d.hooks ??= {});
  for (const event of new Set([...Object.keys(hooks), ...Object.keys(gen.hooks)])) {
    const keep = (hooks[event] ?? []).filter((g) => !(g.hooks ?? []).some((c) => isOurs(c.command)));
    const groups = [...keep, ...(gen.hooks[event] ?? [])];
    if (groups.length) hooks[event] = groups;
    else delete hooks[event];
  }
  for (const [k, v] of Object.entries(gen)) {
    if (k === "hooks") continue;
    if (k === "env") d.env = { ...(d.env ?? {}), ...v };
    else d[k] = clone(v);
  }
  return d;
}

// Zlúči `base` (kľúče mimo hookov, napríklad pluginy, jazyk, model; súbor patrí
// do spoločného mozgu) pod existujúce nastavenie: existujúca hodnota vyhráva,
// objekty sa zlučujú po kľúčoch. Kľúč hooks sa z base neberie.
export function withBase(existing, base) {
  const out = clone(existing ?? {});
  const fill = (dst, src) => {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === "object" && !Array.isArray(v) && dst[k] && typeof dst[k] === "object" && !Array.isArray(dst[k])) fill(dst[k], v);
      else if (!(k in dst)) dst[k] = clone(v);
    }
  };
  const { hooks: _hooks, ...rest } = base ?? {};
  fill(out, rest);
  return out;
}

export function applySettings(path, kind, hooksDir, workflowDir, { baseFile = null, ...opts } = {}) {
  let existing = {};
  if (existsSync(path)) existing = JSON.parse(readFileSync(path, "utf8"));
  if (baseFile && existsSync(baseFile)) existing = withBase(existing, JSON.parse(readFileSync(baseFile, "utf8")));
  const d = mergeSettings(existing, kind, hooksDir, workflowDir, opts);
  writeFileSync(path, JSON.stringify(d, null, 2) + "\n");
  return d;
}

const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
};

// Rozdiel živého settings.json od generátora: prázdne pole, keď install.sh
// nemá čo zmeniť. Cudzie kľúče a cudzie hooky nie sú rozdiel.
export function driftProblems(live, kind, hooksDir, workflowDir, opts = {}) {
  const merged = mergeSettings(live, kind, hooksDir, workflowDir, opts);
  return JSON.stringify(canon(merged)) === JSON.stringify(canon(live)) ? [] : [`settings.json sa líši od env/hooks.mjs (${kind})`];
}

// Hlavička requires z hooks/<súbor>.
export function headerRequires(text) {
  const m = /^\/\/ requires: (.+)$/.exec(text.split("\n")[1] ?? "");
  return m ? m[1].split(",").map((v) => v.trim()) : null;
}

const isHookFile = (n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs") && !n.endsWith(".replay.mjs");

// Kontrola tabuľky proti repu: hook existuje, requires sedí s hlavičkou, každý
// hook v hooks/ je v tabuľke, je to pomocný modul, alebo má výnimku v
// lib/dead_code_allow.txt (hook, ktorý nikde nevolá nastavenie).
export function tableProblems(repo) {
  const problems = [];
  const dir = join(repo, "hooks");
  const files = existsSync(dir) ? readdirSync(dir).filter(isHookFile) : [];
  const allowFile = join(repo, "lib", "dead_code_allow.txt");
  const allowed = new Set(
    existsSync(allowFile)
      ? readFileSync(allowFile, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.trim().split(/\s+/)[0])
      : [],
  );
  const inTable = new Set();
  for (const r of TABLE) {
    const label = `env/hooks.mjs: ${r.file} (${r.event}${r.matcher ? " " + r.matcher : ""})`;
    for (const w of r.where) if (!KINDS.includes(w)) problems.push(`${label}: kde beží má hodnotu ${w} mimo ${KINDS.join("|")}`);
    if (r.file === "check.mjs") {
      if (!existsSync(join(repo, "check.mjs"))) problems.push(`${label}: súbor neexistuje`);
      continue;
    }
    if (r.file.includes("/")) {
      if (!existsSync(join(repo, r.file))) problems.push(`${label}: ${r.file} neexistuje`);
      continue;
    }
    inTable.add(r.file);
    const p = join(dir, r.file);
    if (!existsSync(p)) {
      problems.push(`${label}: hooks/${r.file} neexistuje`);
      continue;
    }
    const header = headerRequires(readFileSync(p, "utf8"));
    if (!header) problems.push(`${label}: hooks/${r.file} nemá druhý riadok // requires:`);
    else if (header.join(",") !== r.requires.join(",")) problems.push(`${label}: requires ${r.requires.join(", ")} nesedí s hlavičkou hooku (${header.join(", ")})`);
  }
  for (const f of files) {
    if (!inTable.has(f) && !HELPERS.includes(f) && !allowed.has(`hooks/${f}`)) problems.push(`hooks/${f} nie je v env/hooks.mjs, ani pomocný modul, ani výnimka v lib/dead_code_allow.txt`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, kind, path, ...rest] = process.argv.slice(2);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (cmd === "apply" && kind && path) {
    const i = rest.indexOf("--base");
    const baseFile = i >= 0 ? rest[i + 1] : null;
    applySettings(path, kind, join(root, "hooks"), root, { baseFile });
    console.log(`settings.json (${kind}): ${path}`);
  } else if (cmd === "print" && kind) {
    console.log(JSON.stringify(settingsFor(kind, join(root, "hooks"), root), null, 2));
  } else {
    console.error("použitie: node env/hooks.mjs apply <main|runs|mac|agent> <settings.json> [--base <súbor>] | print <druh>");
    process.exit(2);
  }
}
