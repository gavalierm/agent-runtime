// Jednorazová stránka, cez ktorú operátor odovzdá tajomstvo (heslo pre aplikáciu,
// heslo k Apple ID, kód dvojfázového overenia, klient OAuth, adresa z prehliadača)
// priamo do súboru s právami 600. Hodnota neprejde prepisom vlákna T3, databázou
// T3, argumentom príkazu ani výpisom skriptu (úloha 482, D0163).
//
// Použitie: node secret_drop.mjs --dir <priečinok> --field <názov[:druh[:popis]]> ...
//   [--port 8804] [--ttl 900] [--public-base https://host:port]
//
// --dir     priečinok tajomstiev, musí existovať, patriť používateľovi procesu
//           a mať práva 700 (napríklad ~agent/.config/agent).
// --field   súbor v --dir a druh poľa: secret (predvolené, heslo, skryté),
//           text (jednoriadkový, viditeľný, napríklad kód z telefónu),
//           textarea (viacriadkový, skrytý nie je), json (textarea, musí byť
//           platný JSON objekt). Popis je text nad poľom. Názov súboru má tvar
//           [a-z0-9][a-z0-9._-]*.
// --port    port na 127.0.0.1, 0 vyberie voľný. Predvolene 8804.
// --ttl     po koľkých sekundách server skončí kódom 3. Predvolene 900.
// --public-base  adresa, pod ktorou stránku uvidí operátor (tailscale serve),
//                vypíše sa ako odkaz a jej hostiteľ sa pustí cez kontrolu Host.
//
// Server počúva len na 127.0.0.1. Odkaz nesie náhodný token (24 bajtov),
// POST bez neho vráti 404. Hodnoty sa nelogujú, na stderr ide len názov
// súboru a dĺžka. Stdout: prvý riadok odkaz, na konci riadok JSON
// {"saved":[...]}. Kód 0 sú uložené všetky polia, 2 zlé použitie alebo
// priečinok, 3 vypršal čas.
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { openSync, writeSync, closeSync, renameSync, chmodSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const KINDS = new Set(["secret", "text", "textarea", "json"]);
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_BODY = 64 * 1024;

export function parseField(spec) {
  const i1 = spec.indexOf(":");
  const name = i1 < 0 ? spec : spec.slice(0, i1);
  const rest = i1 < 0 ? "" : spec.slice(i1 + 1);
  const i2 = rest.indexOf(":");
  const kind = (i2 < 0 ? rest : rest.slice(0, i2)) || "secret";
  const label = i2 < 0 ? name : rest.slice(i2 + 1) || name;
  if (!NAME_RE.test(name)) throw new Error(`zlý názov súboru ${JSON.stringify(name)}`);
  if (!KINDS.has(kind)) throw new Error(`neznámy druh poľa ${JSON.stringify(kind)}`);
  return { name, kind, label };
}

export function validateValue(kind, raw) {
  const v = raw.trim();
  if (!v) return { error: "Pole je prázdne." };
  if ((kind === "secret" || kind === "text") && /[\r\n]/.test(v)) return { error: "Hodnota nemá mať viac riadkov." };
  if (kind === "json") {
    try {
      const j = JSON.parse(v);
      if (j === null || typeof j !== "object" || Array.isArray(j)) return { error: "Čakám JSON objekt." };
    } catch {
      return { error: "Nie je to platný JSON. Vlož celý obsah súboru." };
    }
  }
  return { value: v };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(body) {
  return `<!doctype html><html lang="sk"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Odovzdanie tajomstva</title>
<style>:root{color-scheme:dark;--bg:#12151b;--fg:#e6e9ee;--mut:#c3cad5;--line:#39414d;--ok:#7fd49a;--bad:#ff9b9b}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem}
h1{font-size:1.5rem;margin:0 0 1rem}form{border:1px solid var(--line);border-radius:8px;padding:1rem;margin:0 0 1rem}
label{display:block;font-size:.8rem;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin-bottom:.4rem}
input,textarea{width:100%;box-sizing:border-box;background:#0b0d11;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:.6rem;font:inherit}
textarea{min-height:9rem}button{margin-top:.7rem;background:#2f6feb;color:#fff;border:0;border-radius:6px;padding:.6rem 1.1rem;font:inherit;cursor:pointer}
.ok{color:var(--ok)}.bad{color:var(--bad)}.mut{color:var(--mut);font-size:.9rem}</style>
${body}</html>`;
}

export function startDrop({ dir, fields, port = 8804, ttl = 900, publicBase = "", log = () => {} }) {
  const st = statSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) {
    throw Object.assign(new Error(`${dir} musí byť priečinok používateľa procesu s právami 700`), { code: "BADDIR" });
  }
  const token = randomBytes(24).toString("base64url");
  const base = `/s/${token}`;
  const saved = new Set();
  const publicHost = publicBase ? new URL(publicBase).hostname : null;
  const tokenBuf = Buffer.from(token);
  const tokenOk = (t) => {
    const b = Buffer.from(t ?? "");
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };

  const render = (msg) => {
    const forms = fields.map((f) => {
      const done = saved.has(f.name);
      const input = f.kind === "textarea" || f.kind === "json"
        ? `<textarea name="value" autocomplete="off" spellcheck="false" ${done ? "" : "required"}></textarea>`
        : `<input name="value" type="${f.kind === "secret" ? "password" : "text"}" autocomplete="off" spellcheck="false" ${done ? "" : "required"}>`;
      return `<form method="post" action="${base}/f/${esc(f.name)}"><label for="v-${esc(f.name)}">${esc(f.label)}</label>${input.replace("name=\"value\"", `name="value" id="v-${esc(f.name)}"`)}
<div>${done ? '<span class="ok">Uložené.</span> ' : ""}<button type="submit">${done ? "Uložiť znova" : "Uložiť"}</button></div></form>`;
    }).join("\n");
    const all = fields.every((f) => saved.has(f.name));
    return page(`<h1>Odovzdanie tajomstva</h1>
${msg ? `<p class="${msg.bad ? "bad" : "ok"}">${esc(msg.text)}</p>` : ""}
${all ? '<p class="ok">Všetko je uložené. Okno môžeš zavrieť.</p>' : '<p class="mut">Hodnota ide priamo do súboru na serveri s právami 600. Do chatu ju nepíš.</p>'}
${forms}`);
  };

  let timer;
  const server = createServer((req, res) => {
    const send = (code, html, extra = {}) => {
      res.writeHead(code, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
        ...extra,
      });
      res.end(html);
    };
    const hostName = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", publicHost].includes(hostName)) return send(421, page("<p class='bad'>Zlý hostiteľ.</p>"));
    const url = new URL(req.url, "http://x");
    const m = url.pathname.match(/^\/s\/([^/]+)(?:\/f\/([^/]+))?\/?$/);
    if (!m || !tokenOk(m[1])) return send(404, page("<p class='bad'>Odkaz neplatí.</p>"));
    if (req.method === "GET" && !m[2]) return send(200, render());
    if (req.method === "POST" && m[2]) {
      const field = fields.find((f) => f.name === decodeURIComponent(m[2]));
      if (!field) return send(404, page("<p class='bad'>Také pole nie je.</p>"));
      let size = 0;
      const chunks = [];
      let tooBig = false;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) tooBig = true;
        else chunks.push(c);
      });
      req.on("end", () => {
        if (tooBig) return send(413, render({ bad: true, text: "Hodnota je príliš dlhá." }));
        const raw = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("value") ?? "";
        const v = validateValue(field.kind, raw);
        if (v.error) return send(400, render({ bad: true, text: `${field.label}: ${v.error}` }));
        const target = join(dir, field.name);
        const tmp = join(dir, `.${field.name}.${process.pid}.tmp`);
        try {
          const fd = openSync(tmp, "w", 0o600);
          writeSync(fd, v.value + (field.kind === "json" || field.kind === "textarea" ? "\n" : ""));
          closeSync(fd);
          chmodSync(tmp, 0o600);
          renameSync(tmp, target);
        } catch (e) {
          try { unlinkSync(tmp); } catch { /* nič */ }
          log(`zápis ${field.name} zlyhal: ${e.code ?? e.message}`);
          return send(500, render({ bad: true, text: "Zápis na serveri zlyhal." }));
        }
        saved.add(field.name);
        log(`uložené ${field.name} (${Buffer.byteLength(v.value)} B)`);
        send(200, render({ text: `${field.label}: uložené.` }));
        if (fields.every((f) => saved.has(f.name))) {
          res.on("finish", () => setTimeout(() => api.finish(0), 200));
        }
      });
      return;
    }
    send(405, page("<p class='bad'>Nepodporovaná metóda.</p>"));
  });

  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const api = {
    token,
    saved,
    done,
    listen: () => new Promise((resolve) => {
      server.listen(port, "127.0.0.1", () => {
        api.port = server.address().port;
        api.localUrl = `http://127.0.0.1:${api.port}${base}`;
        api.url = publicBase ? `${publicBase.replace(/\/$/, "")}${base}` : api.localUrl;
        timer = setTimeout(() => api.finish(3), ttl * 1000);
        resolve(api);
      });
    }),
    finish: (code) => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      resolveDone(code);
    },
  };
  return api;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const opt = { field: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--") || i + 1 >= argv.length) { console.error(`zlý argument ${a}`); process.exit(2); }
    const k = a.slice(2);
    if (k === "field") opt.field.push(argv[++i]);
    else opt[k] = argv[++i];
  }
  let drop;
  try {
    if (!opt.dir || opt.field.length === 0) throw new Error("použitie: secret_drop.mjs --dir <priečinok> --field <názov[:druh[:popis]]> ... [--port N] [--ttl s] [--public-base url]");
    const fields = opt.field.map(parseField);
    if (new Set(fields.map((f) => f.name)).size !== fields.length) throw new Error("názvy polí sa opakujú");
    drop = startDrop({
      dir: opt.dir,
      fields,
      port: Number(opt.port ?? 8804),
      ttl: Number(opt.ttl ?? 900),
      publicBase: opt["public-base"] ?? "",
      log: (s) => console.error(`secret_drop: ${s}`),
    });
  } catch (e) {
    console.error(`secret_drop: ${e.message}`);
    process.exit(2);
  }
  await drop.listen();
  console.log(drop.url);
  const code = await drop.done;
  if (code === 0) console.log(JSON.stringify({ saved: [...drop.saved] }));
  else console.error("secret_drop: čas vypršal, uložené: " + ([...drop.saved].join(", ") || "nič"));
  process.exit(code);
}
