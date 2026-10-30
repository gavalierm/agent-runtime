#!/bin/sh
# Prístup strojového účtu AGENT_GH_MACHINE k repu v cudzom účte: prijme čakajúcu pozvánku a overí prístup tokenom aj kľúčom agenta.
# Použitie: github_foreign_repo.sh <vlastník>/<repo> [agent]   (agent: meno s kľúčom /root/.ssh/${AGENT_GH_MACHINE}_<meno>, predvolený AGENT_MANAGER)
# Výstup: riadok "prístup: áno" a kód 0, inak "prístup: nie" s dôvodom a kód 1. Pozvánku pošle vlastník repa, skript ju len prijme.
set -eu
MACHINE=${AGENT_GH_MACHINE:?AGENT_GH_MACHINE}; MANAGER=${AGENT_MANAGER:?AGENT_MANAGER}
full=${1:?vlastník/repo}; agent=${2:-$MANAGER}
case $full in */*) ;; *) echo "argument: vlastník/repo" >&2; exit 2 ;; esac
case $agent in *[!a-z0-9]*|"") echo "agent: meno malými písmenami" >&2; exit 2 ;; esac
key=/root/.ssh/${MACHINE}_$agent; [ -f "$key" ] || { echo "chýba kľúč $key" >&2; exit 2; }
A=$(cat /root/.config/$MANAGER/github_agent_token)
tmp=$(mktemp); trap 'rm -f $tmp' EXIT
api() { curl -sS -o $tmp -w '%{http_code}' -H "Authorization: Bearer $A" -H 'Accept: application/vnd.github+json' "$@"; }
[ "$(api https://api.github.com/user/repository_invitations)" = 200 ] || { cat $tmp; exit 1; }
id=$(python3 -c 'import json,sys;print(next((str(i["id"]) for i in json.load(open(sys.argv[1])) if i["repository"]["full_name"].lower()==sys.argv[2].lower()),""))' $tmp "$full")
if [ -n "$id" ]; then
  [ "$(api -X PATCH https://api.github.com/user/repository_invitations/$id)" = 204 ] || { cat $tmp; exit 1; }
  echo "pozvánka do $full prijatá"
else echo "pozvánka do $full nečaká"; fi
code=$(api https://api.github.com/repos/$full)
if [ "$code" != 200 ]; then echo "prístup: nie ($MACHINE nevidí $full, HTTP $code; vlastník ho musí pozvať s právom zápisu)"; exit 1; fi
push=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("permissions",{}).get("push",False))' $tmp)
ssh_cmd="ssh -F /dev/null -i $key -o IdentitiesOnly=yes -o UserKnownHostsFile=/root/.ssh/known_hosts_github"
(cd /tmp && GIT_SSH_COMMAND="$ssh_cmd" git ls-remote git@github.com:$full.git >/dev/null) || { echo "prístup: nie (kľúč $key repo nečíta)"; exit 1; }
[ "$push" = True ] || { echo "prístup: nie ($MACHINE repo vidí bez práva zápisu)"; exit 1; }
echo "prístup: áno ($MACHINE, zápis, kľúč $key)"
echo "v klone: git config core.sshCommand '$ssh_cmd'"
