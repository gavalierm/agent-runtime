#!/bin/bash
# Zriadi agenta s identitou, ktorý má hlavné vlákno v T3 pod rootom a behy
# úloh v Taskeri pod používateľom AGENT_TASKER_USER, rovnako ako ostatní agenti.
# Vlákno v T3 nezakladá (to robí správca agentov nástrojmi MCP t3_project_create
# a t3_thread_launch), na konci
# vypíše, čo zostáva, a stav.
#
# Použitie: agent_vlakno.sh <meno> "<Meno>" [--repo <repo>] [--model <model>]
#             [--thread <id vlákna T3>] [--bez-behov]
#   <meno>     malými písmenami, napríklad erin
#   "<Meno>"   zobrazované meno, názov vlákna a autor commitov "<Meno> (AGENT_HOST)"
#   --repo     predvolene agent-<meno> v účte AGENT_GH_OWNER
#   --model    AGENT_MODEL budiča, predvolene claude-opus-5-5
#   --thread   id vlákna T3, zapíše sa do ~/.local/state/<meno>/thread_id
#   --bez-behov  agent nemá behy v Taskeri (osobný agent, jeho dáta nesmú vidieť
#              behy iných): bez klonu pod AGENT_TASKER_USER, agent v Taskeri
#              vypnutý s pracovným priečinkom /root/<meno>
#
# Idempotentný: každý krok najprv zistí stav a urobí len to, čo chýba.
# Existujúci runtime.env, t3_token, kľúč a agenta v Taskeri nemení.
# Tajomstvá (tokeny GitHubu, t3_token) sa nikdy nevypisujú, tokeny GitHubu
# idú curlu cez deskriptor, nie cez argumenty.
#
# Premenné prostredia (README.md, časť Premenné): AGENT_MANAGER (agent, ktorého
# runtime.env nesie trasy odpovedí a ktorého adresár ~/.config/<meno> drží
# tokeny GitHubu), AGENT_GH_OWNER, AGENT_GH_MACHINE, AGENT_GH_EMAIL,
# AGENT_HOST, AGENT_TASKER_USER, voliteľne AGENT_RESERVED (mená cez dvojbodku,
# ktoré majú vlastné zriadenie).
#
# Skúška: AV_ROOT je predpona všetkých ciest a zapne ochranu, že sa vykoná
# len príkaz z AV_STUBS (test/agent_vlakno.test.mjs). Naživo nenastavovať.
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' >&2; exit 2; }

[ $# -ge 2 ] || usage
name=$1; title=$2; shift 2
repo=agent-$name; model=claude-opus-5-5; thread=""; bez_behov=0
while [ $# -gt 0 ]; do
  case $1 in
    --repo) repo=${2:?--repo}; shift 2 ;;
    --model) model=${2:?--model}; shift 2 ;;
    --thread) thread=${2:?--thread}; shift 2 ;;
    --bez-behov) bez_behov=1; shift ;;
    *) usage ;;
  esac
