# agent_rules.sh: cesta ku klonu repa pravidiel pre skripty bin/chyba.sh a
# bin/rozhodni.sh, ktoré z neho berú obal správcu úloh `bin/tk`. Načíta sa
# príkazom `source`. Cesta je AGENT_RULES, inak server /opt/agent-rules a Mac
# ~/Work/agent-rules (rovnaký vzor ako AGENT_RUNTIME v repe pravidiel).

agent_rules_dir() {
    if [ -n "${AGENT_RULES:-}" ]; then
        printf '%s' "$AGENT_RULES"
    elif [ "$(uname)" = Darwin ]; then
        printf '%s' "$HOME/Work/agent-rules"
    else
        printf '%s' /opt/agent-rules
    fi
}
