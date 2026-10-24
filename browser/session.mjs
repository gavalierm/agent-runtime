// Spoločné otvorenie Chrome so sandboxom pre skripty, ktoré spúšťa
// browser.sh pod používateľom bez roota (D0163). Používa ho browser.mjs
// (voľba --profile-dir) aj skripty spustené cez browser.sh --exec.
//
// openProfile() otvorí trvalý profil z BROWSER_PROFILE_DIR (browser.sh --profile),
// alebo dočasný, keď profil nie je zadaný. Sandbox ostáva zapnutý, --no-sandbox
// sa nepoužíva nikdy. Používateľský agent sa upraví na bežný Chrome, bezhlavý
// shell sa inak hlási ako HeadlessChrome. Keď je BROWSER_OFFLINE=1, Chrome
// preloží na adresu len 127.0.0.1 a localhost, všetko ostatné skončí chybou
// DNS (skúšky bez živého účtu, žiadne spojenie von).
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const require = createRequire(import.meta.url);

function chromeUserAgent() {
  // Verzia Chrome je v browsers.json balíka playwright-core, spúšťať prehliadač kvôli nej netreba.
  let ver = "130.0.0.0";
  try {
    const dir = dirname(require.resolve("playwright-core/package.json"));
    const b = JSON.parse(readFileSync(join(dir, "browsers.json"), "utf8")).browsers.find((x) => x.name === "chromium-headless-shell" || x.name === "chromium");
    if (b?.browserVersion) ver = `${b.browserVersion}${b.browserVersion.split(".").length === 3 ? ".0" : ""}`;
  } catch { /* zostane záložná verzia */ }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
}

export async function openProfile({ dir: profileDir, viewport = { width: 1440, height: 900 }, locale = "en-US" } = {}) {
  if (process.getuid && process.getuid() === 0) {
    throw new Error("session.mjs: beží ako root, Chrome so sandboxom treba spustiť pod používateľom bez roota (browser.sh)");
  }
  const { chromium } = require("playwright-core");
  const dir = profileDir || process.env.BROWSER_PROFILE_DIR || mkdtempSync(join(tmpdir(), "browser-profile-"));
  const args = [];
  if (process.env.BROWSER_OFFLINE === "1") {
    args.push("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost");
  }
  const context = await chromium.launchPersistentContext(dir, {
    headless: true,
    chromiumSandbox: true,
    viewport,
    locale,
    userAgent: chromeUserAgent(),
    args,
  });
  return context;
}
