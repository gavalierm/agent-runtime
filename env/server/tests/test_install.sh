#!/bin/bash
# Test env/server/install.sh. Skript beží z tohto repa ako klon kódu, spoločný
# mozog, ~/.claude rootu, koreň prostredia, domov používateľa behov a
# jednotky systemd sú v $T. Test nevolá živý systemctl, nesiaha na /root/.claude,
# /opt ani /home: každá cesta ide cez AR_* a AGENT_BRAIN_GLOBAL do $T,
# git config ide do $T/gitconfig (lib.sh nastaví GIT_CONFIG_GLOBAL).
# shellcheck disable=SC2016
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
WF="$REPO"
BR="$T/brain"
S="$WF/env/server/install.sh"
OLD="$T/old"

# Spoločný mozog: pravidlá, pravidlá servera, konfigurácia, jeden skill.
mkdir -p "$BR/env/server" "$BR/skills/brain-skill" "$BR/commit_guard"
echo "# pravidlá mozgu" > "$BR/RULES.md"
echo "# pravidlá servera" > "$BR/env/server/RULES.md"
echo "# skill mozgu" > "$BR/skills/brain-skill/SKILL.md"
cat > "$BR/env/server/config.env" <<EOF
RUNS_USER=tasker-svc
GIT_EMAIL=agent@example.org
LEGACY_PATHS="$OLD"
LEGACY_UNITS="old-sync.timer old-sync.service"
EOF
# Starý klon, z ktorého ostali odkazy.
mkdir -p "$OLD/skills/stary-skill" "$OLD/agents"
echo x > "$OLD/pravidla.md"
echo x > "$OLD/skills/stary-skill/SKILL.md"
echo x > "$OLD/agents/stary.md"

export AGENT_BRAIN_GLOBAL="$BR"
export AR_CLAUDE_DIR="$T/claude" AR_UNIT_DIR="$T/units" AR_ENV_ROOT="$T/root" AR_RUNS_HOME="$T/runs"
export AR_NO_SYSTEMCTL=1
mkdir -p "$AR_CLAUDE_DIR/skills/unslop" "$AR_CLAUDE_DIR/agents" "$AR_UNIT_DIR" "$AR_ENV_ROOT" "$AR_RUNS_HOME/.claude/skills"
# Stav po starej inštalácii: CLAUDE.md je odkaz do starého klonu, unslop je
# obyčajný priečinok, odkazy na zmazané veci, staré jednotky, cudzie veci.
ln -s "$OLD/pravidla.md" "$AR_CLAUDE_DIR/CLAUDE.md"
echo stary > "$AR_CLAUDE_DIR/skills/unslop/SKILL.md"
ln -s "$OLD/skills/stary-skill" "$AR_CLAUDE_DIR/skills/stary-skill"
ln -s "$OLD/agents/stary.md" "$AR_CLAUDE_DIR/agents/stary.md"
ln -s /etc/hostname "$AR_CLAUDE_DIR/skills/cudzi"
ln -s "$OLD/skills/stary-skill" "$AR_RUNS_HOME/.claude/skills/stary-skill"
echo "stara jednotka" > "$AR_UNIT_DIR/old-sync.timer"
echo "stara jednotka" > "$AR_UNIT_DIR/old-sync.service"
# Používateľ behov má vlastné riadky a starý import v CLAUDE.md.
printf 'vlastný riadok\n@%s/pravidla.md\n' "$OLD" > "$AR_RUNS_HOME/.claude/CLAUDE.md"
# Existujúce nastavenia: cudzie kľúče, cudzí hook a hook zo starého klonu.
echo '{"permissions": {"deny": ["Bash(mkfs *)"]}, "hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "iny"}]}, {"hooks": [{"type": "command", "command": "node /opt/stary/hooks/unslop.mjs"}]}], "Stop": [{"hooks": [{"type": "command", "command": "node /opt/stary/hooks/reply_guard.mjs"}]}]}}' > "$AR_CLAUDE_DIR/settings.json"
echo '{"model": "x", "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "node /opt/stary/hooks/tool_failure_report.mjs"}]}, {"hooks": [{"type": "command", "command": "iny-beh"}]}]}}' > "$AR_RUNS_HOME/.claude/settings.json"
# Falošný systemctl: zapisuje volania do $T/systemctl.log.
fake systemctl 'echo "SYSTEMCTL $*" >> "'"$T"'/systemctl.log"'

