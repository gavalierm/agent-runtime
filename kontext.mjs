// Posledný riadok odpovede agenta pre čistý kontext a odovzdávka od
// kontext.sh (repo agent-rules, lib/kontext.mjs). Budič ani sledovač model
// nevolajú. Formát riadku:
//   HOTOVO-KONTEXT                      holé slovo, ako spanok
//   HOTOVO-KONTEXT spanok [<kľúč>]      len /clear
//   HOTOVO-KONTEXT pokracuj <kľúč>      /clear a správa s ďalším krokom
// Odovzdávka je $KONTEXT_DIR/<id relácie>.json (práva 600) s poľami key,
// rezim, dalej, stav, cwd, at a po použití budičom consumed. Hook
// clear_bridge.mjs repa agent-rules ju po /clear vloží do novej relácie
// a zmaže. cfg.kontextDir nastavuje config() v lib.mjs, bez neho (testy)
// sa odovzdávky nehľadajú.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DONE_WORD = "HOTOVO-KONTEXT";
const KEY = /^[0-9a-f]{8,64}$/;

// { rezim: "spanok"|"pokracuj", key: string|null } alebo null, keď posledný
// neprázdny riadok nie je pokyn na čistý kontext. Citát slova v texte
// (nie posledný riadok) ani riadok s iným druhým slovom nič nespustí.
export function parseDoneLine(text) {
  const last = String(text).split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  if (!last) return null;
  const [word, rezim, key, ...rest] = last.split(/\s+/);
  if (word !== DONE_WORD) return null;
  if (rezim === undefined) return { rezim: "spanok", key: null };
  if (rest.length || (rezim !== "spanok" && rezim !== "pokracuj")) return null;
  if (key !== undefined && !KEY.test(key)) return null;
  return { rezim, key: key ?? null };
}

// Nespotrebovaná odovzdávka s týmto kľúčom: { id, path, data } alebo null.
export function findHandoff(dir, key) {
  if (!dir || !key) return null;
  let names = [];
  try { names = readdirSync(dir); } catch { return null; }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const path = join(dir, n);
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (data?.key === key && !data.consumed) return { id: n.slice(0, -5), path, data };
    } catch {}
  }
  return null;
}

export function markConsumed(h) {
  writeFileSync(h.path, JSON.stringify({ ...h.data, consumed: true }, null, 2) + "\n", { mode: 0o600 });
}

// Rozhodnutie o čistení z odpovede agenta: { rezim, dalej, stav, warn, handoff }.
// pokracuj s platným kľúčom a ďalším krokom nesie odovzdávku v handoff, volajúci
// ju po zápise rozpracovaného stavu označí markConsumed. Inak sa správa ako
// spanok a warn nesie dôvod na výstrahu. null, keď riadok nie je pokyn.
export function decideClear(cfg, text) {
  const req = parseDoneLine(text);
  if (!req) return null;
  if (req.rezim === "spanok") return { rezim: "spanok", dalej: null, stav: null, warn: null };
  const h = findHandoff(cfg.kontextDir, req.key);
  if (!h) return { rezim: "spanok", dalej: null, stav: null, warn: `pokracuj bez platného kľúča${req.key ? ` (${req.key})` : ""}, čistím len /clear` };
  if (h.data.rezim !== "pokracuj" || !h.data.dalej) return { rezim: "spanok", dalej: null, stav: null, warn: `odovzdávka ${req.key} nie je pokracuj s ďalším krokom, čistím len /clear` };
  return { rezim: "pokracuj", dalej: String(h.data.dalej), stav: h.data.stav ? String(h.data.stav) : null, warn: null, handoff: h };
}

// Jediná správa po /clear: ďalší krok, bez pokynu čítať pamäť. Štart relácie
// (fetch, rebase, odovzdávka) urobil hook clear_bridge.mjs.
export function afterClearText(dalej) {
  return `[budič] Kontext vyčistený. Ďalší krok: ${dalej}`;
}
