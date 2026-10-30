#!/bin/bash
# error.sh: an acknowledged error of the agent, recorded in errors/REGISTER.md of the brain.
#
#   error.sh --class <class> --file <file that governs the behaviour> --mechanism <hook|test|deny|decision>:<ref>
#            [--description "<what I claimed or did>"] [--truth "<what was true>"]
#            [--check "<hook or test that stops it>"] [--brain <folder>]
#   error.sh --open [--brain <folder>]
#
# Adds one row `| date | class | description | fix | test |` to the register. The fix column
# holds the file, its commit and the mechanism; the test column holds --check, else the
# mechanism. A second occurrence of the same class in the same register creates a review task
# through the command in AGENT_TK (a tk wrapper, project agenti, assignee ERROR_REVIEWER or the
# role spravca-agentov). Without AGENT_TK the script prints that the task is not created.
# Prints the report for the operator in four sentences.
#
# The mechanism is required, its shape is hook:<path>, test:<path>, deny:<pattern> or
# decision:D<nnnn>. Without it the script exits with code 1 and writes nothing. The file must be
# committed so the report names the commit of the fix.
#
# --open lists the rows without a fix (date, class, description) and writes nothing.
#
# The register is errors/REGISTER.md of the brain:
#   --brain <folder>   a brain folder, or a repo root that has agentic-brain/errors
#   otherwise          from the current folder (its git root): agentic-brain/errors when it
#                      exists, else errors/REGISTER.md at the root, else the register of the
#                      global brain (lib/paths.sh, AGENT_BRAIN_GLOBAL)
#
# A register in a clone marked `git config agentic.readonly true` (the live clones that a timer
# pulls) is refused with code 1, --brain then points to the write clone of the brain.
#
# Environment:
#   ERROR_AGENT      name of the agent (for the task title), else AGENT_NAME, TASKER_USER, else
#                    "# Name" of PERSONA.md in CLAUDE_PROJECT_DIR or the current folder
#   ERROR_REVIEWER   assignee of the review task, default spravca-agentov
#   AGENT_TK         command that runs the task manager (split into words)
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() { # exit code, reason, correct procedure
    printf '%s\nSprávny postup: %s\n' "$2" "$3" >&2
    exit "$1"
}

class="" file="" description="" truth="" check="" mechanism="" brain="" list_open=""
while [ $# -gt 0 ]; do
    case "$1" in
        --class) class="${2:-}"; shift 2 ;;
        --file) file="${2:-}"; shift 2 ;;
        --description) description="${2:-}"; shift 2 ;;
        --truth) truth="${2:-}"; shift 2 ;;
        --check) check="${2:-}"; shift 2 ;;
        --mechanism) mechanism="${2:-}"; shift 2 ;;
        --brain) brain="${2:-}"; shift 2 ;;
        --open) list_open=1; shift ;;
        *) echo "error.sh: unknown option $1" >&2; exit 64 ;;
    esac
done

register_path() {
    local top
    if [ -n "$brain" ]; then
        if [ -f "$brain/errors/REGISTER.md" ]; then printf '%s' "$brain/errors/REGISTER.md"
        elif [ -f "$brain/agentic-brain/errors/REGISTER.md" ]; then printf '%s' "$brain/agentic-brain/errors/REGISTER.md"
        else printf '%s' "$brain/errors/REGISTER.md"
        fi
        return
    fi
    top="$(git rev-parse --show-toplevel 2>/dev/null)" || top="$PWD"
    if [ -d "$top/agentic-brain/errors" ]; then
        printf '%s' "$top/agentic-brain/errors/REGISTER.md"
    elif [ -f "$top/errors/REGISTER.md" ]; then
        printf '%s' "$top/errors/REGISTER.md"
    else
        local global="${AGENT_BRAIN_GLOBAL:-}"
        if [ -z "$global" ] && [ -f "$HERE/../../../lib/paths.sh" ]; then
            # shellcheck source=../../../lib/paths.sh
            . "$HERE/../../../lib/paths.sh"
            global="$(brain_global_dir)"
        fi
        printf '%s' "$global/errors/REGISTER.md"
    fi
}

reg="$(register_path)"

if [ -n "$list_open" ]; then
    [ -f "$reg" ] && awk -F'|' '
        function trim(s) { gsub(/^[ \t\r]+|[ \t\r]+$/, "", s); return s }
        /^\|/ && trim($2) ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/ && trim($5) == "" { print trim($2) "\t" trim($3) "\t" trim($4) }' "$reg"
    exit 0
fi

# Table cells hold one line without the separator.
clean() { printf '%s' "$1" | tr '\r\n\t' '   ' | tr '|' '/' | sed 's/^ *//; s/ *$//'; }
class="$(clean "$class")"; description="$(clean "$description")"; truth="$(clean "$truth")"
check="$(clean "$check")"; mechanism="$(clean "$mechanism")"

if ! [[ "$mechanism" =~ ^((hook|test):[^[:space:]]+|deny:.+|decision:D[0-9]{4})$ ]]; then
    fail 1 "the mechanism that stops the error next time is missing or has a wrong shape: '$mechanism'" "error.sh --class <class> --file <file with the fix> --mechanism <hook|test|deny|decision>:<path or id>, for example --mechanism hook:hooks/own_rule_scope.mjs, test:test/error.test.mjs, deny:<pattern> or decision:D0183"
