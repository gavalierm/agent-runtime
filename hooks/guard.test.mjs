#!/usr/bin/env node
// guard.test.mjs — pripína správanie guard.mjs. Spusti: node hooks/guard.test.mjs
// Každý prípad: rola (cwd), nástroj, vstup, očakávané rozhodnutie
// ("allow" = hook mlčí).

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Test beží s HOME v dočasnom adresári, živý HOME (na serveri /root) sa nedotkne:
// fixtúra by tam založila ~/Work a živé kontroly by hlásili falošné odkazy.
// guard.mjs berie HOME pri načítaní a detský proces dedí process.env.
const TMP_HOME = realpathSync(mkdtempSync(join(tmpdir(), "guard_test_home_")));
process.env.HOME = TMP_HOME;
process.on("exit", () => rmSync(TMP_HOME, { recursive: true, force: true }));
const H = homedir();
const GUARD = join(dirname(fileURLToPath(import.meta.url)), "guard.mjs");
const PROJ = `${H}/Work/vyvoj/example_web`;
// Repo správcu je repo tohto hooku, meno priečinka sa mení (2026-10-16).
const META = resolve(dirname(GUARD), "..");
// Priečinok pamäte harnessu: cesta začiatku relácie s pomlčkami.
const mem = (dir) => dir.replace(/[^A-Za-z0-9]/g, "-");
const AREA = `${H}/Work/agenti`;
const BORIS = `${H}/Work/agenti/boris`;
const ROOT = `${H}/Work`;

const W = (cwd, file_path) => ({ cwd, tool_name: "Write", tool_input: { file_path, content: "" } });
const E = (cwd, file_path) => ({ cwd, tool_name: "Edit", tool_input: { file_path, old_string: "a", new_string: "b" } });
const B = (cwd, command) => ({ cwd, tool_name: "Bash", tool_input: { command } });

// Dočasný agent s jedným projektom v permissions.additionalDirectories.
const FIX = `${H}/Work/agenti/.guard_test_${process.pid}`;
mkdirSync(`${FIX}/.claude`, { recursive: true });
writeFileSync(`${FIX}/.claude/settings.json`, JSON.stringify({ permissions: { additionalDirectories: [PROJ] } }));

