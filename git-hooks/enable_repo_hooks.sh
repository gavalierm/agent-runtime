#!/bin/bash
# Zapne globálne git hooky (git-hooks/global) lokálnym core.hooksPath len v klonoch
# pod <koreň>, ktorých origin (meno bez .git) má riadok v repo_authors.txt
# (lib/commit_guard.sh, dáta nasadenia v $AGENT_BRAIN_GLOBAL/commit_guard/).
# Klon s vlastným lokálnym core.hooksPath nechá. Ostatné klony (projekty
# používateľa správcu úloh majú user.name, ktoré commit_guard.sh odmietne)
# ostanú bez zmeny, preto tento používateľ nedostane globálny hooksPath. Úloha Taskera 565.
# Použitie: enable_repo_hooks.sh <koreň> [<priečinok hookov>] (spúšťa sa pod vlastníkom klonov)
set -u
root="${1:?koreň, pod ktorým hľadať klony}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
hooks="${2:-$here/global}"
# shellcheck source=../lib/paths.sh
. "$here/../lib/paths.sh"
authors="$(brain_global_dir)/commit_guard/repo_authors.txt"
[ -r "$authors" ] || authors="$here/../lib/repo_authors.txt"
[ -d "$root" ] || exit 0
find "$root" -maxdepth 5 -name .git -not -path '*/node_modules/*' 2>/dev/null | while IFS= read -r g; do
    repo="$(dirname "$g")"
    url="$(git -C "$repo" remote get-url origin 2>/dev/null)" || continue
    name="$(basename "${url%.git}")"
    grep -qE "^${name}	" "$authors" || continue
    git -C "$repo" config --local --get core.hooksPath >/dev/null && continue
    git -C "$repo" config --local core.hooksPath "$hooks" && echo "hooky zapnuté: $repo"
done
exit 0
