#!/bin/sh
# Založí súkromné repo v účte AGENT_GH_OWNER (s --public verejné), pozve doň strojový účet AGENT_GH_MACHINE a pozvánku prijme.
# Použitie: github_repo.sh [--public] <repo> <agent> [popis]   (agent: tasker alebo meno s kľúčom /root/.ssh/${AGENT_GH_MACHINE}_<meno>)
# --public len na výslovný pokyn operátora, existujúce repo viditeľnosť nemení.
# Tokeny: $HOME/.config/$AGENT_MANAGER/github_token (vlastník rep), $HOME/.config/$AGENT_MANAGER/github_agent_token (strojový účet), obe 600.
# Kľúč agenta: /root/.ssh/${AGENT_GH_MACHINE}_<meno>, pre tasker /home/$AGENT_TASKER_USER/.ssh/${AGENT_GH_MACHINE}_tasker.
set -eu
OWNER=${AGENT_GH_OWNER:?AGENT_GH_OWNER}; MACHINE=${AGENT_GH_MACHINE:?AGENT_GH_MACHINE}
MANAGER=${AGENT_MANAGER:?AGENT_MANAGER}; TUSER=${AGENT_TASKER_USER:?AGENT_TASKER_USER}
priv=true; [ "${1:-}" = --public ] && { priv=false; shift; }
repo=${1:?repo}; agent=${2:?agent meno|tasker}; desc=${3:-}
case $agent in
  tasker) key=/home/$TUSER/.ssh/${MACHINE}_tasker; kh=/home/$TUSER/.ssh/known_hosts; run="runuser -u $TUSER --" ;;
  *[!a-z0-9]*|"") echo "agent: tasker alebo meno malými písmenami" >&2; exit 2 ;;
  *) key=/root/.ssh/${MACHINE}_$agent; kh=/root/.ssh/known_hosts_github; run=""
     [ -f "$key" ] || { echo "chýba kľúč $key (agent_vlakno.sh ho založí)" >&2; exit 2; } ;;
esac
T=$(cat /root/.config/$MANAGER/github_token)
A=$(cat /root/.config/$MANAGER/github_agent_token)
tmp=/tmp/gh_repo.$$; trap 'rm -f $tmp' EXIT
api() { tok=$1; shift; curl -sS -o $tmp -w '%{http_code}' -H "Authorization: Bearer $tok" -H 'Accept: application/vnd.github+json' "$@"; }
code=$(api "$T" https://api.github.com/repos/$OWNER/$repo)
if [ "$code" = 404 ]; then
  body=$(python3 -c 'import json,sys;print(json.dumps({"name":sys.argv[1],"private":sys.argv[3]=="true","description":sys.argv[2]}))' "$repo" "$desc" "$priv")
  code=$(api "$T" -X POST https://api.github.com/user/repos -d "$body"); [ "$code" = 201 ] || { cat $tmp; exit 1; }
  echo "repo založené: $OWNER/$repo ($( [ $priv = true ] && echo súkromné || echo verejné ))"
else echo "repo existuje: $OWNER/$repo ($code)"; fi
code=$(api "$T" -X PUT https://api.github.com/repos/$OWNER/$repo/collaborators/$MACHINE -d '{"permission":"push"}')
case $code in 201) echo "pozvánka pre $MACHINE poslaná";; 204) echo "$MACHINE už je v repe";; *) cat $tmp; exit 1;; esac
if [ "$code" = 201 ]; then
  id=$(api "$A" https://api.github.com/user/repository_invitations >/dev/null; python3 -c 'import json,sys;print(next((i["id"] for i in json.load(open(sys.argv[1])) if i["repository"]["name"]==sys.argv[2]),""))' $tmp "$repo")
  [ -n "$id" ] || { echo "pozvánka sa nenašla" >&2; exit 1; }
  [ "$(api "$A" -X PATCH https://api.github.com/user/repository_invitations/$id)" = 204 ] || { cat $tmp; exit 1; }
  echo "pozvánka prijatá"
fi
ssh_cmd="ssh -F /dev/null -i $key -o IdentitiesOnly=yes -o UserKnownHostsFile=$kh"
(cd /tmp && $run env GIT_SSH_COMMAND="$ssh_cmd" git ls-remote git@github.com:$OWNER/$repo.git >/dev/null) && echo "overené: kľúč účtu $MACHINE má prístup"
echo "v klone: git config core.sshCommand '$ssh_cmd'"
