// Prehliadač pre agenta: Chrome so sandboxom, snímky obrazovky, text stránky
// a chyby konzoly. Beží pod používateľom bez roota, volá ho
// browser.sh (pod rootom ho odmietne, Chrome so sandboxom ho
// nespustí a --no-sandbox sa nepoužíva nikdy).
//
// Použitie: node browser.mjs (--url <url> | --file <html>) --out <priečinok>
//   [--width 1440,390] [--height 900] [--full-page] [--text] [--gaps [px]]
//   [--steps <súbor json | pole json>] [--profile-dir <priečinok>]
//
// --profile-dir otvorí trvalý profil (cookies a prihlásenie prežijú beh),
// priečinok vytvára browser.sh --profile s právami 700.
//
// --gaps [px] po krokoch nájde texty nalepené pod sebou (zvislá medzera pod
// px, predvolene 6) alebo prekryté (gaps.mjs) a zapíše ich do gaps-<šírka>.txt.
// Nález znamená kód 1.
//
// Kroky: [{"click":"sel"}, {"fill":"sel","text":"..."}, {"press":"Enter"},
//   {"wait":500}, {"wait":"sel"}, {"shot":"meno"}]. Každá šírka dostane novú
// stránku, kroky sa vykonajú pre každú. Výstup v --out: page-<šírka>.png
// (po krokoch), <meno>-<šírka>.png z kroku shot, text-<šírka>.txt s --text,
// console.txt (chyby a varovania konzoly, pageerror, zlyhané požiadavky,
// zlyhané kroky). Na stdout ide zoznam vzniknutých súborov, kód 1 pri
// zlyhanom kroku alebo chybe.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { collectBoxes, findGaps, formatGaps } from "./gaps.mjs";
import { openProfile } from "./session.mjs";

if (process.getuid && process.getuid() === 0) {
  console.error("browser.mjs: beží ako root, Chrome so sandboxom treba spustiť pod iným používateľom (browser.sh)");
  process.exit(1);
}

const flags = new Set(["full-page", "text"]);
const opt = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) { console.error(`neznámy argument ${a}`); process.exit(2); }
  const k = a.slice(2);
  if (k === "gaps") { opt.gaps = argv[i + 1] && /^\d+(\.\d+)?$/.test(argv[i + 1]) ? Number(argv[++i]) : 6; continue; }
  opt[k] = flags.has(k) ? true : argv[++i];
}
if (!opt.out || (!opt.url && !opt.file) || (opt.url && opt.file)) {
  console.error("použitie: browser.mjs (--url <url> | --file <html>) --out <priečinok> [--width 1440,390] [--height 900] [--full-page] [--text] [--gaps [px]] [--steps <json>] [--profile-dir <priečinok>]");
  process.exit(2);
}

const widths = String(opt.width ?? "1440").split(",").map(Number);
const height = Number(opt.height ?? 900);
if (widths.some((w) => !Number.isInteger(w) || w < 100) || !Number.isInteger(height) || height < 100) {
  console.error("šírka a výška musia byť celé čísla aspoň 100");
  process.exit(2);
}
let steps = [];
if (opt.steps) {
  const raw = opt.steps.trim().startsWith("[") ? opt.steps : readFileSync(opt.steps, "utf8");
  steps = JSON.parse(raw);
  if (!Array.isArray(steps)) { console.error("--steps musí byť pole"); process.exit(2); }
}
const target = opt.url ?? pathToFileURL(resolve(opt.file)).href;
const out = resolve(opt.out);
mkdirSync(out, { recursive: true });
const consoleLog = join(out, "console.txt");
writeFileSync(consoleLog, "");
const files = [];
const note = (w, s) => appendFileSync(consoleLog, `[${w}] ${s}\n`);

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

let failed = false;
const profileCtx = opt["profile-dir"] ? await openProfile({ dir: resolve(opt["profile-dir"]), viewport: { width: widths[0], height } }) : null;
const browser = profileCtx ?? await chromium.launch({ headless: true, chromiumSandbox: true });
try {
  for (const w of widths) {
    const page = profileCtx ? await profileCtx.newPage() : await browser.newPage({ viewport: { width: w, height } });
    if (profileCtx) await page.setViewportSize({ width: w, height });
    page.setDefaultTimeout(10000);
    page.on("console", (m) => { if (["error", "warning"].includes(m.type())) note(w, `console.${m.type()}: ${m.text()}`); });
    page.on("pageerror", (e) => note(w, `pageerror: ${e.message}`));
    page.on("requestfailed", (r) => note(w, `requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`));
    const shot = async (name) => {
      const f = `${name}-${w}.png`;
      await page.screenshot({ path: join(out, f), fullPage: !!opt["full-page"] });
      files.push(f);
    };
    try {
      await page.goto(target, { waitUntil: "load" });
      for (const [n, s] of steps.entries()) {
        try {
          if (s.click !== undefined) await page.click(s.click);
          else if (s.fill !== undefined) await page.fill(s.fill, String(s.text ?? ""));
          else if (s.press !== undefined) await page.keyboard.press(s.press);
          else if (s.wait !== undefined) {
            if (typeof s.wait === "number") await page.waitForTimeout(s.wait);
            else await page.waitForSelector(s.wait);
          } else if (s.shot !== undefined) await shot(String(s.shot).replace(/[^\w.-]/g, "_"));
          else throw new Error(`neznámy krok ${JSON.stringify(s)}`);
        } catch (e) {
          failed = true;
          note(w, `krok ${n + 1} zlyhal: ${e.message.split("\n")[0]}`);
          break;
        }
      }
      await shot("page");
      if (opt.gaps !== undefined) {
        const found = findGaps(await page.evaluate(collectBoxes), opt.gaps);
        const f = `gaps-${w}.txt`;
        writeFileSync(join(out, f), formatGaps(found) + (found.length ? "\n" : ""));
        files.push(f);
        if (found.length) { failed = true; note(w, `gaps: ${found.length} nálezov, pozri ${f}`); }
      }
      if (opt.text) {
        const f = `text-${w}.txt`;
        writeFileSync(join(out, f), await page.evaluate(() => document.body.innerText));
        files.push(f);
      }
    } catch (e) {
      failed = true;
      note(w, `chyba: ${e.message.split("\n")[0]}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
for (const f of [...files, "console.txt"]) if (existsSync(join(out, f))) console.log(f);
process.exit(failed ? 1 : 0);
