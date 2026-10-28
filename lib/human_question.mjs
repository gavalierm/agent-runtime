// human_question.mjs: kontrola, že otázka pre človeka stojí sama (global §2,
// "A question or step for a person stands alone"). Chyba 25. 10. 2026: zhrnutie
// behu úlohy 573 znelo "Čaká na operátorovo A/B k zápisu do agent-rules", web
// Taskera ho ukázal bez veci, otázky a významu A a B (úloha 575). Volá ju hook
// human_question.mjs repa pravidiel (tasker result needs_human, tasker ask)
// a reply_guard.mjs (položka "(rozhodnutie)" v "Čaká na teba:"). Čistá funkcia
// nad textom, nič nečíta zo systému.
//
// Chyba 28. 10. 2026 (úloha 656): komentár úlohy s otázkou A) B) niesol odsek
// "Neoverené: ...". Otázka pre človeka nenesie neoverené tvrdenie (global §1),
// preto questionProblem zamieta aj text so značkou neoverenosti (unverifiedClaim).

const L = "\\p{L}\\p{N}";
const LETTER = "[A-D]";
// Písmeno stojí osamote (nie v slove, ceste ani URL).
const SOLO = (re) => new RegExp(`(?<![${L}/.\\-_])${re}(?![${L}/_])`, "gu");

// Voľba písmenom: dvojica "A/B", "A alebo B", "A or B"; "variant A", "odporúčam A";
// "cesty A a B". Samotné "A" (spojka na začiatku vety) ani "variantu A" (odkaz na
// starší výber) voľbu nenesú.
const PAIR = SOLO(`(${LETTER})\\s*(?:/|alebo|or)\\s*(${LETTER})`);
const NAMED = new RegExp(`(?<![${L}])(?:[Vv]ariant|[Oo]ption|[Vv]oľba|[Mm]ožnosť|[Oo]dporúčam|[Rr]ecommend|[Cc]hoose|[Vv]yber|[Zz]voľ)\\s+(${LETTER})(?![${L}/_])`, "gu");
const LISTED = new RegExp(`(?<![${L}])(?:[Cc]esty|[Vv]arianty|[Mm]ožnosti|[Oo]ptions|[Pp]aths)\\s+(${LETTER})\\s+(?:a|and|alebo|or)\\s+(${LETTER})(?![${L}/_])`, "gu");

const withoutNoise = (text) => text
  .replace(/```[\s\S]*?(```|$)/g, " ")
  .replace(/`[^`\n]*`/g, " ")
  .replace(/https?:\/\/[^\s<>)"'`\]]+/g, " ");

// Písmená volieb, ktoré text používa.
export function usedLetters(text) {
  const t = withoutNoise(text);
  const out = new Set();
  for (const re of [PAIR, NAMED, LISTED]) for (const m of t.matchAll(re)) for (const g of m.slice(1)) if (g) out.add(g);
  return out;
}

// Písmeno je definované tvarom "A) ...", "(A) ..." alebo "A: ...".
export function isDefined(text, letter) {
  return new RegExp(`(?<![${L}])\\(?${letter}[):]\\s*[^\\s)]`, "u").test(withoutNoise(text));
}

// Veta končiaca otáznikom: "?" pred medzerou alebo koncom, nie v URL.
export function hasQuestion(text) {
  return /\?(?=\s|$|["'»)\]])/.test(withoutNoise(text));
}

// Značky neoverenosti (rovnaký vzor ako UNVERIFIED v hooks/reply_guard.mjs).
const UNVERIFIED = new RegExp(`(?<![${L}])(?:neoveren[${L}]*|neoveril[${L}]*|zatiaľ\\s+nevieme|nie\\s+je\\s+overen[${L}]*|unverified|not\\s+(?:yet\\s+)?verified|haven['’]t\\s+verified|have\\s+not\\s+verified)(?![${L}])`, "iu");

// Prvá veta s neoverenou položkou (kód, bloky kódu a URL sa nekontrolujú) alebo null.
export function unverifiedClaim(text) {
  const t = withoutNoise(String(text ?? ""));
  for (const part of t.split(/\n+/)) {
    for (const s of part.split(/(?<=[.!?])\s+/)) {
      if (UNVERIFIED.test(s)) return s.replace(/\s+/g, " ").trim();
    }
  }
  return null;
}

const clip = (s, n = 80) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

// Dôvod zamietnutia alebo null.
export function questionProblem(text) {
  const t = String(text ?? "");
  const noQuestion = !hasQuestion(t);
  const undef = [...usedLetters(t)].filter((l) => !isDefined(t, l)).sort();
  const claim = unverifiedClaim(t);
  if (!noQuestion && !undef.length && !claim) return null;
  const parts = [];
  if (noQuestion) parts.push("nemá vetu končiacu `?`");
  if (undef.length) parts.push(`spomína voľbu ${undef.join(", ")} bez definície tvaru \`${undef[0]}) ...\` v tom istom texte`);
  if (claim) parts.push(`obsahuje neoverené tvrdenie "${clip(claim)}"`);
  return `text pre človeka ${parts.join(" a ")}`;
}

// Položky "(rozhodnutie)" pod "Čaká na teba:" (riadok zoznamu `- ...`).
export function decisionItems(text) {
  const m = String(text ?? "").match(/Čaká na teba:\s*\n([\s\S]*)$/i);
  if (!m) return [];
  const out = [];
  for (const raw of m[1].split("\n")) {
    const l = raw.trim();
    if (!/^[-*+]\s/.test(l)) { if (l) break; continue; }
    if (/\(rozhodnutie\)/.test(l)) out.push(l.replace(/^[-*+]\s+/, ""));
  }
  return out;
}

// Dôvod pre prvú položku (rozhodnutie), ktorá nestojí sama, alebo null.
export function waitingItemProblem(text) {
  for (const item of decisionItems(text)) {
    const why = questionProblem(item);
    if (why) return `položka "Čaká na teba" (rozhodnutie) "${item.length > 60 ? `${item.slice(0, 57)}...` : item}": ${why}`;
  }
  return null;
}

// Krok v účte operátora "(tvoj účet)" v "Čaká na teba" stojí na stave jeho
// účtu, ktorý agent často nevidí (agent poslal operátora prepojiť organizáciu
// Console s tvrdením, že nemá kúpené kredity, hoci to nevidel, D0194).
// Odpoveď s takou položkou nesie riadok "Overené:" s príkazom alebo stránkou,
// ktorou agent stav účtu overil, a čo overiť nevedel.
export function accountItemProblem(text) {
  const t = String(text ?? "");
  const m = t.match(/Čaká na teba:([\s\S]*)$/i);
  if (!m || !/\(tvoj účet\)/i.test(m[1])) return null;
  if (/^\s*Overené:\s*\S/im.test(t)) return null;
  return 'položka "Čaká na teba" (tvoj účet) bez riadku "Overené:"';
}
