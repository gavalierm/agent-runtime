import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const sh = join(dirname(fileURLToPath(import.meta.url)), "..", "browser.sh");
// Používateľ prehliadača z AGENT_BROWSER_USER (alebo AGENT_TASKER_USER), skúška beží len s ním.
const bUser = process.env.AGENT_BROWSER_USER || process.env.AGENT_TASKER_USER || "";
const ready = process.getuid?.() === 0 && bUser !== "" && existsSync(`/home/${bUser}/.cache/ms-playwright`);

// Lokálny súbor, žiadne živé služby. Skúška spustí Chrome pod používateľom bUser
// (browser.sh), preto sa preskočí mimo servera.
test("browser.sh: snímky pre dve šírky, krok click, chyba konzoly", { skip: !ready && "nie je root so serverovým prehliadačom" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-test-"));
  try {
    const html = join(dir, "page.html");
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><button id="b" onclick="document.getElementById('t').textContent='kliknuté'">klik</button>
<p id="t">pôvodný</p><script>console.error("chyba-z-testu")</script>`);
    const out = join(dir, "out");
    const steps = JSON.stringify([{ click: "#b" }, { shot: "po-kliku" }]);
    const r = spawnSync(sh, ["--file", html, "--width", "800,390", "--text", "--steps", steps, "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    for (const f of ["page-800.png", "page-390.png", "po-kliku-800.png", "po-kliku-390.png", "text-800.txt", "console.txt"]) {
      assert.ok(existsSync(join(out, f)), `chýba ${f}`);
      assert.ok(r.stdout.includes(join(out, f)), `výpis neobsahuje ${f}`);
    }
    for (const f of ["page-800.png", "page-390.png"]) {
      assert.equal(readFileSync(join(out, f)).subarray(1, 4).toString(), "PNG");
    }
    assert.match(readFileSync(join(out, "text-800.txt"), "utf8"), /kliknuté/);
    assert.match(readFileSync(join(out, "console.txt"), "utf8"), /console\.error: chyba-z-testu/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Agenti Taskera bežia pod bežným používateľom, nie pod rootom (úloha 579).
// Skúška (spúšťa ju root cez runuser) pustí browser.sh pod bežným používateľom:
// Chrome beží pod ním samým, bez runuser vo vnútri skriptu. Lokálny súbor, žiadne
// živé služby; výstupný priečinok patrí tomuto používateľovi.
// Bežný používateľ je ten istý bUser (AGENT_BROWSER_USER alebo AGENT_TASKER_USER).
const nonRoot = bUser;
const readyNonRoot = ready && spawnSync("id", ["-u", nonRoot]).status === 0;
const asNonRoot = (args, cwd) => spawnSync("runuser", ["-u", nonRoot, "--", sh, ...args],
  { encoding: "utf8", cwd, env: { PATH: process.env.PATH, LANG: "C.UTF-8" } });

test("browser.sh pod nerootom: snímka bez runuser, kód 0", { skip: !readyNonRoot && "nie je root so serverovým prehliadačom a používateľom z AGENT_BROWSER_USER" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-nonroot-"));
  try {
    chmodSync(dir, 0o755);
    const html = join(dir, "page.html");
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><p>pod nerootom</p>`);
    chmodSync(html, 0o644);
    const out = join(dir, "out");
    mkdirSync(out);
    spawnSync("chown", [`${nonRoot}:${nonRoot}`, out]);
    const r = asNonRoot(["--file", html, "--width", "800", "--text", "--out", out], out);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(join(out, "page-800.png")), r.stdout);
    assert.equal(readFileSync(join(out, "page-800.png")).subarray(1, 4).toString(), "PNG");
    assert.match(readFileSync(join(out, "text-800.txt"), "utf8"), /pod nerootom/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser.sh pod nerootom: --user iný než volajúci skončí kódom 2 s jasnou chybou", { skip: !readyNonRoot && "nie je root so serverovým prehliadačom a používateľom z AGENT_BROWSER_USER" }, () => {
  const r = asNonRoot(["--url", "about:blank", "--user", "nobody"], tmpdir());
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, new RegExp(`--user nobody: pod používateľom ${nonRoot} smie Chrome bežať len pod ním`));
});

test("browser.sh: neznámy argument skončí kódom 2", () => {
  const r = spawnSync(sh, ["--nic"], { encoding: "utf8" });
  assert.equal(r.status, 2);
});