# jq_ súbor výraz: hodnota výrazu nad JSON súborom (premenná d)
jq_() { python3 -c 'import json, sys; d = json.load(open(sys.argv[1])); print(json.dumps(eval(sys.argv[2])))' "$@"; }
# cmds súbor: všetky príkazy hookov súboru, čiarkou oddelené
cmds() { jq_ "$1" '",".join(h["command"] for ev in d["hooks"].values() for g in ev for h in g["hooks"])'; }

check "nainštaluje" 0 "$S"
contains "hlási nasadenie" "Nasadené: kód $WF, mozog $BR"
# CLAUDE.md
check "CLAUDE.md rootu je súbor, nie odkaz" 1 test -L "$AR_CLAUDE_DIR/CLAUDE.md"
check "CLAUDE.md rootu má import kódu" 0 grep -qxF "@$WF/RULES.md" "$AR_CLAUDE_DIR/CLAUDE.md"
check "CLAUDE.md rootu má import mozgu" 0 grep -qxF "@$BR/RULES.md" "$AR_CLAUDE_DIR/CLAUDE.md"
check "CLAUDE.md rootu má dva riadky" 0 test "$(wc -l < "$AR_CLAUDE_DIR/CLAUDE.md")" = 2
check "starý odkaz CLAUDE.md je odložený" 0 test -L "$AR_CLAUDE_DIR/pred-odkazom/CLAUDE.md"
check "CLAUDE.md používateľa behov: vlastný riadok ostal" 0 grep -qxF "vlastný riadok" "$AR_RUNS_HOME/.claude/CLAUDE.md"
check "CLAUDE.md používateľa behov: starý import zmizol" 1 grep -qF "$OLD" "$AR_RUNS_HOME/.claude/CLAUDE.md"
check "CLAUDE.md používateľa behov: import kódu" 0 grep -qxF "@$WF/RULES.md" "$AR_RUNS_HOME/.claude/CLAUDE.md"
check "CLAUDE.md používateľa behov: import mozgu" 0 grep -qxF "@$BR/RULES.md" "$AR_RUNS_HOME/.claude/CLAUDE.md"
# Pravidlá prostredia
check "koreň prostredia: odkaz na RULES.md servera v mozgu" 0 test "$(readlink "$AR_ENV_ROOT/CLAUDE.md")" = "$BR/env/server/RULES.md"
check "domov používateľa behov: odkaz na RULES.md servera v mozgu" 0 test "$(readlink "$AR_RUNS_HOME/CLAUDE.md")" = "$BR/env/server/RULES.md"
# Skilly z oboch klonov
for sk in unslop error; do
    check "root: skill $sk z kódu" 0 test "$(readlink "$AR_CLAUDE_DIR/skills/$sk")" = "$WF/skills/$sk"
    check "používateľ behov: skill $sk z kódu" 0 test "$(readlink "$AR_RUNS_HOME/.claude/skills/$sk")" = "$WF/skills/$sk"
