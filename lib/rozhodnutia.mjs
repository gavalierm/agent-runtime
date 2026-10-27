#!/usr/bin/env node
// Úložisko rozhodnutí `rozhodnutia/`: jeden súbor na rozhodnutie
// (D0001.md a ďalej), hlavička `kľúč: hodnota`, telo je text. Schéma je
// v rozhodnutia/README.md, značky rozsahu v rozhodnutia/ROZSAHY.md, návrh
// je úloha Taskera 390.
//
// Príkazy:
//   rozhodnutia.mjs list [--agent <meno>] [--rozsah <značka>] [--vsetky] [--stav <stav>]
//   rozhodnutia.mjs show <D0007|R153>      (alias R153 vypíše aj R153.<prípona>)
//   rozhodnutia.mjs check                  kód 0 v poriadku, 1 problémy na stdout
//   rozhodnutia.mjs index                  prepíše rozhodnutia/INDEX.md
//   rozhodnutia.mjs zapis ...              volá ho bin/rozhodni.sh, zapíše súbory
// Priečinok záznamov je --dir, inak ROZHODNUTIA_DIR, inak rozhodnutia/ v klone
// z ROZHODNUTIA_REPO. Skript nemá predvolenú cestu, repo s rozhodnutiami mu
// povie volajúci (obal v repe pravidiel cez configure()). Nikdy nepíše mimo
// toho priečinka.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = dirname(fileURLToPath(import.meta.url));
// Klon agent-runtime, v ktorom sa hľadajú aj súbory zo `subory` (hooky žijú tu).
const RUNTIME_ROOT = join(LIB, "..");

// Nastavenie repa, ktoré rozhodnutia vedie. Repo pravidiel ho vloží vo svojom
// re-exporte: `repo` (klon s priečinkom rozhodnutia/ a roles/agents.md),
// `operatori` (mená, ktorými sa operátor podpisuje, popri slove "operátor")
// a `kontroly` (funkcie `(záznam, bad, ctx)` s kontrolami len toho repa).
const cfg = { repo: null, operatori: ["operátor"], kontroly: [] };
export function configure(o = {}) {
  if (o.repo) cfg.repo = o.repo;
  if (o.operatori) cfg.operatori = ["operátor", ...o.operatori.map((m) => m.toLowerCase())];
  if (o.kontroly) cfg.kontroly = o.kontroly;
}

// Priečinok záznamov bez parametra: ROZHODNUTIA_DIR, ROZHODNUTIA_REPO, repo z configure(), inak null.
export function defaultDir(env = process.env) {
  if (env.ROZHODNUTIA_DIR) return resolve(env.ROZHODNUTIA_DIR);
  const repo = env.ROZHODNUTIA_REPO || cfg.repo;
  return repo ? join(repo, "rozhodnutia") : null;
}

// Poradie polí v hlavičke. Povinné sú tie pred `uloha`.
export const POLIA = ["id", "nazov", "stav", "kluc", "rozsah", "agenti", "rozhodol", "moc", "zapisal", "datum", "zdroj", "uloha", "nahradza", "nahradene", "alias", "subory", "zrusene-tvrdenie"];
const POVINNE = POLIA.slice(0, POLIA.indexOf("uloha"));
const ZOZNAMY = new Set(["rozsah", "agenti", "nahradza", "nahradene", "alias", "subory"]);
export const STAVY = ["platí", "nahradené", "zrušené"];
export const MOCI = ["operator", "zastupca-v-plnej-moci", "spravca-agentov", "spravca-servera", "dizajner", "veduci-vyvoja", "pracovny-agent"];
// Rozsah -> moci, ktoré naň stačia. Rozsah mimo tabuľky nemá obmedzenie.
const MOC_NA_ROZSAH = {
  pravidla: ["operator", "spravca-agentov"],
  server: MOCI.filter((m) => m !== "pracovny-agent"),
};
const SKRATKA_MOCI = { "zastupca-v-plnej-moci": "plná moc" };

// Prepínač kontrol a vkladania zmien rozhodnutí v živých hookoch (reply_guard
// K3, rules_delta, memory K4 v check.mjs). Do nasadenia úlohy U5 sú vypnuté,
// zapne ich premenná AR_ROZHODNUTIA=1 v bloku env súboru settings.json
// (env/server/install.sh, env/mac/settings.json). Hook ju číta z prostredia
// procesu, takže sa dá zapnúť na jednom stroji bez commitu.
export const zapnute = (env = process.env) => env.AR_ROZHODNUTIA === "1";

