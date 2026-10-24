#!/usr/bin/env bash
# Výmena dlhodobého tokenu Claude (claude setup-token) pod používateľom bez toho,
# aby token prešiel výstupom, prepisom relácie alebo databázou T3.
#   setup_token.sh start <používateľ>            vypíše len odkaz na prihlásenie
#   setup_token.sh finish <používateľ> <kód> <súbor env>
#                                                 zapíše token do súboru, vypíše len dĺžku
# Chyba 23. 10. 2026: dvaja agenti vypísali token do prepisu (úloha 449).
set -euo pipefail
cmd=${1:?start|finish}; user=${2:?používateľ}; s=setuptoken
as() { runuser -u "$user" -- "$@"; }
case $cmd in
  start)
    as tmux kill-session -t $s 2>/dev/null || true
    as tmux new-session -d -s $s -x 250 -y 50 'claude setup-token'
    as tmux set-option -t $s remain-on-exit on >/dev/null
    sleep 6
    as tmux capture-pane -p -J -S - -t $s | sed -n '/^https:\/\/claude\.com\/cai\/oauth/,/Hold Shift/p' | grep -v 'Hold Shift' | tr -d '\n ' ; echo ;;
  finish)
    code=${3:?kód}; f=${4:?súbor env}
    as tmux send-keys -t $s -l "$code"; as tmux send-keys -t $s Enter
    sleep 8
    tok=$(as tmux capture-pane -p -J -S - -t $s | grep -oE 'sk-ant-oat01-[A-Za-z0-9_-]+' | head -1 || true)
    as tmux kill-session -t $s
    [ -n "$tok" ] || { echo "token nevznikol" >&2; exit 1; }
    TOK=$tok python3 -I -c '
import os,re,sys;f=sys.argv[1];s=open(f).read()
s2=re.sub(r"(CLAUDE_CODE_OAUTH_TOKEN=)\S+",lambda m:m.group(1)+os.environ["TOK"],s)
assert s2!=s, "riadok CLAUDE_CODE_OAUTH_TOKEN chýba";open(f,"w").write(s2)' "$f"
    echo "zapísané, dĺžka ${#tok}" ;;
  *) echo "start|finish" >&2; exit 2 ;;
esac