test("browser.sh --gaps: nalepený pár skončí kódom 1 a zapíše sa, odsadený nie", { skip: !ready && "nie je root so serverovým prehliadačom" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-gaps-"));
  try {
    const html = join(dir, "page.html");
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>body{margin:20px;font:16px/16px sans-serif}.ok{margin-top:20px}</style>
<div>Nalepený hore</div><div>Nalepený dole</div><div class="ok">Odsadený</div>`);
    const out = join(dir, "out");
    const r = spawnSync(sh, ["--file", html, "--gaps", "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr);
    const g = readFileSync(join(out, "gaps-1440.txt"), "utf8");
    assert.match(g, /Nalepený hore.*Nalepený dole/);
    assert.doesNotMatch(g, /Odsadený/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Nevykreslený obsah (zatvorený details mimo summary, riadky za hranicou orezania
// predka) nemá ísť do kontroly (úloha 574). Prvky sú položené tak, že by sa
// nevykreslený text hlásil ako nalepený na viditeľný.
const gapsRun = (body) => {
  const dir = mkdtempSync(join(tmpdir(), "browser-gaps-"));
  try {
    const html = join(dir, "page.html");
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>body{margin:20px;font:16px/16px sans-serif}
details,p{margin:0}.clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;width:200px}
.hid{height:16px;overflow:hidden}.ok{margin-top:20px}</style>${body}`);
    const out = join(dir, "out");
    const r = spawnSync(sh, ["--file", html, "--gaps", "--width", "1440", "--out", out], { encoding: "utf8" });
    return { status: r.status, stderr: r.stderr, gaps: readFileSync(join(out, "gaps-1440.txt"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const skipB = { skip: !ready && "nie je root so serverovým prehliadačom" };

test("browser.sh --gaps: text v zatvorenom details mimo summary sa nekontroluje", skipB, () => {
  const r = gapsRun(`<details><summary>Hlavička</summary><p>Skrytý odsek jedna</p><p>Skrytý odsek dva</p></details><div class="ok">Odsadený pod</div>`);
  assert.equal(r.status, 0, r.stderr + r.gaps);
  assert.equal(r.gaps, "");
});

test("browser.sh --gaps: otvorený details sa kontroluje, summary zatvoreného tiež", skipB, () => {
  const r = gapsRun(`<details open><summary>Hlavička otvorená</summary><p>Vidno ju</p></details>
<details><summary>Zatvorená hlavička</summary><p>Skryté</p></details><div class="ok">Odsadený pod</div>`);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.gaps, /Hlavička otvorená.*Vidno ju/);
  assert.doesNotMatch(r.gaps, /Skryté/);
});

test("browser.sh --gaps: riadky za hranicou line-clamp sa nekontrolujú", skipB, () => {
  const r = gapsRun(`<p class="clamp">Prvý riadok textu dlhého textu ktorý sa láme do viacerých riadkov a ďalší text ktorý sa láme ešte raz a ešte raz a ešte raz a potom skončí</p><div class="ok">Odsadený pod</div>`);
  assert.equal(r.status, 0, r.stderr + r.gaps);
  assert.equal(r.gaps, "");
});

test("browser.sh --gaps: viditeľné riadky 2 px od seba sa v orezanom predkovi stále hlásia", skipB, () => {
  const r = gapsRun(`<div style="overflow:hidden;height:60px"><div style="line-height:16px">Horný viditeľný riadok</div><div style="margin-top:2px;line-height:16px">Dolný viditeľný riadok</div></div>`);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.gaps, /Horný viditeľný.*Dolný viditeľný/);
});

// --- Používateľ, trvalý profil a --exec (D0163) ---
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { statSync, mkdirSync } from "node:fs";

const run = (args, opts = {}) =>
  new Promise((res) => {
    const c = execFile(sh, args, { encoding: "utf8", ...opts }, (err, stdout, stderr) =>
      res({ status: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
    if (opts.input !== undefined) c.stdin.end(opts.input);
  });
const profBase = `/home/${bUser}/.local/share/agent-browser/profiles`;

test("browser.sh: zlé voľby používateľa, profilu a --exec skončia kódom 2", async () => {
  assert.equal((await run(["--user", "neexistuje-xyz", "--url", "http://127.0.0.1:1/"])).status, 2);
  assert.equal((await run(["--user", "root", "--url", "http://127.0.0.1:1/"])).status, 2);
  assert.equal((await run(["--profile", "../zle", "--url", "http://127.0.0.1:1/"])).status, 2);
  assert.equal((await run(["--exec", "/nie/je/skript.mjs"])).status, 2);
  assert.equal((await run(["--exec", sh, "--url", "http://127.0.0.1:1/"])).status, 2);
  assert.equal((await run(["--env", "male", "--url", "http://127.0.0.1:1/"])).status, 2);
  assert.equal((await run(["--url", "http://127.0.0.1:1/", "--", "x"])).status, 2);
});

test("browser.sh --profile: cookie prežije druhý beh, profil má práva 700", { skip: !ready && "nie je root so serverovým prehliadačom" }, async () => {
  const name = `test-${process.pid}`;
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push(req.headers.cookie ?? "");
    res.setHeader("Set-Cookie", "ses=pamat-profilu; Max-Age=3600; Path=/");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<p>cookie:${req.headers.cookie ?? "ziadna"}</p>`);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const dir = mkdtempSync(join(tmpdir(), "browser-prof-"));
  try {
    const args = (o) => ["--user", bUser, "--profile", name, "--url", url, "--text", "--out", join(dir, o)];
    const a = await run(args("a"));
    assert.equal(a.status, 0, a.stderr);
    assert.match(readFileSync(join(dir, "a", "text-1440.txt"), "utf8"), /cookie:ziadna/);
    const b = await run(args("b"));
    assert.equal(b.status, 0, b.stderr);
    assert.match(readFileSync(join(dir, "b", "text-1440.txt"), "utf8"), /cookie:ses=pamat-profilu/);
    assert.equal((statSync(join(profBase, name)).mode & 0o777).toString(8), "700");
    assert.equal((statSync(profBase).mode & 0o777).toString(8), "700");
  } finally {
    srv.close();
    rmSync(join(profBase, name), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser.sh --exec: skript pod používateľom, stdin, argumenty, env, kód a profil v session", { skip: !ready && "nie je root so serverovým prehliadačom" }, async () => {
  const name = `test-exec-${process.pid}`;
  const dir = mkdtempSync(join(tmpdir(), "browser-exec-"));
  const script = join(dir, "s.mjs");
  writeFileSync(script, `
import { readFileSync, statSync } from "node:fs";
const { openProfile } = await import(process.env.BROWSER_SESSION);
const ctx = await openProfile();
const page = await ctx.newPage();
await page.setContent("<p id=x>dom-ok</p>");
const text = await page.textContent("#x");
const ua = await page.evaluate(() => navigator.userAgent);
await ctx.close();
console.log(JSON.stringify({
  uid: process.getuid(), args: process.argv.slice(2), stdin: readFileSync(0, "utf8"),
  mine: process.env.MOJA_PREMENNA ?? null, other: process.env.INA_PREMENNA ?? null,
  prof: process.env.BROWSER_PROFILE_DIR, mode: (statSync(process.env.BROWSER_PROFILE_DIR).mode & 0o777).toString(8),
  text, headless: /Headless/.test(ua),
}));
process.exit(7);
`);
  try {
    const r = await run(["--user", bUser, "--profile", name, "--exec", script, "--env", "MOJA_PREMENNA", "--", "a b", "--c"],
      { input: "vstup\n", env: { ...process.env, MOJA_PREMENNA: "ano", INA_PREMENNA: "nie" } });
    assert.equal(r.status, 7, r.stderr);
    const j = JSON.parse(r.stdout);
    const uid = Number(execFileSyncId(bUser));
    assert.equal(j.uid, uid);
    assert.deepEqual(j.args, ["a b", "--c"]);
    assert.equal(j.stdin, "vstup\n");
    assert.equal(j.mine, "ano");
    assert.equal(j.other, null);
    assert.equal(j.prof, join(profBase, name));
    assert.equal(j.mode, "700");
    assert.equal(j.text, "dom-ok");
    assert.equal(j.headless, false);
  } finally {
    rmSync(join(profBase, name), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser.sh --exec: druhý beh toho istého profilu skončí kódom 1", { skip: !ready && "nie je root so serverovým prehliadačom" }, async () => {
  const name = `test-lock-${process.pid}`;
  const dir = mkdtempSync(join(tmpdir(), "browser-lock-"));
  const script = join(dir, "s.mjs");
  writeFileSync(script, `await new Promise((r) => setTimeout(r, 4000));`);
  try {
    const first = run(["--user", bUser, "--profile", name, "--exec", script]);
    await new Promise((r) => setTimeout(r, 1500));
    const second = await run(["--user", bUser, "--profile", name, "--exec", script]);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /práve používa/);
    assert.equal((await first).status, 0);
  } finally {
    rmSync(join(profBase, name), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

function execFileSyncId(u) { return spawnSync("id", ["-u", u], { encoding: "utf8" }).stdout.trim(); }