const zoznam = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);

// Hlavička a telo súboru. Vráti null, keď súbor nemá hlavičku.
export function parseRecord(text, file = "") {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const r = { file, telo: m[2].trim(), nezname: [] };
  for (const line of m[1].split("\n")) {
    const k = /^([a-z-]+):[ \t]*(.*)$/.exec(line);
    if (!k) { if (line.trim()) r.nezname.push(line); continue; }
    if (!POLIA.includes(k[1])) r.nezname.push(line);
    else r[k[1]] = k[2].trim();
  }
  for (const f of POLIA) if (r[f] === undefined) r[f] = "";
  return r;
}

export function formatRecord(r) {
  const hlavicka = POLIA.map((f) => `${f}:${r[f] ? ` ${r[f]}` : ""}`).join("\n");
  return `---\n${hlavicka}\n---\n${r.telo.trim()}\n`;
}

export function loadAll(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^D\d{4}\.md$/.test(f)).sort().map((f) => {
    const text = readFileSync(join(dir, f), "utf8");
    return parseRecord(text, f) || { file: f, chyba: true, telo: "", nezname: [], ...Object.fromEntries(POLIA.map((p) => [p, ""])) };
  });
}

export function nextId(records) {
  const max = records.reduce((a, r) => Math.max(a, Number(/^D(\d{4})$/.exec(r.id)?.[1] ?? 0)), 0);
  return `D${String(max + 1).padStart(4, "0")}`;
}

