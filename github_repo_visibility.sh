#!/bin/sh
# Prepne viditeľnosť existujúceho repa v účte AGENT_GH_OWNER tokenom vlastníka.
# Použitie: github_repo_visibility.sh <repo> public|private [cesta ku klonu]
# public len na výslovný pokyn operátora (D0167). S cestou ku klonu pred prepnutím na public
# spustí lib/public_check.mjs na súbory a na všetky commity (mená ľudí, agentov, strojov, D0169).
# Token: $HOME/.config/$AGENT_MANAGER/github_token (600). Skončí riadkom "overené: ..." z anonymného GET.
set -eu
OWNER=${AGENT_GH_OWNER:?AGENT_GH_OWNER}; MANAGER=${AGENT_MANAGER:?AGENT_MANAGER}
repo=${1:?repo}; vis=${2:?public|private}; clone=${3:-}
case $vis in public) priv=false;; private) priv=true;; *) echo "viditeľnosť: public alebo private" >&2; exit 2;; esac
here=$(cd "$(dirname "$0")" && pwd)
if [ "$vis" = public ] && [ -n "$clone" ]; then
  PUBLIC_CHECK_ROOT=$clone PUBLIC_CHECK_LIST=$here/lib/public_check.txt node "$here/lib/public_check.mjs"
  (cd "$clone" && PUBLIC_CHECK_ROOT=$clone PUBLIC_CHECK_LIST=$here/lib/public_check.txt node "$here/lib/public_check.mjs" --commits HEAD)
  (cd "$clone" && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main 2>/dev/null)" ]) || { echo "klon nie je na origin/main, najprv push" >&2; exit 1; }
fi
T=$(cat /root/.config/$MANAGER/github_token)
tmp=/tmp/gh_vis.$$; trap 'rm -f $tmp' EXIT
code=$(curl -sS -o $tmp -w '%{http_code}' -X PATCH -H "Authorization: Bearer $T" -H 'Accept: application/vnd.github+json' \
  https://api.github.com/repos/$OWNER/$repo -d "{\"private\":$priv}")
[ "$code" = 200 ] || { cat $tmp; exit 1; }
echo "repo $OWNER/$repo: $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["visibility"])' $tmp)"
anon=$(curl -sS -o /dev/null -w '%{http_code}' https://api.github.com/repos/$OWNER/$repo)
case "$vis:$anon" in public:200|private:404) echo "overené: anonymný GET $anon";; *) echo "anonymný GET $anon nesedí s $vis" >&2; exit 1;; esac
