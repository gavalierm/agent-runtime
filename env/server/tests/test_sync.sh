#!/bin/bash
# Test env/server/sync.sh so skutočným gitom: dva origin (kód, mozog) sú
# miestne holé repá v $T, klony a schránky sú tiež v $T.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
S="$REPO/env/server/sync.sh"
export AR_CLONES="$T/wf-clone $T/brain-clone" AR_INBOXES="$T/box1 $T/box2"
# Predvolená cesta sync.sh do živej schránky by test zapísala do nej, preto
# žiadny beh nejde pred touto kontrolou.
check "sync.sh nemá cestu do živej schránky" 1 grep -q '/var/lib/' "$S"
grep -q '/var/lib/' "$S" && exit 1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
mkdir -p "$T/box1" "$T/box2"

# mk_repo meno: holé repo, pracovná kópia $T/<meno>-work s prvým commitom, klon $T/<meno>-clone
mk_repo() {
    git init -q --bare "$T/$1.git"
    git clone -q "$T/$1.git" "$T/$1-work" 2>/dev/null
    mkdir -p "$T/$1-work/env/server"
    echo v1 > "$T/$1-work/RULES.md"
    echo e1 > "$T/$1-work/env/server/RULES.md"
    git -C "$T/$1-work" add -A && git -C "$T/$1-work" commit -q -m prvy && git -C "$T/$1-work" push -q origin HEAD 2>/dev/null
    git clone -q "$T/$1.git" "$T/$1-clone"
}
mk_repo wf
mk_repo brain
# commit_ repo súbor text správa: commit a push v pracovnej kópii
commit_() {
    mkdir -p "$T/$1-work/$(dirname "$2")"
    echo "$3" > "$T/$1-work/$2"
    git -C "$T/$1-work" add -A
    git -C "$T/$1-work" commit -q -m "$4"
    git -C "$T/$1-work" push -q origin HEAD 2>/dev/null
}
msgs() { cat "$T"/box1/pravidla-* "$T"/box2/pravidla-* 2>/dev/null; }
head_() { git -C "$T/$1-clone" rev-parse --short HEAD; }
nomsg() { test -z "$(find "$T/box1" "$T/box2" -type f)"; }

check "bez zmeny prejde" 0 "$S"
check "bez zmeny žiadna správa" 0 nomsg

commit_ wf skills/x.md x "kod mimo pravidiel"
commit_ brain skills/y.md y "mozog mimo pravidiel"
check "zmena mimo sledovaných ciest prejde" 0 "$S"
check "zmena mimo sledovaných ciest žiadna správa" 0 nomsg
check "oba klony sú posunuté" 0 test "$(head_ wf)" = "$(git -C "$T/wf-work" rev-parse --short HEAD)" -a "$(head_ brain)" = "$(git -C "$T/brain-work" rev-parse --short HEAD)"

# env/server klonu kódu je kód, nie pravidlá: správu nespôsobí.
commit_ wf env/server/RULES.md zmena "env server kodu"
check "env/server klonu kódu prejde" 0 "$S"
check "env/server klonu kódu žiadna správa" 0 nomsg

wf_old="$(head_ wf)"
commit_ wf RULES.md v2 "nove pravidlo kodu"
wf_new="$(git -C "$T/wf-work" rev-parse --short HEAD)"
check "zmena RULES.md kódu prejde" 0 "$S"
check "klon kódu je posunutý" 0 test "$(head_ wf)" = "$wf_new"
check "správa u prvej schránky" 0 test "$(find "$T/box1" -regextype posix-extended -regex '.*/pravidla-[0-9]{8}-[0-9]{6}-[0-9]+\.md' | wc -l)" = 1
check "správa u druhej schránky" 0 test "$(find "$T/box2" -name 'pravidla-*' | wc -l)" = 1
check "obsah správy" 0 msgs
contains "prvý riadok je na vedomie" "odpoveď: na vedomie"
contains "druhý riadok" "[pravidlá] Zmena pravidiel."
contains "rozsah kódu" "Zmena workflow $wf_old..$wf_new"
contains "log" "$wf_new nove pravidlo kodu"
contains "diff" "+v2"
lacks "mozog bez zmeny nie je v správe" "Zmena brain"
lacks "commit mimo sledovaných ciest nie je v logu" "mimo pravidiel"
check "prvý riadok súboru" 0 test "$(head -1 "$T"/box1/pravidla-*)" = "odpoveď: na vedomie"
check "žiadny skrytý súbor" 0 test -z "$(find "$T/box1" "$T/box2" -name '.*' -type f)"