done
check "root: skill z mozgu" 0 test "$(readlink "$AR_CLAUDE_DIR/skills/brain-skill")" = "$BR/skills/brain-skill"
check "používateľ behov: skill z mozgu" 0 test "$(readlink "$AR_RUNS_HOME/.claude/skills/brain-skill")" = "$BR/skills/brain-skill"
check "starý unslop je odložený mimo skills" 0 grep -q stary "$AR_CLAUDE_DIR/pred-odkazom/unslop/SKILL.md"
check "odkaz do starého klonu zmizol (skill rootu)" 1 test -L "$AR_CLAUDE_DIR/skills/stary-skill"
check "odkaz do starého klonu zmizol (agent rootu)" 1 test -L "$AR_CLAUDE_DIR/agents/stary.md"
check "odkaz do starého klonu zmizol (skill používateľa behov)" 1 test -L "$AR_RUNS_HOME/.claude/skills/stary-skill"
check "cudzí odkaz ostane" 0 test -L "$AR_CLAUDE_DIR/skills/cudzi"
# Agents a output styles
check "root: implementator z kódu" 0 test "$(readlink "$AR_CLAUDE_DIR/agents/implementator.md")" = "$WF/agents/implementator.md"
check "používateľ behov: implementator z kódu" 0 test "$(readlink "$AR_RUNS_HOME/.claude/agents/implementator.md")" = "$WF/agents/implementator.md"
check "root: output style z kódu" 0 test "$(readlink "$AR_CLAUDE_DIR/output-styles/operator.md")" = "$WF/output-styles/operator.md"
check "používateľ behov: output style z kódu" 0 test "$(readlink "$AR_RUNS_HOME/.claude/output-styles/operator.md")" = "$WF/output-styles/operator.md"
check "meno štýlu vo frontmatteri sedí s outputStyle" 0 grep -qx 'name: operator' "$WF/output-styles/operator.md"
check "priečinok agents má práva 700" 0 test "$(stat -c %a "$AR_CLAUDE_DIR/agents")" = 700
check "odkaz sa číta ako definícia s model: sonnet" 0 grep -q '^model: sonnet$' "$AR_CLAUDE_DIR/agents/implementator.md"
# Nastavenia z tabuľky env/hooks.mjs
check "root: settings.json zhodný s tabuľkou main" 0 node --input-type=module -e '
import { readFileSync } from "node:fs";
import { driftProblems } from "'"$WF"'/env/hooks.mjs";
const live = JSON.parse(readFileSync(process.argv[1], "utf8"));
const p = driftProblems(live, "main", "'"$WF"'/hooks", "'"$WF"'");
if (p.length) { console.error(p.join("\n")); process.exit(1); }
' "$AR_CLAUDE_DIR/settings.json"
check "používateľ behov: settings.json zhodný s tabuľkou runs" 0 node --input-type=module -e '
import { readFileSync } from "node:fs";
import { driftProblems } from "'"$WF"'/env/hooks.mjs";
const live = JSON.parse(readFileSync(process.argv[1], "utf8"));
const p = driftProblems(live, "runs", "'"$WF"'/hooks", "'"$WF"'");
if (p.length) { console.error(p.join("\n")); process.exit(1); }
' "$AR_RUNS_HOME/.claude/settings.json"
check "root: príkazy hookov" 0 cmds "$AR_CLAUDE_DIR/settings.json"
contains "root: unslop z kódu" "node $WF/hooks/unslop.mjs"
contains "root: cudzí hook ostane" "iny"
lacks "root: hook starého klonu zmizne" "/opt/stary/"
check "používateľ behov: príkazy hookov" 0 cmds "$AR_RUNS_HOME/.claude/settings.json"
contains "používateľ behov: tool_failure_report z kódu" "node $WF/hooks/tool_failure_report.mjs"
contains "používateľ behov: cudzí hook ostane" "iny-beh"
lacks "používateľ behov: hook starého klonu zmizne" "/opt/stary/"
lacks "používateľ behov nemá hooky len pre root" "unslop.mjs"
check "zákazy rootu ostanú" 0 jq_ "$AR_CLAUDE_DIR/settings.json" 'd["permissions"]["deny"]'
contains "mkfs ostane" "mkfs"
check "cudzí kľúč používateľa behov ostane" 0 jq_ "$AR_RUNS_HOME/.claude/settings.json" 'd["model"]'
contains "model ostane" "x"
for f in "$AR_CLAUDE_DIR/settings.json" "$AR_RUNS_HOME/.claude/settings.json"; do
    check "compact: autoCompactEnabled false, outputStyle operator v $f" 0 jq_ "$f" '[d["autoCompactEnabled"], d["outputStyle"]]'
    contains "compact: $f" '[false, "operator"]'
done
# Git
check "git: e-mail z konfigurácie" 0 git config --global user.email
contains "git: e-mail" "agent@example.org"
check "git: globálny hooksPath klonu kódu" 0 git config --global core.hooksPath
contains "git: hooksPath" "$WF/git-hooks/global"
# Systemd
check "service je nainštalovaná" 0 test -f "$AR_UNIT_DIR/agentic-workflow-sync.service"
check "timer je nainštalovaný" 0 test -f "$AR_UNIT_DIR/agentic-workflow-sync.timer"
check "service nesie cestu klonu kódu" 0 grep -qxF "Environment=AGENT_WORKFLOW=$WF" "$AR_UNIT_DIR/agentic-workflow-sync.service"
check "service nesie cestu klonu mozgu" 0 grep -qxF "Environment=AGENT_BRAIN_GLOBAL=$BR" "$AR_UNIT_DIR/agentic-workflow-sync.service"
check "service volá sync.sh cez AGENT_WORKFLOW" 0 grep -qxF 'ExecStart=/usr/bin/env bash ${AGENT_WORKFLOW}/env/server/sync.sh' "$AR_UNIT_DIR/agentic-workflow-sync.service"
check "service nemá nenahradený zástupný znak" 1 grep -q '@' "$AR_UNIT_DIR/agentic-workflow-sync.service"
check "staré jednotky sú zmazané" 1 test -e "$AR_UNIT_DIR/old-sync.timer" -o -e "$AR_UNIT_DIR/old-sync.service"
check "AR_NO_SYSTEMCTL=1: systemctl sa nevolal" 1 test -e "$T/systemctl.log"
# Dvojitá poistka: AR_UNIT_DIR bez AR_SYSTEMCTL nevolá systemctl ani z PATH.
unset AR_NO_SYSTEMCTL
check "AR_UNIT_DIR bez AR_SYSTEMCTL prejde" 0 "$S"
check "AR_UNIT_DIR bez AR_SYSTEMCTL: systemctl sa nevolal" 1 test -e "$T/systemctl.log"

