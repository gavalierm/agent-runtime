#!/bin/bash
# Prihlásenie zariadenia pre strojový účet, token do súboru 600.
set -e
CID=${GH_CLIENT_ID:?GH_CLIENT_ID (client id aplikácie OAuth)}
OUT=${OUT:-$HOME/.config/${AGENT_MANAGER:?AGENT_MANAGER}/github_agent_token}
R=$(curl -s -X POST -H 'Accept: application/json' https://github.com/login/device/code -d "client_id=$CID&scope=repo admin:public_key read:user")
DC=$(echo "$R" | python3 -c 'import json,sys;print(json.load(sys.stdin)["device_code"])')
echo "$R" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["user_code"],d["verification_uri"],d["interval"])' > ${CODE_FILE:-$PWD/scratch/device_code.txt}
for i in $(seq 1 150); do
  sleep 6
  T=$(curl -s -X POST -H 'Accept: application/json' https://github.com/login/oauth/access_token -d "client_id=$CID&device_code=$DC&grant_type=urn:ietf:params:oauth:grant-type:device_code")
  TOK=$(echo "$T" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("access_token",""))')
  if [ -n "$TOK" ]; then
    WHO=$(curl -s -H "Authorization: Bearer $TOK" https://api.github.com/user | python3 -c 'import json,sys;print(json.load(sys.stdin).get("login",""))')
    [ "$WHO" = "${EXPECT:-${AGENT_GH_MACHINE:?AGENT_GH_MACHINE}}" ] || { echo "WRONG_ACCOUNT $WHO"; exit 2; }
    umask 077; printf '%s' "$TOK" > $OUT; chmod 600 $OUT; echo OK; exit 0; fi
  echo "$T" | grep -q 'expired_token\|access_denied' && { echo "$T"; exit 1; }
done
echo TIMEOUT; exit 1