// Značky z tabuľky v ROZSAHY.md: riadok začínajúci | `značka` |.
export function loadRozsahy(dir) {
  const f = join(dir, "ROZSAHY.md");
  const keys = [];
  if (existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n")) {
    const m = /^\|\s*`([^`]+)`\s*\|/.exec(l);
    if (m) keys.push(m[1]);
  }
  return keys;
}
const rozsahZnamy = (znacky, z) => znacky.includes(z) || znacky.some((k) => k.endsWith("<meno>") && z.startsWith(k.slice(0, -6)) && /^[a-z0-9-]+$/.test(z.slice(k.length - 6)));

// Mená agentov z tabuľky roles/agents.md, malými písmenami.
export function loadAgents(dir) {
  for (const base of [join(dir, "..", "roles", "agents.md"), cfg.repo && join(cfg.repo, "roles", "agents.md")]) {
    if (!base || !existsSync(base)) continue;
    return readFileSync(base, "utf8").split("\n").map((l) => /^\| ([A-Z][a-z]+) \|/.exec(l)?.[1]?.toLowerCase()).filter(Boolean);
  }
  return null;
}

// Moci, ktoré smie držať daný agent podľa stĺpca rola v roles/agents.md.
// Operátor drží moc operator, nikto iný ju nemá. Agent mimo tabuľky
// nemá obmedzenie (kontrola ho nepozná). pracovny-agent smie každý.
// "zástupca operátora" nie je operátor, preto operátor(?!a).
const MOC_Z_ROLY = [
  [/operátor(?!a)/i, "operator"],
  [/zástupca operátora/i, "zastupca-v-plnej-moci"],
  [/správca agentov/i, "spravca-agentov"],
  [/správca servera/i, "spravca-servera"],
  [/dizajnér/i, "dizajner"],
  [/vedúci vývoja/i, "veduci-vyvoja"],
];
export function loadMoci(dir) {
  for (const base of [join(dir, "..", "roles", "agents.md"), cfg.repo && join(cfg.repo, "roles", "agents.md")]) {
    if (!base || !existsSync(base)) continue;
    const out = new Map();
    for (const l of readFileSync(base, "utf8").split("\n")) {
      const m = /^\| ([A-Z][a-z]+) \| ([^|]+) \|/.exec(l);
      if (!m) continue;
      const moci = new Set(["pracovny-agent"]);
      for (const [re, moc] of MOC_Z_ROLY) if (re.test(m[2])) moci.add(moc);
      out.set(m[1].toLowerCase(), moci);
    }
    return out;
  }
  return null;
}

export function indexLine(r) {
  const kto = r.moc === "operator" ? r.rozhodol : `${r.rozhodol}/${SKRATKA_MOCI[r.moc] || r.moc}`;
  return `${r.id} ${r.datum} ${zoznam(r.rozsah).join(",")} ${zoznam(r.agenti).join(",")} ${kto} ${r.nazov}`;
}

const HLAVICKA_INDEXU = "<!-- Generuje lib/rozhodnutia.mjs index, neupravuj. Jeden riadok na záznam v stave platí: id, dátum, rozsah, agenti, kto, názov. -->\n";
export function buildIndex(records) {
  const riadky = records.filter((r) => r.stav === "platí").map(indexLine);
  return HLAVICKA_INDEXU + riadky.map((l) => `${l}\n`).join("");
}

// Problémy v pamäti načítanej množiny. `ctx`: { dir, znacky, agenti, moci, runtime }, `runtime` je klon
// agent-runtime (predvolene ten, v ktorom leží tento súbor), v ktorom sa hľadajú aj súbory zo `subory`.
export function problems(records, ctx) {
  const out = [];
  const bad = (r, m) => out.push(`${r.file || r.id}: ${m}`);
  const byId = new Map(records.map((r) => [r.id, r]));
  const aliasy = new Map();
  const root = dirname(ctx.dir);
  for (const r of records) {
    if (r.chyba) { bad(r, "chýba hlavička ---"); continue; }
    for (const l of r.nezname) bad(r, `neznámy riadok hlavičky '${l}'`);
    for (const f of POVINNE) if (!r[f]) bad(r, `chýba pole ${f}`);
    if (r.file && r.id !== r.file.replace(/\.md$/, "")) bad(r, `id ${r.id} nesedí s menom súboru`);
    if (!/^D\d{4}$/.test(r.id)) bad(r, "id nemá tvar D0000");
    if (r.stav && !STAVY.includes(r.stav)) bad(r, `stav '${r.stav}' nie je ${STAVY.join(", ")}`);
    if (r.kluc && !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(r.kluc)) bad(r, `kľúč '${r.kluc}' nie je bodková cesta z malých písmen`);
    if (r.datum && !/^\d{4}-\d{2}-\d{2}$/.test(r.datum)) bad(r, `dátum '${r.datum}' nemá tvar RRRR-MM-DD`);
    if (r.moc && !MOCI.includes(r.moc)) bad(r, `moc '${r.moc}' nie je ${MOCI.join(", ")}`);
    if (r.uloha && !/^\d+$/.test(r.uloha)) bad(r, `úloha '${r.uloha}' nie je číslo`);
    if (!r.telo) bad(r, "prázdne telo");
    const rozsah = zoznam(r.rozsah);
    for (const z of rozsah) if (!rozsahZnamy(ctx.znacky, z)) bad(r, `rozsah '${z}' nie je v ROZSAHY.md`);
    for (const [z, moci] of Object.entries(MOC_NA_ROZSAH)) if (rozsah.includes(z) && r.moc && !moci.includes(r.moc)) bad(r, `moc ${r.moc} nestačí na rozsah ${z} (smie ${moci.join(", ")})`);
    // Moc musí držať ten, kto rozhodol: operator len operátor, ostatné podľa roly z roles/agents.md.
    const drzi = ctx.moci?.get((r.rozhodol || "").toLowerCase());
    if (r.stav === "platí" && drzi && r.moc && !drzi.has(r.moc)) bad(r, `moc ${r.moc} nemá ${r.rozhodol} podľa roles/agents.md (má ${[...drzi].join(", ")})`);
    if (ctx.agenti) for (const a of zoznam(r.agenti)) if (a !== "*" && !ctx.agenti.includes(a)) bad(r, `agent '${a}' nie je v roles/agents.md`);
    for (const kontrola of cfg.kontroly) kontrola(r, (m) => bad(r, m), ctx);
    if (cfg.operatori.includes((r.rozhodol || "").toLowerCase()) && r.zdroj && !/vlákn|úloh|relác/i.test(r.zdroj)) bad(r, `rozhodol ${r.rozhodol}, zdroj musí niesť vlákno, reláciu alebo úlohu`);
    if (r["zrusene-tvrdenie"]) { try { new RegExp(r["zrusene-tvrdenie"]); } catch { bad(r, "zrusene-tvrdenie nie je platný regulárny výraz"); } }
    // Nahradený alebo zrušený záznam je história, jeho súbory mohli zaniknúť.
    for (const s of r.stav === "platí" ? zoznam(r.subory) : []) {
      const cesta = s.replace(/#.*$/, "");
      // Kód žije v repe agent-runtime, záznam ho uvádza pod hooks/<meno>.mjs alebo lib/<meno>.mjs.
      if (!isAbsolute(cesta) && !existsSync(join(root, cesta)) && !existsSync(join(ctx.runtime ?? RUNTIME_ROOT, cesta))) bad(r, `súbor '${s}' neexistuje`);
    }
    for (const a of zoznam(r.alias)) {
      if (aliasy.has(a)) bad(r, `alias ${a} má aj ${aliasy.get(a)}`);
      else aliasy.set(a, r.id);
    }
    for (const n of zoznam(r.nahradza)) {
      const o = byId.get(n);
      if (!o) bad(r, `nahradza ${n}, ktorý neexistuje`);
      else if (!zoznam(o.nahradene).includes(r.id)) bad(r, `nahradza ${n}, ale ${n} nemá nahradene ${r.id}`);
    }
    for (const n of zoznam(r.nahradene)) {
      const o = byId.get(n);
      if (!o) bad(r, `nahradene ${n}, ktorý neexistuje`);
      else if (!zoznam(o.nahradza).includes(r.id)) bad(r, `nahradene ${n}, ale ${n} nemá nahradza ${r.id}`);
    }
    if (r.stav === "nahradené" && !r.nahradene) bad(r, "stav nahradené bez poľa nahradene");
    if (r.stav === "platí" && r.nahradene) bad(r, "stav platí, ale záznam má nahradene");
  }
  const platne = new Map();
  for (const r of records) if (r.stav === "platí" && r.kluc) platne.set(r.kluc, [...(platne.get(r.kluc) || []), r.id]);
  for (const [k, ids] of platne) if (ids.length > 1) out.push(`kľúč ${k} má viac platných záznamov: ${ids.join(", ")}, nový musí mať nahradza`);
  return out;
}

export function context(dir) {
  return { dir, znacky: loadRozsahy(dir), agenti: loadAgents(dir), moci: loadMoci(dir) };
}

// Upozornenia, ktoré kontrolu nezhodia: dva platné záznamy s rovnakým názvom
// a rôznymi kľúčmi sú pravdepodobná duplicita (D0055 a D0137, replay S9).
// Hlási ich `check` na stdout s predponou "upozornenie:", ranný súhrn ich vypíše.
export function upozornenia(records) {
  const podla = new Map();
  const norm = (t) => (t || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  for (const r of records) if (r.stav === "platí" && r.nazov) podla.set(norm(r.nazov), [...(podla.get(norm(r.nazov)) || []), r]);
  const out = [];
  for (const rs of podla.values()) {
    const kluce = new Set(rs.map((r) => r.kluc));
    if (rs.length > 1 && kluce.size > 1) out.push(`rovnaký názov '${rs[0].nazov}' pri rôznych kľúčoch: ${rs.map((r) => `${r.id} (${r.kluc})`).join(", ")}`);
  }
  return out;
}

export function check(dir) {
  const records = loadAll(dir);
  const out = problems(records, context(dir));
  const idx = join(dir, "INDEX.md");
  if (existsSync(idx)) { if (readFileSync(idx, "utf8") !== buildIndex(records)) out.push("INDEX.md nesedí so súbormi, spusti rozhodnutia.mjs index"); }
  else if (records.length) out.push("chýba INDEX.md, spusti rozhodnutia.mjs index");
  return out;
}

// Zrušené tvrdenia zo záznamov v každom stave. Autor píše vzor do nového záznamu
// (`rozhodni.sh --nahradza D0011 --zrusene-tvrdenie ...`, replay S2 úlohy 404),
// ktorý je platný, preto sa nesmie čítať len zo zrušených a nahradených. Vzor s chybou
// preskočí, `check` ho hlási. Číta ich lib/doc_paths.mjs, preto retired_claims.txt
// nemusí nikto dopĺňať ručne.
export function zrusenaTvrdenia(dir) {
  return loadAll(dir).filter((r) => r["zrusene-tvrdenie"]).flatMap((r) => {
    try { return [{ re: new RegExp(r["zrusene-tvrdenie"], "i"), why: `${r.id} ${r.nazov}` }]; } catch { return []; }
  });
}

// Záznam stelesnený v pravidle agent nepotrebuje v zozname, má ho na disku.
export const vPravidle = (r) => zoznam(r.subory).some((s) => /^(global|roles)\//.test(s) || /(^|\/)(PERSONA|CLAUDE)\.md/.test(s));

export function select(records, o = {}) {
  const stav = o.stav || "platí";
  return records.filter((r) => {
    if (stav !== "všetky" && r.stav !== stav) return false;
    if (o.agent && !zoznam(r.agenti).some((a) => a === "*" || a === o.agent)) return false;
    if (o.rozsah && !zoznam(r.rozsah).includes(o.rozsah)) return false;
    if (!o.vsetky && vPravidle(r)) return false;
    return true;
  });
}

export function findByRef(records, ref) {
  if (/^D\d{4}$/.test(ref)) return records.filter((r) => r.id === ref);
  return records.filter((r) => zoznam(r.alias).some((a) => a === ref || a.startsWith(`${ref}.`)));
}

// Zápis jedného záznamu. Vráti { id, subory: [{ file, text }], zhodne: [...] } alebo hodí Error.
// Nič nezapisuje, zapíše ho applyZapis, aby dry-run nemohol zapísať nič.
export function planZapis(dir, o) {
  const records = loadAll(dir);
  const ctx = context(dir);
  const id = nextId(records);
  const nahradza = zoznam(o.nahradza);
  const r = {
    id, nazov: o.nazov || "", stav: "platí", kluc: o.kluc || "", rozsah: zoznam(o.rozsah).join(", "), agenti: zoznam(o.agenti).join(", "),
    rozhodol: o.rozhodol || "", moc: o.moc || "", zapisal: o.zapisal || "", datum: o.datum || new Date().toISOString().slice(0, 10),
    zdroj: o.zdroj || "", uloha: o.uloha || "", nahradza: nahradza.join(", "), nahradene: "", alias: zoznam(o.alias).join(", "),
    subory: zoznam(o.subory).join(", "), "zrusene-tvrdenie": o["zrusene-tvrdenie"] || "", telo: (o.telo || "").trim(), nezname: [], file: `${id}.md`,
  };
  for (const f of ["nazov", "kluc", "rozsah", "agenti", "rozhodol", "moc", "zapisal", "zdroj"]) if (!r[f]) throw new Error(`chýba --${f}`);
  if (!r.telo) throw new Error("chýba text záznamu na stdin");
  const zhodne = records.filter((x) => x.stav === "platí" && (x.kluc === r.kluc || zoznam(x.rozsah).some((z) => zoznam(r.rozsah).includes(z))));
  const kolizia = records.filter((x) => x.stav === "platí" && x.kluc === r.kluc && !nahradza.includes(x.id));
  if (kolizia.length) {
    const e = new Error(`kľúč ${r.kluc} už má platný záznam ${kolizia.map((x) => x.id).join(", ")}; ak ho nový mení, pridaj --nahradza ${kolizia[0].id}`);
    e.zhodne = zhodne;
    throw e;
  }
  const upravene = [];
  for (const n of nahradza) {
    const stary = records.find((x) => x.id === n);
    if (!stary) throw new Error(`--nahradza ${n}: záznam neexistuje`);
    if (stary.stav !== "platí") throw new Error(`--nahradza ${n}: záznam už nie je platný (${stary.stav})`);
    upravene.push({ ...stary, stav: "nahradené", nahradene: [...zoznam(stary.nahradene), id].join(", ") });
  }
  const po = [...records.filter((x) => !nahradza.includes(x.id)), ...upravene, r].sort((a, b) => a.id.localeCompare(b.id));
  const p = problems(po, ctx);
  if (p.length) { const e = new Error(p.join("\n")); e.zhodne = zhodne; throw e; }
  const subory = [...upravene, r].map((x) => ({ file: x.file, text: formatRecord(x) }));
  subory.push({ file: "INDEX.md", text: buildIndex(po) });
  return { id, subory, zhodne, record: r };
}

// Zmena stavu na zrušené, bez náhradného záznamu.
export function planZrus(dir, id, dovod) {
  const records = loadAll(dir);
  const stary = records.find((x) => x.id === id);
  if (!stary) throw new Error(`záznam ${id} neexistuje`);
  if (stary.stav !== "platí") throw new Error(`záznam ${id} už nie je platný (${stary.stav})`);
  if (!dovod) throw new Error("chýba --dovod");
  const upraveny = { ...stary, stav: "zrušené", telo: `${stary.telo}\n\nZrušené: ${dovod.trim()}` };
  const po = records.map((x) => (x.id === id ? upraveny : x));
  const p = problems(po, context(dir));
  if (p.length) throw new Error(p.join("\n"));
  return { id, subory: [{ file: upraveny.file, text: formatRecord(upraveny) }, { file: "INDEX.md", text: buildIndex(po) }], zhodne: [], record: upraveny };
}

export function applyZapis(dir, plan) {
  for (const s of plan.subory) writeFileSync(join(dir, s.file), s.text);
}

function parseArgs(argv) {
  const o = { _: [] };
  const flags = new Set(["vsetky", "dry-run"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (flags.has(k)) o[k] = true;
      else { o[k] = argv[i + 1]; i++; }
    } else o._.push(a);
  }
  return o;
}

export function main(argv) {
  const o = parseArgs(argv);
  const [cmd, ...rest] = o._;
  const dir = o.dir ? resolve(o.dir) : defaultDir();
  if (!dir) {
    console.error("Chýba priečinok rozhodnutí: zadaj --dir, ROZHODNUTIA_DIR alebo ROZHODNUTIA_REPO.");
    return 2;
  }
  const records = loadAll(dir);
  switch (cmd) {
    case "list": {
      for (const r of select(records, { agent: o.agent, rozsah: o.rozsah, vsetky: o.vsetky, stav: o.stav })) console.log(indexLine(r));
      return 0;
    }
    case "show": {
      const f = findByRef(records, rest[0] || "");
      if (!f.length) { console.error(`Záznam '${rest[0] || ""}' neexistuje.`); return 1; }
      console.log(f.map((r) => readFileSync(join(dir, r.file), "utf8")).join("\n"));
      return 0;
    }
    case "check": {
      const p = check(dir);
      for (const l of p) console.log(l);
      for (const l of upozornenia(records)) console.log(`upozornenie: ${l}`);
      return p.length ? 1 : 0;
    }
    case "index": {
      writeFileSync(join(dir, "INDEX.md"), buildIndex(records));
      return 0;
    }
    case "zapis": {
      try {
        const plan = o.zrus ? planZrus(dir, o.zrus, o.dovod) : planZapis(dir, { ...o, telo: o.telo ?? readFileSync(0, "utf8") });
        if (plan.zhodne.length) { console.error("Platné záznamy s rovnakým kľúčom alebo rozsahom:"); for (const z of plan.zhodne.slice(0, 10)) console.error(`  ${indexLine(z)}`); }
        if (o["dry-run"]) {
          console.log(`# dry-run, nič sa nezapíše; pridelené ${plan.id}`);
          for (const s of plan.subory.filter((x) => x.file !== "INDEX.md")) console.log(`## ${s.file}\n${s.text}`);
          return 0;
        }
        applyZapis(dir, plan);
        console.log(plan.id);
        console.log(plan.record.nazov);
        console.log(plan.subory.map((s) => s.file).join("\n"));
        return 0;
      } catch (e) {
        if (e.zhodne?.length) { console.error("Platné záznamy s rovnakým kľúčom alebo rozsahom:"); for (const z of e.zhodne.slice(0, 10)) console.error(`  ${indexLine(z)}`); }
        console.error(e.message);
        return 1;
      }
    }
    case "zdroj-ulohy": {
      // Zdroj záznamu z JSON úlohy Taskera (`tk task show N --json`) na stdin.
      try {
        const u = JSON.parse(readFileSync(0, "utf8"));
        if (!u || !Number.isInteger(u.id)) throw new Error("vstup nie je úloha Taskera");
        const k = (u.comments || []).slice(-1)[0];
        const den = (ms) => new Date(ms).toISOString().slice(0, 10);
        console.log(`úloha ${u.id} "${u.title}"${k ? `, komentár ${k.author} ${den(k.created_at)}` : ""}`);
        return 0;
      } catch (e) { console.error(e.message); return 1; }
    }
    case "znovu": {
      // Zapíše záznam zo súboru (commit, ktorý po rebase stratil číslo) pod novým číslom.
      try {
        const r = parseRecord(readFileSync(o.subor, "utf8"));
        if (!r) throw new Error("súbor nemá hlavičku");
        const opts = { nazov: r.nazov, kluc: r.kluc, rozsah: r.rozsah, agenti: r.agenti, rozhodol: r.rozhodol, moc: r.moc, zapisal: r.zapisal, datum: r.datum, zdroj: r.zdroj, uloha: r.uloha, nahradza: r.nahradza, alias: r.alias, subory: r.subory, "zrusene-tvrdenie": r["zrusene-tvrdenie"], telo: r.telo };
        const plan = planZapis(dir, opts);
        applyZapis(dir, plan);
        console.log(plan.id);
        console.log(plan.record.nazov);
        console.log(plan.subory.map((s) => s.file).join("\n"));
        return 0;
      } catch (e) { console.error(e.message); return 1; }
    }
    default:
      console.error("Použitie: rozhodnutia.mjs list|show|check|index|zapis (hlavička súboru)");
      return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