# Druhé spustenie je idempotentné, systemctl sa volá cez falošný príkaz.
before="$(cat "$AR_CLAUDE_DIR/settings.json" "$AR_RUNS_HOME/.claude/settings.json" "$AR_CLAUDE_DIR/CLAUDE.md" "$AR_RUNS_HOME/.claude/CLAUDE.md")"
AR_SYSTEMCTL="$T/bin/systemctl" check "druhé spustenie prejde" 0 "$S"
after="$(cat "$AR_CLAUDE_DIR/settings.json" "$AR_RUNS_HOME/.claude/settings.json" "$AR_CLAUDE_DIR/CLAUDE.md" "$AR_RUNS_HOME/.claude/CLAUDE.md")"
check "druhé spustenie nič nezmení" 0 test "$before" = "$after"
check "druhé spustenie nezdvojí hook" 0 jq_ "$AR_CLAUDE_DIR/settings.json" 'sum(1 for ev in d["hooks"].values() for g in ev for h in g["hooks"] if h["command"].endswith("/identity.mjs"))'
contains "identity raz" "1"
check "druhé spustenie nezdvojí skill" 0 test "$(find "$AR_CLAUDE_DIR/pred-odkazom" -maxdepth 1 | wc -l)" = 3
contains_log() { grep -qF -- "$1" "$T/systemctl.log"; }
check "systemctl: vypnutie starého timeru" 0 contains_log "disable --now old-sync.timer"
check "systemctl: daemon-reload" 0 contains_log "daemon-reload"
check "systemctl: zapnutie timeru" 0 contains_log "enable --now agentic-workflow-sync.timer"

# Mŕtvy odkaz do klonov sa odstráni, živý ostane.
ln -s "$WF/skills/zmizol" "$AR_CLAUDE_DIR/skills/zmizol"
ln -s "$BR/skills/zmizol2" "$AR_RUNS_HOME/.claude/skills/zmizol2"
check "mŕtvy odkaz sa odstráni" 0 "$S"
check "mŕtvy odkaz skillu rootu zmizne" 1 test -L "$AR_CLAUDE_DIR/skills/zmizol"
check "mŕtvy odkaz skillu používateľa behov zmizne" 1 test -L "$AR_RUNS_HOME/.claude/skills/zmizol2"
check "živý skill ostane" 0 test -e "$AR_CLAUDE_DIR/skills/unslop/SKILL.md"

# Kolízia mena skillu v oboch klonoch je chyba.
mkdir -p "$BR/skills/unslop"
echo x > "$BR/skills/unslop/SKILL.md"
check "kolízia mena skillu odmietne" 1 "$S"
contains "hlási kolíziu" "kolízia mena"
rm -rf "$BR/skills/unslop"

# Chýbajúci súbor mozgu odmietne.
mv "$BR/env/server/RULES.md" "$BR/env/server/RULES.md.pryč"
check "chýbajúce RULES.md servera v mozgu odmietne" 1 "$S"
contains "hlási chýbajúci súbor" "Chýba $BR/env/server/RULES.md"
mv "$BR/env/server/RULES.md.pryč" "$BR/env/server/RULES.md"

# Bez konfigurácie: len root, bez používateľa behov.
mv "$BR/env/server/config.env" "$BR/env/server/config.env.pryč"
T2="$(mktemp -d)"
AR_CLAUDE_DIR="$T2/claude" AR_ENV_ROOT="$T2/root" AR_UNIT_DIR="$T2/units" AR_RUNS_HOME="" check "bez konfigurácie nasadí len root" 0 "$S"
check "bez konfigurácie: root dostal pravidlá" 0 grep -qxF "@$WF/RULES.md" "$T2/claude/CLAUDE.md"
check "bez konfigurácie: používateľ behov nič nedostal" 1 test -e "$T2/runs"
rm -rf "$T2"
mv "$BR/env/server/config.env.pryč" "$BR/env/server/config.env"

# Skript nenesie mená ani cesty konkrétneho stroja a nikdy nevolá živý systemctl bez poistky.
check "install.sh nemá cestu do /home" 1 grep -qE '/home/' "$S"
check "neklonuje, klony zakladá volač" 1 grep -q "git clone" "$S"
finish