fi
if [ -z "$class" ] || [ -z "$file" ]; then
    fail 64 "the class or the file is missing" "error.sh --class <short key of the class, for example todo-after-comment> --file <PERSONA.md, CLAUDE.md or the hook that governs the behaviour> --mechanism <...>"
fi
if [ ! -f "$file" ]; then
    fail 64 "file $file does not exist" "pass the path of the file that governs the behaviour (rules, persona, hook, check, setting)"
fi
dir="$(dirname "$file")"
file="$(cd "$dir" && pwd)/$(basename "$file")"
top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" || top=""
if [ -z "$top" ] || [ -n "$(git -C "$dir" status --porcelain -- "$file" 2>/dev/null)" ]; then
    fail 1 "file $file is not committed, the report would not name the commit of the fix" "commit the fix (\`git commit -m \"...\" -- $file\`), push it and run error.sh again"
fi
commit="$(git -C "$dir" log -1 --format=%h -- "$file")"
if [ -z "$commit" ]; then
    fail 1 "file $file has no commit" "commit the fix (\`git commit -m \"...\" -- $file\`) and run error.sh again"
fi
shown="${file#"$top"/}"

if [ ! -f "$reg" ]; then
    fail 1 "error register $reg is missing" "pass --brain <folder with errors/REGISTER.md> or run error.sh in a repo that has a brain (adopt.sh creates the register)"
fi
# A live clone pulled by a timer (`git pull --ff-only`) is read only: an uncommitted row would stop its sync.
reg_top="$(git -C "$(dirname "$reg")" rev-parse --show-toplevel 2>/dev/null)" || reg_top=""
if [ -n "$reg_top" ] && [ "$(git -C "$reg_top" config --type=bool --get agentic.readonly 2>/dev/null)" = true ]; then
    fail 1 "error register $reg is in a read-only clone (git config agentic.readonly is true), an uncommitted row would stop its sync" "pass --brain <the agent's own write clone of that brain> and run error.sh again"
fi

agent="${ERROR_AGENT:-${AGENT_NAME:-${TASKER_USER:-}}}"
if [ -z "$agent" ]; then
    persona="${CLAUDE_PROJECT_DIR:-$PWD}/PERSONA.md"
    [ -f "$persona" ] && agent="$(sed -n 's/^# \(.*\)$/\1/p' "$persona" | head -n1 | tr '[:upper:]' '[:lower:]')"
fi

date_now="$(date +%F)"
# Rows of this class: count, and the last task named in the fix column ("úloha <id>").
read -r count task < <(awk -F'|' -v t="$(printf '%s' "$class" | tr '[:upper:]' '[:lower:]')" '
    function trim(s) { gsub(/^[ \t\r]+|[ \t\r]+$/, "", s); return s }
    /^\|/ && trim($2) ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/ && tolower(trim($3)) == t {
        n++
        cells = $5
        if (match(cells, /loha [0-9]+/)) { u = substr(cells, RSTART + 5, RLENGTH - 5) }
    }
    END { print n + 0, u }' "$reg")
count=$((count + 1))

reviewer="${ERROR_REVIEWER:-spravca-agentov}"
if [ "$count" -ge 2 ] && [ -z "$task" ]; then
    if [ -n "${AGENT_TK:-}" ]; then
        read -r -a tcmd <<< "$AGENT_TK"
        title="Kontrola proti chybe triedy $class${agent:+ ($agent)}"
        body="Chyba triedy $class sa zopakovala ($count. výskyt, $date_now). Správanie riadi súbor $shown (commit $commit). ${description:+Čo bolo tvrdené alebo urobené: $description. }Zaveď kontrolu, ktorá chybu zablokuje: hook alebo test, ktorý na nej zlyhá (globálne pravidlá §4, druhý výskyt). Hotovo: replay chyby kontrola zastaví, nasadené. Register: $reg."
        if out="$(AGENT_NAME="${agent:-}" "${tcmd[@]}" task add --project agenti --assign "$reviewer" --title "$title" --body "$body" --json 2>/dev/null)"; then
            task="$(printf '%s' "$out" | grep -o '"id": *[0-9]*' | head -1 | grep -o '[0-9]*')"
        fi
        [ -n "$task" ] || echo "error.sh: the review task could not be created, create it by hand (project agenti, assignee $reviewer)" >&2
    else
        echo "error.sh: AGENT_TK is not set, the review task is not created, create it where the task manager runs (project agenti, assignee $reviewer)" >&2
    fi
fi

fix="$shown, commit $commit, $mechanism${task:+, úloha $task}"
if [ -s "$reg" ] && [ -n "$(tail -c1 "$reg")" ]; then printf '\n' >> "$reg"; fi
printf '| %s | %s | %s | %s | %s |\n' "$date_now" "$class" "${description:-bez popisu}" "$fix" "${check:-$mechanism}" >> "$reg"

# Report for the operator, four sentences.
[ -n "$description" ] || description="chyba triedy $class"
[ -n "$truth" ] || truth="správanie mal riadiť súbor $shown a nedržalo"
echo "Tvrdil alebo urobil som: ${description%.}."
echo "Pravda bola: ${truth%.}."
echo "Zmenil sa súbor $shown, commit $commit."
echo "Nabudúce to zastaví: ${check:-$mechanism}${task:+, opakovanie triedy rieši úloha $task v Taskeri}."
