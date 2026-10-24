import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mjs = join(here, "..", "secret_drop.mjs");
const wrapper = join(here, "..", "secret_drop.sh");

function start(args) {
  const p = spawn(process.execPath, [mjs, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const out = { stdout: "", stderr: "" };
  p.stdout.on("data", (d) => (out.stdout += d));
  p.stderr.on("data", (d) => (out.stderr += d));
  const exit = new Promise((r) => p.on("close", (code) => r(code)));
  const url = new Promise((res, rej) => {
    const t = setInterval(() => {
      const m = out.stdout.match(/^(http\S+)\n/);
      if (m) { clearInterval(t); res(m[1]); }
    }, 20);
    exit.then(() => { clearInterval(t); rej(new Error("skončil bez odkazu: " + out.stderr)); });
  });
  return { p, out, exit, url };
}

function http(url, { method = "GET", body, host } = {}) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const r = request({ host: u.hostname, port: u.port, path: u.pathname, method, headers: { ...(host ? { Host: host } : {}), ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) } }, (resp) => {
      let b = "";
      resp.on("data", (d) => (b += d));
      resp.on("end", () => res({ status: resp.statusCode, body: b, headers: resp.headers }));
    });
    r.on("error", rej);
    r.end(body);
  });
}
const form = (v) => new URLSearchParams({ value: v }).toString();
const mkdir700 = () => { const d = mkdtempSync(join(tmpdir(), "drop-")); chmodSync(d, 0o700); return d; };

test("secret_drop: odkaz s tokenom, hodnota skončí v súbore 600 a nikde inde", async () => {
  const dir = mkdir700();
  const secret = "tajne-heslo-ŽĽ-0123456789";
  const d = start(["--dir", dir, "--port", "0", "--ttl", "30", "--field", "app-heslo:secret:Heslo pre aplikáciu"]);
  try {
    const url = await d.url;
    const g = await http(url);
    assert.equal(g.status, 200);
    assert.match(g.body, /Heslo pre aplikáciu/);
    assert.match(g.body, /type="password"/);
    assert.equal(g.headers["cache-control"], "no-store");
    // zlý token, zlé pole, zlý hostiteľ
    assert.equal((await http(url.replace(/\/s\/.*/, "/s/zly-token"))).status, 404);
    assert.equal((await http(url + "/f/ine-pole", { method: "POST", body: form("x") })).status, 404);
    assert.equal((await http(url, { host: "zly.example" })).status, 421);
    // prázdna hodnota nič nezapíše
    const empty = await http(url + "/f/app-heslo", { method: "POST", body: form("   ") });
    assert.equal(empty.status, 400);
    assert.equal(existsSync(join(dir, "app-heslo")), false);
    const ok = await http(url + "/f/app-heslo", { method: "POST", body: form(secret) });
    assert.equal(ok.status, 200);
    assert.doesNotMatch(ok.body, new RegExp(secret));
    assert.equal(await d.exit, 0);
    assert.equal(readFileSync(join(dir, "app-heslo"), "utf8"), secret);
    assert.equal((statSync(join(dir, "app-heslo")).mode & 0o777).toString(8), "600");
    assert.deepEqual(readdirSync(dir), ["app-heslo"], "dočasný súbor ostal");
    assert.doesNotMatch(d.out.stdout + d.out.stderr, new RegExp(secret));
    assert.match(d.out.stdout, /\{"saved":\["app-heslo"\]\}\n$/);
  } finally {
    d.p.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secret_drop: viac polí, server beží do posledného, json sa overí", async () => {
  const dir = mkdir700();
  const d = start(["--dir", dir, "--port", "0", "--ttl", "30", "--field", "klient.json:json:Klient OAuth", "--field", "kod:text:Kód"]);
  try {
    const url = await d.url;
    assert.equal((await http(url + "/f/klient.json", { method: "POST", body: form("nie json") })).status, 400);
    assert.equal((await http(url + "/f/klient.json", { method: "POST", body: form("[1]") })).status, 400);
    assert.equal((await http(url + "/f/kod", { method: "POST", body: form("12\n34") })).status, 400);
    const j = '{"installed":{"client_id":"abc","client_secret":"xyz"}}';
    assert.equal((await http(url + "/f/klient.json", { method: "POST", body: form(j) })).status, 200);
    const mid = await http(url);
    assert.match(mid.body, /Uložené\./);
    assert.equal(d.p.exitCode, null, "server skončil pred posledným poľom");
    assert.equal((await http(url + "/f/kod", { method: "POST", body: form(" 123456 ") })).status, 200);
    assert.equal(await d.exit, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, "klient.json"), "utf8")).installed.client_id, "abc");
    assert.equal(readFileSync(join(dir, "kod"), "utf8"), "123456");
  } finally {
    d.p.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secret_drop: vypršanie času skončí kódom 3, zlý priečinok a zlé pole kódom 2", async () => {
  const dir = mkdir700();
  try {
    const t = start(["--dir", dir, "--port", "0", "--ttl", "1", "--field", "a"]);
    assert.equal(await t.exit, 3);
    const open = mkdtempSync(join(tmpdir(), "drop-open-"));
    chmodSync(open, 0o755);
    try {
      const r = spawnSync(process.execPath, [mjs, "--dir", open, "--port", "0", "--field", "a"], { encoding: "utf8" });
      assert.equal(r.status, 2);
      assert.match(r.stderr, /700/);
    } finally { rmSync(open, { recursive: true, force: true }); }
    assert.equal(spawnSync(process.execPath, [mjs, "--dir", dir, "--field", "../zle"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [mjs, "--dir", dir, "--field", "a:nezname"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [mjs, "--dir", dir], { encoding: "utf8" }).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const rootOk = process.getuid?.() === 0 && spawnSync("id", ["tasker-svc"]).status === 0;
test("secret_drop.sh: súbor patrí používateľovi, nie rootovi, hodnota nie je vo výpise", { skip: !rootOk && "treba root a používateľa tasker-svc" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "drop-sh-"));
  spawnSync("chown", ["tasker-svc:tasker-svc", dir]);
  chmodSync(dir, 0o700);
  const secret = "heslo-z-wrappera-987";
  const p = spawn(wrapper, ["--user", "tasker-svc", "--dir", dir, "--port", "18764", "--ttl", "30", "--field", "t:secret:Test"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  const exit = new Promise((r) => p.on("close", r));
  try {
    let url;
    for (let i = 0; i < 100 && !url; i++) { await new Promise((r) => setTimeout(r, 100)); url = out.match(/^(http\S+)\n/)?.[1]; }
    assert.ok(url, "bez odkazu: " + err);
    assert.equal((await http(url + "/f/t", { method: "POST", body: form(secret) })).status, 200);
    assert.equal(await exit, 0);
    assert.equal(readFileSync(join(dir, "t"), "utf8"), secret);
    const st = statSync(join(dir, "t"));
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(spawnSync("id", ["-u", "tasker-svc"], { encoding: "utf8" }).stdout.trim(), String(st.uid));
    assert.doesNotMatch(out + err, new RegExp(secret));
  } finally {
    p.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secret_drop.sh: root ako vlastník tajomstiev a cudzí priečinok sa odmietnu", { skip: !rootOk && "treba root" }, () => {
  assert.equal(spawnSync(wrapper, ["--user", "root", "--dir", "/tmp", "--field", "a"], { encoding: "utf8" }).status, 2);
  const dir = mkdtempSync(join(tmpdir(), "drop-own-"));
  try {
    const r = spawnSync(wrapper, ["--user", "tasker-svc", "--dir", dir, "--field", "a"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /nepatrí/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