const cases = [
  // projekty agenta s identitou z permissions.additionalDirectories
  [W(FIX, `${PROJ}/src/a.js`), "allow"],
  [B(FIX, `cd ${PROJ} && touch x`), "allow"],
  [W(FIX, `${H}/Work/vyvoj/goodfest/index.php`), "ask"],
  // zápis mimo územia ide operátorovi, nie koncové zamietnutie (2026-10-19,
  // Cyril nemohol na pokyn operátora opraviť skript v ~/Work/vyvoj)
  [W(`${H}/Work/agenti/cyril`, `${H}/Work/vyvoj/macos_utils/brightness_control/x.sh`), "ask"],
  [W(`${H}/Work/agenti/cyril`, `${H}/Library/LaunchAgents/x.plist`), "ask"],
  [B(`${H}/Work/agenti/cyril`, `cp x.plist ${H}/Library/LaunchAgents/x.plist`), "ask"],
  // projekt
  [W(PROJ, `${PROJ}/src/a.js`), "allow"],
  [W(PROJ, "src/a.js"), "allow"],
  [W(PROJ, `${PROJ}/.scratch/x`), "allow"],
  [W(PROJ, "/tmp/x"), "ask"],
  [W(PROJ, `${H}/Work/vyvoj/goodfest/index.php`), "ask"],
  [W(PROJ, "../goodfest/index.php"), "ask"],
  [E(PROJ, `${H}/.claude/CLAUDE.md`), "ask"],
  [B(PROJ, "echo hi > /tmp/x"), "ask"],
  [B(PROJ, "curl -s https://x | tee /tmp/y.html"), "ask"],
  [B(PROJ, "curl -o /tmp/x https://example.com"), "ask"],
  [B(PROJ, "mktemp"), "ask"],
  [B(PROJ, "rm -rf ../goodfest"), "ask"],
  [B(PROJ, "cd /Users/svc/Work/vyvoj/goodfest && touch x"), "ask"],
  [B(PROJ, `sed -i '' s/a/b/ ${H}/Work/vyvoj/goodfest/f`), "ask"],
  // plist mimo územia, prípad z agenti 2026-10-16: plutil -replace prešiel
  [B(META, `P=~/Library/LaunchAgents/a.plist && plutil -replace StartInterval -integer 300 $P`), "ask"],
  [B(META, `plutil -replace StartInterval -integer 300 ${H}/Library/LaunchAgents/a.plist`), "ask"],
  [B(META, `/usr/libexec/PlistBuddy -c "Set :X 1" ${H}/Library/LaunchAgents/a.plist`), "ask"],
  [B(META, `plutil -replace X -integer 1 ${H}/Library/Preferences/a.plist`), "ask"],
  [B(PROJ, `cp a.plist ${H}/Library/LaunchAgents/`), "ask"],
  [B(META, "defaults write com.apple.dock autohide -bool true"), "ask"],
  [B(META, `plutil -p ${H}/Library/LaunchAgents/a.plist`), "allow"],
  [B(META, "defaults read com.apple.dock"), "allow"],
  [B(PROJ, `sed -i '' -e 's#/a#/b#' ${H}/Work/vyvoj/goodfest/f`), "ask"],
  [B(PROJ, "cd ../goodfest && sed -i '' s/a/b/ f"), "ask"],
  [B(PROJ, "sed 's#<b>#x#' index.html > /tmp/x"), "ask"],
  [B(PROJ, "perl -pi -e 's/a/b/' /tmp/x"), "ask"],
  // lomky a > v skripte sed a perl nie sú cesty, prípad z example_web 2026-10-05
  [B(PROJ, "sed -i -E '/section-lead__headline/ s#(</span>)<br>[^<]*(</h2>)#\\1\\2#' index.html"), "allow"],
  [B(PROJ, "sed -i '' 's#<b>/tmp/x#y#' index.html"), "allow"],
  [B(PROJ, "sed -i '' -e '/^#/d' -e 's#/a#/b#' index.html"), "allow"],
  [B(PROJ, "perl -pi -e 's{/a}{/b}' index.html"), "allow"],
  // operátory v úvodzovkách nie sú operátory, prípad z agenti 2026-10-05
  [B(PROJ, "jq -r 'a | b; c' f.json | sed -E 's/(A|b )[^ ]+/\\1<x>/g'"), "allow"],
  [B(PROJ, 'echo "a > /tmp/x"'), "allow"],
  [B(PROJ, 'echo hi > "/tmp/x y"'), "ask"],
  [B(PROJ, "sed -i -E 's#(a|b)#x#' ../goodfest/f"), "ask"],
  [B(PROJ, `git clone git@github.com:x/y.git ${H}/Work/vyvoj/y`), "ask"],
  [B(PROJ, "mkdir ~/Work/vyvoj/novy"), "ask"],
  // spustiteľný súbor zadaný cestou nie je cieľ zápisu, prípad z agenti/cyril 2026-10-15
  [B(PROJ, "/bin/rm -f .scratch/x"), "allow"],
  [B(PROJ, "sudo /bin/rm -f .scratch/x"), "allow"],
  [B(PROJ, "ls && /bin/mkdir -p .scratch/a"), "allow"],
  [B(PROJ, "/usr/bin/sed -i '' s/a/b/ .scratch/x"), "allow"],
  [B(PROJ, "/opt/homebrew/bin/curl -so .scratch/x https://x"), "allow"],
  [B(PROJ, "/bin/rm -f /tmp/x"), "ask"],
  [B(PROJ, "sudo /bin/rm -f ../goodfest/x"), "ask"],
  [B(PROJ, "ls && /bin/mkdir -p /tmp/a"), "ask"],
  [B(PROJ, "/usr/bin/sed -i '' s/a/b/ /tmp/x"), "ask"],
  [B(PROJ, "/opt/homebrew/bin/curl -so /tmp/x https://x"), "ask"],
  // spúšťač env alebo xargs pred príkazom, medzera z auditu 2026-10-15
  [B(PROJ, "env X=1 rm -f /tmp/x"), "ask"],
  [B(PROJ, "ls | xargs rm -f /tmp/x"), "ask"],
  [B(PROJ, "ls | xargs -0 -n 1 rm -f /tmp/x"), "ask"],
  [B(PROJ, "env X=1 rm -f .scratch/x"), "allow"],
  [B(PROJ, "ls | xargs rm -f .scratch/x"), "allow"],
  [B(PROJ, "echo hi > .scratch/x"), "allow"],
  [B(PROJ, "cp /etc/hosts ./hosts"), "allow"],
  [B(PROJ, `cd .scratch/z && unzip -q -o "${H}/Desktop/a b.zip" -x "__MACOSX/*"`), "allow"],
  [B(PROJ, `unzip -q x.zip -d ${H}/Desktop/out`), "ask"],
  [B(PROJ, `unzip -l ${H}/Desktop/x.zip`), "allow"],
  [B(PROJ, "cat /etc/hosts"), "allow"],
  [B(PROJ, "ls /Users/svc/Work/vyvoj"), "allow"],
  [B(PROJ, `git -C ${H}/Work/vyvoj/goodfest log -1`), "allow"],
  [B(PROJ, "npm test 2>/dev/null"), "allow"],
  [B(PROJ, "echo x >&2"), "allow"],
  // zátvorka za presmerovaním nie je časť cesty, prípad z agenti/cyril 2026-10-14
  [B(PROJ, "time (node x.mjs > /dev/null)"), "allow"],
  [B(PROJ, "(echo x > /tmp/x)"), "ask"],
  [B(PROJ, "rm -rf build && mkdir build"), "allow"],
  [B(PROJ, "git clone git@github.com:x/y.git"), "allow"],
  [B(PROJ, `curl -s https://x | grep y`), "allow"],
  // cesta v tele požiadavky curl nie je cieľ zápisu, prípad z agenti/cyril 2026-10-16
  [B(META, `K=$(cat .scratch/api_key) && P=https://ulohy.example/api && curl -s -X POST -H "Authorization: Bearer $K" -H 'content-type: application/json' "$P/companies/X/issues" -d '{"title":"t","description":"Zmaž /data/test-codebase-boris v kontajneri"}' | python3 -c 'import sys,json;print(1)'`), "allow"],
  [B(PROJ, "curl -s -d @/etc/hosts -H 'X: /tmp/y' https://x"), "allow"],
  [B(PROJ, "curl -sSXPOST https://x"), "allow"],
  [B(PROJ, "wget -qO- https://x/a | grep y"), "allow"],
  [B(PROJ, "curl -sSL -o .scratch/x https://x"), "allow"],
  [B(META, "curl -o /data/x https://x"), "ask"],
  [B(META, "curl -s https://x > /data/x"), "ask"],
  [B(META, "curl -d '/data/a' -o/data/x https://x"), "ask"],
  [B(PROJ, "curl -sSLo /tmp/x https://x"), "ask"],
  [B(PROJ, "curl --output=/tmp/x https://x"), "ask"],
  [B(PROJ, "curl -D /tmp/h -s https://x"), "ask"],
  [B(PROJ, "curl -O --output-dir /tmp https://x/a"), "ask"],
  [B(PROJ, "cd /tmp && curl -O https://x/a"), "ask"],
  [B(PROJ, "wget -O /tmp/x https://x"), "ask"],
  [B(PROJ, "wget -P /tmp https://x"), "ask"],
  [B(PROJ, "cd /tmp && wget https://x"), "ask"],
  // telo heredocu nie je príkaz, riadky za ním áno, prípad z agenti 2026-10-13
  [B(PROJ, "cat >> POZNAMKY.md <<'EOF'\npriečinok `<meno>/memory`. A rm -rf /tmp/x\nEOF\ngit add POZNAMKY.md"), "allow"],
  [B(PROJ, "python3 - <<'EOF'\nopen('/etc/hosts').read()\nEOF"), "allow"],
  [B(PROJ, "cat > /tmp/x <<EOF\nahoj\nEOF"), "ask"],
  [B(PROJ, "cat >> POZNAMKY.md <<'EOF'\nahoj\nEOF\nrm -rf ../goodfest"), "ask"],
  // cd v tele heredocu je obsah, nemení adresár ďalších príkazov, replay 2026-10-16
  [B(PROJ, "cat > .scratch/x.sh <<'EOF'\ncd /tmp\nEOF\ntouch y"), "allow"],
  [B(PROJ, "cat <<EOF > .scratch/x\ncd /tmp && rm -rf foo\nEOF\nchmod +x .scratch/x"), "allow"],
  [B(PROJ, "python3 - <<'EOF'\nimport os\nos.system('cd /tmp; touch x')\nEOF\nls > .scratch/l"), "allow"],
  [B(PROJ, "git commit -m \"$(cat <<'EOF'\nText\ncd /tmp\nEOF\n)\" && touch x"), "allow"],
  [B(PROJ, "tee .scratch/x <<'EOF'\n/tmp/a\nEOF"), "allow"],
  [B(PROJ, "cat > .scratch/x <<'EOF'\nahoj\nEOF\ncd /tmp && touch x"), "ask"],
  [B(PROJ, "cd /tmp && cat > x <<'EOF'\nahoj\nEOF"), "ask"],
  [B(PROJ, "tee /tmp/x <<'EOF'\nahoj\nEOF"), "ask"],
  [B(PROJ, "echo hi\ntouch /tmp/x"), "ask"],
  [B(PROJ, "cp index.html \\\n  /tmp/x"), "ask"],
  // vlastná pamäť harnessu je voľná, cudzia nie, prípad z 2026-10-13
  [W(PROJ, `${H}/.claude/projects/${mem(PROJ)}/memory/x.md`), "allow"],
  [W(PROJ, `${H}/.claude/projects/${mem(PROJ)}/memory/MEMORY.md`), "allow"],
  [B(PROJ, `rm ~/.claude/projects/${mem(PROJ)}/memory/x.md`), "allow"],
  [W(PROJ, `${H}/.claude/projects/${mem(PROJ)}/x.jsonl`), "ask"],
  [W(PROJ, `${H}/.claude/projects/${META.replace(/[^A-Za-z0-9]/g, "-")}/memory/x.md`), "ask"],
  [W(META, `${H}/.claude/projects/${META.replace(/[^A-Za-z0-9]/g, "-")}/memory/x.md`), "allow"],
  [W(META, `${H}/.claude/projects/${mem(PROJ)}/memory/x.md`), "ask"],
  [W(ROOT, `${H}/.claude/projects/${mem(ROOT)}/memory/x.md`), "allow"],
  // repo pravidiel, konfigurácia agentov voľne, štruktúra ~/Work so súhlasom, rozhodnutie 2026-10-14
  [W(META, `${META}/skills/x/SKILL.md`), "allow"],
  [W(META, `${BORIS}/PERSONA.md`), "allow"],
  [B(META, `git -C ${BORIS} commit -m x`), "allow"],
  [W(META, `${H}/.claude/CLAUDE.md`), "ask"],
  [W(META, `${H}/.claude/settings.json`), "ask"],
  [E(META, `${H}/Work/vyvoj/goodfest/CLAUDE.md`), "allow"],
  [W(META, `${H}/Work/vyvoj/goodfest/PERSONA.md`), "allow"],
  [W(META, `${H}/Work/vyvoj/goodfest/.claude/settings.json`), "allow"],
  [W(META, `${H}/Work/CLAUDE.md`), "allow"],
  [W(META, `${H}/Work/vyvoj/goodfest/index.php`), "ask"],
  [B(META, `mv ${H}/Work/projekty/stary ${H}/Work/vyvoj/examplehost`), "ask"],
  [W(META, "/tmp/x"), "ask"],
  [B(META, "ln -s ~/Work/agenti/cyril/skills/x ~/.claude/skills/x"), "ask"],
  [B(META, "./install.sh"), "allow"],
  // ~/Work/agenti nie je repo pravidiel, nemá zábranu jednej relácie, chyba z 2026-10-14
  [W(AREA, `${BORIS}/x.md`), "ask"],
  [E(AREA, `${META}/PERSONA.md`), "ask"],
  [B(AREA, "echo x > adam/PERSONA.md"), "ask"],
  [W(AREA, `${AREA}/.scratch/x`), "allow"],
  [W(AREA, `${H}/Work/CLAUDE.md`), "ask"],
  // agent s identitou, zápis do persony potvrdí operátor (2026-10-19)
  [W(BORIS, `${BORIS}/memory/x.md`), "allow"],
  [W(BORIS, `${BORIS}/.scratch/x`), "allow"],
  [E(BORIS, `${BORIS}/PERSONA.md`), "ask"],
  [E(BORIS, `${BORIS}/CLAUDE.md`), "ask"],
  [W(BORIS, `${BORIS}/.claude/settings.json`), "ask"],
  [W(BORIS, `${BORIS}/skills/x/SKILL.md`), "ask"],
  [B(BORIS, "echo x >> PERSONA.md"), "ask"],
  [W(BORIS, `${META}/PERSONA.md`), "ask"],
  [W(BORIS, `${H}/Work/vyvoj/examplehost/x`), "ask"],
  // koreň
  [W(ROOT, `${ROOT}/.scratch/prehlad.md`), "allow"],
  [B(ROOT, "mkdir ~/Work/vyvoj/novy"), "ask"],
  [B(ROOT, `mv ${ROOT}/vyvoj/test ${ROOT}/archiv/vyvoj/`), "ask"],
  [W(ROOT, "/tmp/x"), "ask"],
  [B(ROOT, "find ~/Work -name .git"), "allow"],
  // mimo ~/Work
  [W(`${H}/Downloads`, `${H}/Downloads/a.txt`), "allow"],
  [W(`${H}/Downloads`, `${H}/Desktop/a.txt`), "ask"],
];

let fail = 0;
for (const [input, want] of cases) {
  const r = spawnSync("node", [GUARD], { input: JSON.stringify(input), encoding: "utf8" });
  let got = "allow";
  if (r.stdout.trim()) got = JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
  const label = `${input.cwd.replace(H, "~")} ${input.tool_name} ${input.tool_input.command ?? input.tool_input.file_path}`;
  if (got !== want || r.status !== 0) {
    fail++;
    console.log(`✗ ${label}\n    chcem ${want}, mám ${got} (exit ${r.status}) ${r.stderr.trim()}`);
  }
}
console.log(fail ? `${fail}/${cases.length} zlyhalo` : `${cases.length} prípadov v poriadku`);
process.exit(fail ? 1 : 0);
