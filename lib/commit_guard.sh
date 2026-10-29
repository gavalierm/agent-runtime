#!/bin/bash
# Zábrana commitu agenta, volá ju hook commit-msg repa s cestou k správe,
# z nasadeného klonu kódu (workflow_dir v lib/paths.sh). Kód 0 commit pustí,
# 1 odmietne.
#
# Odmietne správu s trailerom Co-Authored-By alebo Claude-Session, commit,
# ktorého autor nemá e-mail z git_email.txt (ten GitHub priradí k účtu
# operátora, iný commit ostane bez účtu), a autora, ktorého meno nie je
# "<Agent> (<stroj>)" s agentom z roles/agents.md spoločného mozgu, napríklad
# "Adam (server)" alebo "Cyril (mac)". Ak má repo (meno z `git remote
# get-url origin` bez .git) riadok v repo_authors.txt, odmietne aj autora
# mimo agentov v ňom (napríklad kód Taskera smie meniť len jeho vývojár).
# Repo bez riadku sa nemení.
#
# Dáta nasadenia (e-mail a autori repí) sú v $AGENT_BRAIN_GLOBAL/commit_guard/,
# bez nich platia vzorové súbory v lib/ tohto repa.
#
# Chyba 19. 10. 2026: commity agentov a ich sub-agentov niesli Co-Authored-By,
# hoci ho rozhodnutie zo 16. 10. 2026 zakázalo (spoločné nastavenie servera
# nemalo attribution), a e-mail, ktorý GitHub k účtu nepriradil. Na Macu
# commitoval zástupca pod menom operátora, na serveri sub-agenti pod globálnym
# menom správcu servera.
# Chyba 24. 10. 2026: do repa Taskera prišli commity s autorom správcu agentov,
# hoci kód Taskera píše jeho vývojár, a repo nemalo hook.
set -u

msg="${1:?cesta k správe commitu}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deny.sh
source "$here/deny.sh"
# shellcheck source=paths.sh
source "$here/paths.sh"
# Dáta nasadenia zo spoločného mozgu, inak vzorový súbor v lib/.
datafile() {
    local f
    f="$(brain_global_dir)/commit_guard/$1"
    [ -r "$f" ] || f="$here/$1"
    printf '%s' "$f"
}
want="$(tr -d '[:space:]' < "$(datafile git_email.txt)")"
authors_file="$(datafile repo_authors.txt)"
rc=0

if grep -qiE '^(Co-Authored-By|Claude-Session):' "$msg"; then
    deny_postup "Commit odmietnutý: správa nesie trailer Co-Authored-By alebo Claude-Session." \
        "zmaž riadok s trailerom zo správy commitu a commit zopakuj (git commit -m \"...\" -- <súbory>, správa bez Co-Authored-By)."
    rc=1
fi
ident="$(git var GIT_AUTHOR_IDENT)"
author="$(sed -n 's/.*<\(.*\)>.*/\1/p' <<<"$ident")"
name="$(sed -n 's/^\(.*\) <.*/\1/p' <<<"$ident")"
agents="$(sed -n 's/^| \([A-Z][a-z]*\) | \([^|]*\)|.*/\1 \2/p' "$(brain_global_dir)/roles/agents.md" | grep -v ' operátor *$' | cut -d' ' -f1 | paste -sd'|' -)"
if ! grep -qE "^($agents) \([a-z0-9.-]+\)\$" <<<"$name"; then
    deny_postup "Commit odmietnutý: meno autora je '$name', má byť '<Agent> (<stroj>)', agent z roles/agents.md ($agents)." \
        "git -c user.name='<Agent> (<stroj>)' commit ..., alebo nastav lokálny user.name klonu (git config user.name '<Agent> (<stroj>)')."
    rc=1
fi
repo="$(git remote get-url origin 2>/dev/null)"
repo="$(basename "${repo%.git}")"
if [ -n "$repo" ] && [ -r "$authors_file" ]; then
    while IFS=$'\t' read -r rname rallowed rdec; do
        case "$rname" in ''|'#'*) continue ;; esac
        [ "$rname" = "$repo" ] || continue
        who="${name%% (*}"
        if ! grep -qxE "($rallowed)" <<<"$who"; then
            deny_postup "Commit odmietnutý: repo $repo smie meniť len $rallowed ($rdec), autor je '$name'." \
                "zadaj prácu v Taskeri úlohou s riešiteľom ${rallowed,,} (napríklad kód Taskera mení len jeho vývojár), commit v $repo nerob."
            rc=1
        fi
    done < "$authors_file"
fi
if [ "$author" != "$want" ]; then
    deny_postup "Commit odmietnutý: e-mail autora je '$author', má byť $want (git_email.txt)." \
        "git config --global user.email $want a zmaž lokálny user.email repa (git config --unset user.email)."
    rc=1
fi
exit $rc
