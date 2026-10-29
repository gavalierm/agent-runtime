// Repo agenta, v ktorom beží relácia: hlavný checkout projektu z
// CLAUDE_PROJECT_DIR, z worktree .worktrees/<úloha> jeho hlavný checkout.
// Stav tém, pamäť a SSH obal agenta sú tam, nie v repe kódu, odkiaľ
// sa hooky spúšťajú.
//
// Chyba 19. 10. 2026: po presune hookov do spoločného repa odvodzovali
// topic.mjs a agent_inbox.mjs cesty od svojej polohy a hľadali témy
// a pamäť v tom repe namiesto v repe agenta.
//
// Bez CLAUDE_PROJECT_DIR (ručné spustenie z terminálu) je to pracovný
// priečinok.
import { resolve } from "node:path";

export const mainCheckout = (dir) => resolve(dir).replace(/\/\.worktrees\/[^/]+$/, "");
export const AGENT_REPO = mainCheckout(process.env.CLAUDE_PROJECT_DIR || process.cwd());
