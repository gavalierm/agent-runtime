# deny.sh — jediné miesto, ktoré git hooky lib/*guard*.sh použijú na
# odmietnutie commitu (D0141, úloha 424). Načíta sa príkazom `source`.
#
#   deny_postup "<dôvod>" "<správny postup>"
#
# Vypíše dôvod a riadok "Správny postup: <krok>" na stderr. Prázdny postup je
# chyba programátora hooku: funkcia vráti 2 a vypíše, že postup chýba.
# Volajúci si nastaví vlastný kód odmietnutia (rc=1, status=1).
# Strážca: lib/deny_check.mjs, volá ho check.mjs.

deny_postup() {
    local reason="${1:-}" postup="${2:-}"
    if [ -z "${reason//[[:space:]]/}" ] || [ -z "${postup//[[:space:]]/}" ]; then
        echo "deny.sh: zamietnutie bez dôvodu alebo bez správneho postupu: '$reason'" >&2
        return 2
    fi
    printf '%s\n' "$reason" >&2
    printf 'Správny postup: %s\n' "$postup" >&2
}
