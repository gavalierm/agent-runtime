#!/bin/bash
# Test env/mac/install.sh. Skript beží z kópie tohto repa v $T/wf (bez .git,
# test si v kópii založí vlastný), HOME, spoločný mozog a zálohy sú v $T. Test
# nesiaha na ~/.claude, ~/Work ani na globálny git config: HOME je v $T,
# GIT_CONFIG_GLOBAL nastaví lib.sh server testov, check.mjs sa vynecháva
# (AR_NO_CHECK=1).
# shellcheck disable=SC2016,SC2088
# shellcheck source=../server/tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/../server/tests/lib.sh"
WF="$T/wf"
BR="$T/brain"
H="$T/home"
OLD="$T/old"
mkdir -p "$WF" "$H"
tar -C "$REPO" --exclude=./.git --exclude=./.scratch --exclude=node_modules -cf - . | tar -C "$WF" -xf -
git -C "$WF" init -q
S="$WF/env/mac/install.sh"

mkdir -p "$BR/env/mac" "$BR/skills/brain-skill" "$BR/commit_guard"
echo "# pravidlá mozgu" > "$BR/RULES.md"
echo "# pravidlá Macu" > "$BR/env/mac/RULES.md"
echo "# skill mozgu" > "$BR/skills/brain-skill/SKILL.md"
echo "agent@example.org" > "$BR/commit_guard/git_email.txt"
echo "LEGACY_PATHS=\"$OLD\"" > "$BR/env/mac/config.env"
mkdir -p "$OLD/skills/stary" "$OLD/global"
echo x > "$OLD/skills/stary/SKILL.md"
echo x > "$OLD/global/CLAUDE.md"

export HOME="$H" AGENT_BRAIN_GLOBAL="$BR" AR_BACKUPS="$T/backups" AR_NO_CHECK=1
unset AGENT_WORKFLOW
mkdir -p "$H/.claude/skills" "$H/Work"
# Stav po starej inštalácii.
ln -s "$OLD/global/CLAUDE.md" "$H/.claude/CLAUDE.md"
ln -s "$OLD/skills/stary" "$H/.claude/skills/stary"
ln -s /etc/hostname "$H/.claude/skills/cudzi"
echo "stare pravidla Work" > "$H/Work/CLAUDE.md"
echo '{"enabledPlugins": {"a@b": true}, "permissions": {"deny": ["Bash(mkfs *)"]}, "hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "iny"}]}, {"hooks": [{"type": "command", "command": "node /opt/stary/hooks/unslop.mjs"}]}]}}' > "$H/.claude/settings.json"

jq_() { python3 -c 'import json, sys; d = json.load(open(sys.argv[1])); print(json.dumps(eval(sys.argv[2])))' "$@"; }

check "nainštaluje" 0 "$S"
check "~/.claude/CLAUDE.md je súbor" 1 test -L "$H/.claude/CLAUDE.md"
check "import kódu" 0 grep -qxF "@$WF/RULES.md" "$H/.claude/CLAUDE.md"
check "import mozgu" 0 grep -qxF "@$BR/RULES.md" "$H/.claude/CLAUDE.md"
check "starý odkaz CLAUDE.md je zálohovaný" 0 test -n "$(find "$T/backups" -name 'CLAUDE.md.*' -type l)"
check "~/Work/CLAUDE.md je odkaz na pravidlá Macu v mozgu" 0 test "$(readlink "$H/Work/CLAUDE.md")" = "$BR/env/mac/RULES.md"
check "starý ~/Work/CLAUDE.md je zálohovaný" 0 grep -rqF "stare pravidla Work" "$T/backups"
check "skill z kódu" 0 test "$(readlink "$H/.claude/skills/unslop")" = "$WF/skills/unslop"
check "skill z mozgu" 0 test "$(readlink "$H/.claude/skills/brain-skill")" = "$BR/skills/brain-skill"
check "odkaz do starého klonu zmizol" 1 test -L "$H/.claude/skills/stary"
check "cudzí odkaz ostane" 0 test -L "$H/.claude/skills/cudzi"
check "agent implementator" 0 test "$(readlink "$H/.claude/agents/implementator.md")" = "$WF/agents/implementator.md"
check "output style operator" 0 test "$(readlink "$H/.claude/output-styles/operator.md")" = "$WF/output-styles/operator.md"
check "settings.json zhodný s tabuľkou mac" 0 node --input-type=module -e '
import { readFileSync } from "node:fs";
import { driftProblems } from "'"$WF"'/env/hooks.mjs";
const live = JSON.parse(readFileSync(process.argv[1], "utf8"));
const p = driftProblems(live, "mac", "'"$WF"'/hooks", "'"$WF"'");
if (p.length) { console.error(p.join("\n")); process.exit(1); }
' "$H/.claude/settings.json"
check "settings.json: pluginy ostanú" 0 jq_ "$H/.claude/settings.json" 'd["enabledPlugins"]'
contains "plugin a@b" "a@b"
check "settings.json: zákazy ostanú" 0 jq_ "$H/.claude/settings.json" 'd["permissions"]["deny"]'
check "settings.json: cudzí hook ostane, starý zmizne" 0 jq_ "$H/.claude/settings.json" '[h["command"] for g in d["hooks"]["SessionStart"] for h in g["hooks"]]'
contains "cudzí hook" '"iny"'
lacks "starý hook zmizol" "/opt/stary/"
check "git: gitignore z kódu" 0 git config --global core.excludesfile
contains "git: excludesfile" "$WF/env/mac/gitignore"
check "git: e-mail z mozgu" 0 git config --global user.email
contains "git: e-mail" "agent@example.org"
check "git: hooksPath v kópii" 0 git -C "$WF" config core.hooksPath
check "env/mac/settings.json v repe nie je" 1 test -e "$REPO/env/mac/settings.json"

before="$(cat "$H/.claude/settings.json" "$H/.claude/CLAUDE.md")"
check "druhé spustenie prejde" 0 "$S"
check "druhé spustenie nič nezmení" 0 test "$before" = "$(cat "$H/.claude/settings.json" "$H/.claude/CLAUDE.md")"
check "druhé spustenie nezdvojí hook" 0 jq_ "$H/.claude/settings.json" 'sum(1 for ev in d["hooks"].values() for g in ev for h in g["hooks"] if h["command"].endswith("/unslop.mjs"))'
contains "unslop raz" "1"

mkdir -p "$BR/skills/unslop"
echo x > "$BR/skills/unslop/SKILL.md"
check "kolízia mena skillu odmietne" 1 "$S"
contains "hlási kolíziu" "kolízia mena"
rm -rf "$BR/skills/unslop"

mv "$BR/env/mac/RULES.md" "$BR/env/mac/RULES.md.pryč"
check "chýbajúce RULES.md Macu v mozgu odmietne" 1 "$S"
contains "hlási chýbajúci súbor" "chýba $BR/env/mac/RULES.md"
mv "$BR/env/mac/RULES.md.pryč" "$BR/env/mac/RULES.md"

check "install.sh nemá cestu do /Users" 1 grep -q '/Users/' "$S"
check "install.sh nemá cestu do /root" 1 grep -q '/root' "$S"
finish