rm -f "$T"/box1/* "$T"/box2/*
br_old="$(head_ brain)"
commit_ brain env/server/RULES.md s1 "prostredie servera v mozgu"
br_new="$(git -C "$T/brain-work" rev-parse --short HEAD)"
check "zmena env/server mozgu prejde" 0 "$S"
check "zmena env/server mozgu posiela správu" 0 test "$(find "$T/box1" -name 'pravidla-*' | wc -l)" = 1
check "obsah správy mozgu" 0 msgs
contains "rozsah mozgu" "Zmena brain $br_old..$br_new"
contains "diff env/server mozgu" "+s1"
lacks "kód bez zmeny nie je v správe" "Zmena workflow"

# Obe zmeny naraz v jednej správe.
rm -f "$T"/box1/* "$T"/box2/*
commit_ wf RULES.md v3 "kod naraz"
commit_ brain RULES.md b3 "mozog naraz"
check "obe zmeny naraz prejdú" 0 "$S"
check "obsah spoločnej správy" 0 msgs
contains "kód v spoločnej správe" "kod naraz"
contains "mozog v spoločnej správe" "mozog naraz"
check "u prvej schránky jedna správa" 0 test "$(find "$T/box1" -name 'pravidla-*' | wc -l)" = 1

# Neodoslaná správa v schránke: nová ju nahradí a nesie rozsah od jej začiatku.
rm -f "$T"/box1/* "$T"/box2/*
first_wf="$(head_ wf)"
first_br="$(head_ brain)"
commit_ wf RULES.md v4a "prva zmena"
check "prvá zmena prejde" 0 "$S"
mid="$(head_ wf)"
commit_ wf RULES.md v4b "druha zmena"
commit_ brain RULES.md b4 "zmena mozgu po prvej"
check "druhá zmena prejde" 0 "$S"
last="$(head_ wf)"
last_br="$(head_ brain)"
check "u prvej schránky je jedna správa" 0 test "$(find "$T/box1" -name 'pravidla-*' | wc -l)" = 1
check "u druhej schránky je jedna správa" 0 test "$(find "$T/box2" -name 'pravidla-*' | wc -l)" = 1
check "obsah zlúčenej správy" 0 msgs
contains "rozsah kódu od začiatku starej" "Zmena workflow $first_wf..$last"
lacks "stredný rozsah nie je" "Zmena workflow $mid..$last"
contains "rozsah mozgu od jeho HEAD pred behom" "Zmena brain $first_br..$last_br"
contains "log prvej zmeny" "prva zmena"
contains "log druhej zmeny" "druha zmena"
# Odoslaná správa (už nie je v schránke) sa nezlučuje.
rm -f "$T"/box1/* "$T"/box2/*
commit_ wf RULES.md v4c "tretia zmena"
check "tretia zmena prejde" 0 "$S"
check "obsah tretej správy" 0 msgs
contains "rozsah len tretej" "Zmena workflow $last.."
lacks "prvá zmena nie je v tretej" "prva zmena"

rm -f "$T"/box1/* "$T"/box2/*
commit_ wf RULES.md v5 "dalsie"
# Root zapíše aj do priečinka bez práv, chyba zápisu je preto chýbajúca schránka.
AR_INBOXES="$T/chyba $T/box2" check "zlyhaný zápis nezastaví pull" 0 "$S"
contains "hlási zlyhanie" "zlyhal"
check "klon je posunutý aj pri chybe zápisu" 0 test "$(head_ wf)" = "$(git -C "$T/wf-work" rev-parse --short HEAD)"
check "druhá schránka správu dostala" 0 test "$(find "$T/box2" -name 'pravidla-*' | wc -l)" = 1

rm -f "$T"/box1/* "$T"/box2/*
commit_ wf RULES.md v6 "po hooku"
# Po nasadení hooku rules_delta.mjs má služba AR_INBOXES prázdne.
AR_INBOXES="" check "prázdne AR_INBOXES prejde" 0 "$S"
check "prázdne AR_INBOXES nepíše do schránok" 0 test "$(find "$T/box1" "$T/box2" -name 'pravidla-*' | wc -l)" = 0
check "prázdne AR_INBOXES posunie klon" 0 test "$(head_ wf)" = "$(git -C "$T/wf-work" rev-parse --short HEAD)"

AR_CLONES="$T/wf-clone" check "jeden klon je chyba" 1 "$S"
contains "hlási počet ciest" "dve cesty"
git -C "$T/brain-clone" remote set-url origin "$T/nie.git"
check "zlyhaný pull je chyba" 1 "$S"
finish