done
[[ $name =~ ^[a-z][a-z0-9]*$ ]] || { echo "meno: malé písmená a číslice, napríklad erin" >&2; exit 2; }
MANAGER=${AGENT_MANAGER:?AGENT_MANAGER}
GH_OWNER=${AGENT_GH_OWNER:?AGENT_GH_OWNER}
GH_MACHINE=${AGENT_GH_MACHINE:?AGENT_GH_MACHINE}
GH_EMAIL=${AGENT_GH_EMAIL:?AGENT_GH_EMAIL}
HOST=${AGENT_HOST:?AGENT_HOST}
TASKER_USER=${AGENT_TASKER_USER:?AGENT_TASKER_USER}
for r in $MANAGER ${AGENT_RESERVED//:/ }; do
  [ "$name" != "$r" ] || { echo "$r má vlastné zriadenie" >&2; exit 2; }
done
[ -n "$title" ] || { echo "chýba zobrazované meno" >&2; exit 2; }
[[ -z $thread || $thread =~ ^[^[:space:]]+$ ]] || { echo "--thread: id bez medzier" >&2; exit 2; }

R=${AV_ROOT:-}
HERE=$(cd "$(dirname "$0")" && pwd)
HOOKS_SRC=${AV_HOOKS_SRC:-$HERE/agent-githooks}
GH_REPO=${AV_GITHUB_REPO:-$HERE/github_repo.sh}
WORKFLOW_DIR=${AV_WORKFLOW:-$HERE}
T3_URL=${AV_T3_URL:-http://127.0.0.1:3773}
AUTOSETTLE=${AV_AUTOSETTLE:-$HERE/t3_autosettle.mjs}
TASKER_HOME=/home/$TASKER_USER/.tasker
INBOX_GROUP=${AGENT_INBOX_GROUP:-agent-inbox}

SSH_DIR=$R/root/.ssh
KEY=$SSH_DIR/${GH_MACHINE}_$name
KNOWN=$SSH_DIR/known_hosts_github
CFG=$R/root/.config/$name
MGR_CFG=$R/root/.config/$MANAGER
CLONE=$R/root/$name
STATE=$R/root/.local/state/$name
BOX=$R/var/lib/$name
TMPCONF=$R/etc/tmpfiles.d/$name-inbox.conf
UNIT_TPL=$R/etc/systemd/system/agent-driver@.service
TCLONE=$R/home/$TASKER_USER/agenti/$name
TKNOWN=$R/home/$TASKER_USER/.ssh/known_hosts
# Hodnoty zapisované do git config a do Taskera sú skutočné cesty, nie predpona skúšky.
TWORK=/home/$TASKER_USER/agenti/$name
email=$GH_EMAIL
author="$title ($HOST)"
ssh_cmd="ssh -F /dev/null -i /root/.ssh/${GH_MACHINE}_$name -o IdentitiesOnly=yes -o UserKnownHostsFile=/root/.ssh/known_hosts_github"
tssh_cmd="ssh -F /dev/null -i /home/$TASKER_USER/.ssh/${GH_MACHINE}_tasker -o IdentitiesOnly=yes -o UserKnownHostsFile=/home/$TASKER_USER/.ssh/known_hosts"

changed=0
did() { echo "urobené: $*"; changed=$((changed + 1)); }
ok() { echo "už je: $*"; }
warn() { echo "POZOR: $*" >&2; }

# Skúška smie spustiť len podstavené príkazy, inak by sa dotkla živého systému.
if [ -n "$R" ]; then
  [ -n "${AV_STUBS:-}" ] || { echo "AV_ROOT bez AV_STUBS" >&2; exit 3; }
  for c in curl git ssh-keygen systemctl systemd-tmpfiles runuser t3 tasker; do
    p=$(command -v "$c" || true)
    [[ $p == "$AV_STUBS"/* ]] || { echo "ochrana skúšky: $c nie je z $AV_STUBS ($p)" >&2; exit 3; }
  done
  [[ $AUTOSETTLE == "$AV_STUBS"/* ]] || { echo "ochrana skúšky: AV_AUTOSETTLE nie je z $AV_STUBS" >&2; exit 3; }
fi

tk() { AGENT_NAME=$MANAGER TK_USER="$TASKER_USER" TK_HOME="$TASKER_HOME" "${AV_TK:-$HERE/bin/tk}" "$@"; }
tuser() { runuser -u "$TASKER_USER" -- "$@"; }

# 1. Kľúč agenta
if [ -f "$KEY" ]; then ok "kľúč $KEY"; else
  ssh-keygen -q -t ed25519 -N '' -C "$name-$HOST" -f "$KEY"
  chmod 600 "$KEY"
  did "kľúč $KEY"
fi

# 2. Verejný kľúč na strojovom účte $GH_MACHINE
agent_token=$(cat "$MGR_CFG/github_agent_token")
pub=$(cut -d' ' -f1,2 "$KEY.pub")
blob=$(cut -d' ' -f2 "$KEY.pub")
keys=$(curl -sS -K <(printf 'header = "Authorization: Bearer %s"\n' "$agent_token") \
  -H 'Accept: application/vnd.github+json' 'https://api.github.com/user/keys?per_page=100')
if printf '%s' "$keys" | grep -qF "$blob"; then ok "verejný kľúč na $GH_MACHINE"; else
  body=$(printf '{"title":"%s-%s","key":"%s"}' "$name" "$HOST" "$pub")
  out=$(mktemp); trap 'rm -f "$out"' EXIT
  code=$(curl -sS -o "$out" -w '%{http_code}' -X POST \
    -K <(printf 'header = "Authorization: Bearer %s"\n' "$agent_token") \
    -H 'Accept: application/vnd.github+json' -d "$body" https://api.github.com/user/keys)
  [ "$code" = 201 ] || { cat "$out" >&2; echo "POST /user/keys: $code" >&2; exit 1; }
  did "verejný kľúč pridaný na $GH_MACHINE ($name-$HOST)"
fi
unset agent_token

# 3. Prístup strojového účtu do repa (skript je idempotentný)
gh_out=$("$GH_REPO" "$repo" "$name" "Agent $title") || { echo "$gh_out" >&2; exit 1; }
echo "$gh_out" | sed 's/^/github_repo: /'
echo "$gh_out" | grep -q '^pozvánka\|^repo založené' && changed=$((changed + 1))

# 4. Klon pre hlavné vlákno
gitc() { git -C "$CLONE" "$@"; }
if [ -d "$CLONE/.git" ]; then ok "klon $CLONE"; else
  GIT_SSH_COMMAND="$ssh_cmd" git clone -q "git@github.com:$GH_OWNER/$repo.git" "$CLONE"
  did "klon $CLONE"
fi
gitc rev-parse -q --verify HEAD >/dev/null 2>&1 || gitc symbolic-ref HEAD refs/heads/main
ensure_cfg() { # ensure_cfg <označenie> <kľúč> <hodnota> <príkaz git...>
  local label=$1 k=$2 v=$3 cur; shift 3
  cur=$("$@" config --local --get "$k" 2>/dev/null || true)
  [ "$cur" = "$v" ] || { "$@" config --local "$k" "$v"; did "git config $k v $label"; }
}
for pair in "core.sshCommand=$ssh_cmd" "core.hooksPath=.githooks" "user.name=$author" "user.email=$email"; do
  ensure_cfg "$CLONE" "${pair%%=*}" "${pair#*=}" git -C "$CLONE"
done
if [ -d "$CLONE/.githooks" ]; then ok "$CLONE/.githooks"; else
  mkdir -p "$CLONE/.githooks"
  cp "$HOOKS_SRC/commit-msg" "$HOOKS_SRC/pre-commit" "$CLONE/.githooks/"
  chmod +x "$CLONE/.githooks/commit-msg" "$CLONE/.githooks/pre-commit"
  did "$CLONE/.githooks (do repa ich commitni)"
fi

# 5. Schránka
tmpconf_body="# Schránka agenta $title (hlavné vlákno T3 pod rootom).
# Zapisuje ju skript agent_vlakno.sh.
# Správy a odpovede píšu agenti servera (root), z Macu ssh ako $MANAGER (člen
# skupiny $INBOX_GROUP). Budič agent-driver@$name doručí správu do vlákna a presunie ju
# do processed, tie sa po 30 dňoch zmažú, vek podľa mtime.
d /var/lib/$name           0710 root $INBOX_GROUP -
d /var/lib/$name/inbox     2770 root $INBOX_GROUP -
d /var/lib/$name/outbox    2770 root $INBOX_GROUP -
d /var/lib/$name/processed 2770 root $INBOX_GROUP m:30d"
mkdir -p "$(dirname "$TMPCONF")"
if [ -f "$TMPCONF" ] && [ "$(cat "$TMPCONF")" = "$tmpconf_body" ]; then ok "$TMPCONF"; else
  printf '%s\n' "$tmpconf_body" > "$TMPCONF"; did "$TMPCONF"
fi
if [ -d "$BOX/inbox" ] && [ -d "$BOX/outbox" ] && [ -d "$BOX/processed" ]; then ok "schránka $BOX"; else
  systemd-tmpfiles --create "$TMPCONF"; did "schránka $BOX"
fi

# 6. runtime.env budiča (600)
mkdir -p "$CFG"; chmod 700 "$CFG"
if [ -f "$CFG/runtime.env" ]; then ok "$CFG/runtime.env"; else
  (umask 077; cat > "$CFG/runtime.env" <<EOF
AGENT_WORKFLOW=$WORKFLOW_DIR
AGENT_WORKDIR=/root/$name
AGENT_BOX=/var/lib/$name
AGENT_MODEL=$model
T3_URL=$T3_URL
T3_TOKEN_FILE=/root/.config/$name/t3_token
AGENT_REPLY_CMD="AGENT_NAME=$name $WORKFLOW_DIR/reply.sh"
AGENT_REPLY_ROUTE_$MANAGER=/var/lib/$MANAGER/inbox
AGENT_RUNTIME_MODE=full-access
TASKER_HOME=$TASKER_HOME
AGENT_TASKER_USER=$TASKER_USER
EOF
  )
  # Hodnoty pre hooky relácie (hooks/, README časť Hooky relácie): meno operátora
  # a adresa webu Taskera sú spoločné, vezmú sa zo správcu, ak ich má.
  for k in AGENT_OPERATOR_NAME TASKER_WEB_URL; do
    grep "^$k=" "$MGR_CFG/runtime.env" >> "$CFG/runtime.env" 2>/dev/null || true
  done
  chmod 600 "$CFG/runtime.env"; did "$CFG/runtime.env"
fi

# 7. Token T3 (orchestration:read a operate, rok), do súboru 600, nikdy na výstup
if [ -s "$CFG/t3_token" ]; then ok "$CFG/t3_token"; else
  # príkaz vypíše token a prázdny riadok, preto premenná, nie priamy zápis
  if tok=$(t3 auth session issue --scope orchestration:read --scope orchestration:operate \
       --ttl 365d --label "$name-driver" --token-only 2>/dev/null) \
     && [ -n "$tok" ] && [[ $tok != *$'\n'* ]]; then
    tmp=$(mktemp "$CFG/.t3_token.XXXXXX"); chmod 600 "$tmp"
    printf '%s\n' "$tok" > "$tmp"; mv "$tmp" "$CFG/t3_token"; unset tok
    did "$CFG/t3_token (platnosť rok)"
  else
    echo "t3 auth session issue zlyhal alebo vrátil nečakaný výstup, token nevznikol (skontroluj t3 auth session list, relácia $name-driver mohla vzniknúť)" >&2; exit 1
  fi
fi

# 8. Trasa odpovede správcu do schránky agenta
mgr_env=$MGR_CFG/runtime.env
if grep -q "^AGENT_REPLY_ROUTE_$name=" "$mgr_env"; then ok "AGENT_REPLY_ROUTE_$name"; else
  printf 'AGENT_REPLY_ROUTE_%s=/var/lib/%s/inbox\n' "$name" "$name" >> "$mgr_env"
  did "AGENT_REPLY_ROUTE_$name v $mgr_env (reply.sh ho číta pri každom volaní, budič správcu sa nereštartuje)"
fi

# 9. Id vlákna, ak ho správca dal
mkdir -p "$STATE"; chmod 700 "$STATE"
if [ -n "$thread" ]; then
  if [ "$(cat "$STATE/thread_id" 2>/dev/null || true)" = "$thread" ]; then ok "thread_id"; else
    printf '%s\n' "$thread" > "$STATE/thread_id.tmp"; chmod 600 "$STATE/thread_id.tmp"
    mv "$STATE/thread_id.tmp" "$STATE/thread_id"; did "$STATE/thread_id"
    # Automatické odkladanie vypne len pri novom id, nástroje MCP to nevedia.
    ( set -a; . "$MGR_CFG/runtime.env"; set +a; node "$AUTOSETTLE" "$thread" false ) || warn "auto-settle nevypnuté, spusti $AUTOSETTLE $thread false"
  fi
fi

# 10. Budič
[ -f "$UNIT_TPL" ] || { echo "chýba šablóna $UNIT_TPL (systemd/agent-driver@.service)" >&2; exit 1; }
if systemctl is-enabled --quiet "agent-driver@$name.service" && systemctl is-active --quiet "agent-driver@$name.service"; then
  ok "agent-driver@$name.service"
else
  systemctl enable --now "agent-driver@$name.service"; did "agent-driver@$name.service spustený a zapnutý"
fi

# 11. Klon behov pod používateľom behov (agent bez behov ho nemá a nesmie mať)
tgit() { tuser git -C "$TCLONE" "$@"; }
if [ "$bez_behov" = 1 ]; then
  if [ -e "$TCLONE" ]; then warn "bez behov, ale $TCLONE existuje (osobné dáta by videli behy iných agentov), zmaž ho"; else ok "bez klonu behov"; fi
else
if [ -d "$TCLONE/.git" ]; then ok "klon behov $TCLONE"; else
  tuser mkdir -p "$(dirname "$TCLONE")"
  tuser env GIT_SSH_COMMAND="$tssh_cmd" git clone -q "git@github.com:$GH_OWNER/$repo.git" "$TCLONE"
  did "klon behov $TCLONE"
fi
tgit rev-parse -q --verify HEAD >/dev/null 2>&1 || tgit symbolic-ref HEAD refs/heads/main
for pair in "core.sshCommand=$tssh_cmd" "core.hooksPath=.githooks" "user.name=$author" "user.email=$email"; do
  ensure_cfg "$TCLONE" "${pair%%=*}" "${pair#*=}" tuser git -C "$TCLONE"
done
fi

# 12. Oba klony na origin/main, keď sú čisté
sync_clone() { # sync_clone <label> <príkaz git...>
  local label=$1; shift
  "$@" fetch -q origin 2>/dev/null || { warn "fetch $label zlyhal"; return 0; }
  "$@" rev-parse -q --verify origin/main >/dev/null 2>&1 || return 0
  if [ -n "$("$@" status --porcelain --untracked-files=no)" ]; then warn "$label má necommitnuté zmeny, rebase preskočený"; return 0; fi
  local before after
  before=$("$@" rev-parse HEAD 2>/dev/null || true)
  "$@" rebase -q origin/main >/dev/null
  after=$("$@" rev-parse HEAD)
  [ "$before" = "$after" ] || did "$label zrebasovaný na origin/main"
}
sync_clone "$CLONE" git -C "$CLONE"
[ "$bez_behov" = 1 ] || sync_clone "$TCLONE" tuser git -C "$TCLONE"

# 13. Agent v Taskeri: nový s klonom behov, existujúci len s opraveným workdir.
# Bez behov sa založí vypnutý s workdir hlavného klonu, existujúceho nemení.
if [ "$bez_behov" = 1 ]; then
  if tk agent show "$name" --json >/dev/null 2>&1; then ok "agent $name v Taskeri"; else
    tk agent add "$name" --workdir "/root/$name" --disabled \
      --persona-url "https://github.com/$GH_OWNER/$repo/blob/main/PERSONA.md" >/dev/null
    did "agent $name v Taskeri (disabled, bez behov, workdir /root/$name)"
  fi
elif shown=$(tk agent show "$name" --json 2>/dev/null); then
  curwd=$(printf '%s' "$shown" | sed -n 's/.*"workdir": *"\([^"]*\)".*/\1/p')
  if [ "$curwd" = "$TWORK" ]; then ok "agent $name v Taskeri, workdir $TWORK"; else
    tk agent edit "$name" --workdir "$TWORK" >/dev/null; did "agent $name v Taskeri: workdir $curwd -> $TWORK"
  fi
else
  tk agent add "$name" --workdir "$TWORK" \
    --persona-url "https://github.com/$GH_OWNER/$repo/blob/main/PERSONA.md" \
    --claude-args '["--model","opus","--permission-mode","bypassPermissions","--add-dir","/home/'"$TASKER_USER"'/projekty"]' >/dev/null
  did "agent $name v Taskeri (enabled, workdir $TWORK)"
fi

# Kontrola stavu
echo
echo "== Stav =="
echo "budič: $(systemctl is-active "agent-driver@$name.service" || true)"
stat -c '%a %U:%G %n' "$BOX" "$BOX/inbox" 2>/dev/null | while read -r l; do echo "${l/$R/}"; done
sessions=$(t3 auth session list 2>/dev/null | grep -c "client: $name-driver" || true)
echo "relácie T3 klienta $name-driver: $sessions"
echo "kľúč na GitHube: $(printf '%s' "$keys" | grep -qF "$blob" && echo áno || echo 'pridaný práve teraz')"
echo "hlavný klon: $(gitc log --oneline -1 2>/dev/null || echo bez commitu), vzdialené: $(GIT_SSH_COMMAND="$ssh_cmd" git -C "$CLONE" ls-remote -q origin HEAD >/dev/null 2>&1 && echo prístup || echo 'BEZ PRÍSTUPU')"
tk agent list 2>/dev/null | awk -v n="$name" '$1==n' | sed 's/^/Tasker: /'
echo "zmien v tomto behu: $changed"
echo
echo "== Zostáva =="
if [ -s "$STATE/thread_id" ]; then echo "vlákno T3 je zapísané: $(cat "$STATE/thread_id")"; else
  cat <<EOF
Vlákno T3 (ručný krok správcu agentov, nástroje MCP):
  1. t3_project_create: workspaceRoot /root/$name, názov $title
  2. t3_thread_launch: názov "$title", model $model, runtimeMode full-access
  3. pripnúť vlákno (t3_thread_organize pin), auto-settle vypne krok 4
  4. $HERE/agent_vlakno.sh $name "$title" --thread <id vlákna>
EOF
fi
if ! gitc log --format=%an 2>/dev/null | grep -qxF "$author"; then
  echo "Obsah repa (PERSONA.md, CLAUDE.md, memory/, .githooks) commitni v $CLONE podpísaný \"$author\" a pushni."
fi
