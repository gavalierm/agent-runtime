// lib/plugins.mjs: kde ležia zapnuté pluginy a ich skilly. Zdieľa check.mjs
// a lib/plugin_skills_user_only.mjs, aby cestu k pluginu hľadal jeden kus kódu.

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const HOME = homedir();
export const CLAUDE = resolve(HOME, ".claude");

export function isDir(p) {
  try {
    return lstatSync(p).isDirectory() || (lstatSync(p).isSymbolicLink() && existsSync(p) && lstatSync(resolve(dirname(p), readlinkSync(p))).isDirectory());
  } catch {
    return false;
  }
}

export function entries(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// Priečinky so SKILL.md, do hĺbky depth pod dir.
export function skillDirs(dir, depth) {
  const out = [];
  for (const e of entries(dir)) {
    const p = join(dir, e);
    if (!isDir(p)) continue;
    if (existsSync(join(p, "SKILL.md"))) out.push(p);
    else if (depth > 0) out.push(...skillDirs(p, depth - 1));
  }
  return out;
}

// Zapnuté pluginy zo settings.enabledPlugins a ich koreň v cache. Aktívna
// verzia je installPath v installed_plugins.json; cache drží aj staré verzie,
// tie harness nečíta. root je null, keď plugin v cache chýba.
export function pluginRoots(settings) {
  let installed = {};
  try {
    installed = JSON.parse(readFileSync(join(CLAUDE, "plugins", "installed_plugins.json"), "utf8")).plugins || {};
  } catch {}
  const out = [];
  for (const [key, on] of Object.entries(settings.enabledPlugins || {})) {
    if (!on) continue;
    const [plugin, market] = key.split("@");
    let root = (installed[key] || []).find((i) => i.installPath && isDir(i.installPath))?.installPath;
    if (!root) {
      const base = join(CLAUDE, "plugins", "cache", market, plugin);
      const versions = entries(base).filter((v) => isDir(join(base, v))).sort();
      root = versions.length ? join(base, versions[versions.length - 1]) : null;
    }
    out.push({ key, plugin, root });
  }
  return out;
}

// Frontmatter SKILL.md ako text medzi prvými dvoma riadkami "---".
export function frontmatter(file) {
  return readFileSync(file, "utf8").split(/^---$/m)[1] || "";
}

// Pluginy, ktorých skilly volá aj model. Sú to technické postupy pre prácu
// agenta, rozhodnutie operátora 2026-10-14. Skilly ostatných pluginov
// spúšťa len operátor cez /plugin:meno.
export const MODEL_PLUGINS = new Set(["superpowers@claude-plugins-official"]);

// disable-model-invocation: true, skill vidí len operátor cez /meno, model nie.
export function userOnly(dir) {
  try {
    return /^disable-model-invocation:\s*true/m.test(frontmatter(join(dir, "SKILL.md")));
  } catch {
    return false;
  }
}
