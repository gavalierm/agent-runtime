# paths.sh: cesty ku klonom kódu a spoločného mozgu agentov pre shellové
# skripty, rovnako ako lib/paths.mjs. Načíta sa príkazom `source`.
# Cesta je AGENT_WORKFLOW a AGENT_BRAIN_GLOBAL, inak na macOS
# ~/Work/agentic-workflow a ~/Work/agentic-brain-global, inak /opt/<repo>.

workflow_dir() {
    if [ -n "${AGENT_WORKFLOW:-}" ]; then
        printf '%s' "$AGENT_WORKFLOW"
    elif [ "$(uname)" = Darwin ]; then
        printf '%s' "${HOME:-}/Work/agentic-workflow"
    else
        printf '%s' /opt/agentic-workflow
    fi
}

brain_global_dir() {
    if [ -n "${AGENT_BRAIN_GLOBAL:-}" ]; then
        printf '%s' "$AGENT_BRAIN_GLOBAL"
    elif [ "$(uname)" = Darwin ]; then
        printf '%s' "${HOME:-}/Work/agentic-brain-global"
    else
        printf '%s' /opt/agentic-brain-global
    fi
}

decisions_dir() {
    printf '%s/decisions' "$(brain_global_dir)"
}
