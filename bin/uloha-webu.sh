#!/bin/sh
# Založí úlohu agentovi webu a overí bránu mockupu. Úlohu agentovi webu
# zakladaj len touto cestou (hook web_review.mjs). Práve jedna z volieb:
#   --mockup <id>          hotová úloha dizajnéra s komentárom "Mockup schválený:" od iného autora
#   --bez-mockupu "<dôvod>"  zmena bez nového vzhľadu alebo priamy pokyn operátora k dizajnu
#   uloha-webu.sh --project P [--parent N] --assign <agent webu> --title T --body B (--mockup N | --bez-mockupu D) [--verify V] [--model M] [--max-runs N]
exec node "$(dirname "$0")/../lib/web_gate.mjs" create "$@"
