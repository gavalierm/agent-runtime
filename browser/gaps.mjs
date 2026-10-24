// Kontrola nalepených textov (--gaps). Dve časti:
// collectBoxes beží v stránke (page.evaluate) a vráti políčka riadkov vlastného
// textu prvkov (bez paddingu), findGaps je čistá funkcia nad tými políčkami, skúša sa bez prehliadača
// (test/gaps.test.mjs).

// Beží v stránke, preto nesmie siahať na nič mimo seba.
export function collectBoxes() {
  const out = [];
  const ids = new Map();
  const idOf = (el) => { if (!ids.has(el)) ids.set(el, ids.size); return ids.get(el); };
  const pathOf = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(`${s}#${e.id}`); break; }
      const cls = [...e.classList].slice(0, 2).join(".");
      if (cls) s += `.${cls}`;
      parts.unshift(s);
    }
    return parts.slice(-4).join(" > ");
  };
  const hidden = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (e.closest("svg") && e.tagName.toLowerCase() !== "svg") return true;
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return true;
    }
    return false;
  };
  for (const el of document.body.querySelectorAll("*")) {
    const texts = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    if (!texts.length || hidden(el)) continue;
    // Políčka samotného textu (Range), nie prvku, takže padding sa nepočíta.
    // Obdĺžniky s vrchom do 2 px patria jednému riadku a zlúčia sa.
    const lines = [];
    for (const t of texts) {
      const range = document.createRange();
      range.selectNodeContents(t);
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        const l = lines.find((x) => Math.abs(x.top - r.top) <= 2);
        if (!l) lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
        else { l.bottom = Math.max(l.bottom, r.bottom); l.left = Math.min(l.left, r.left); l.right = Math.max(l.right, r.right); }
      }
    }
    if (!lines.length) continue;
    const anc = [];
    for (let e = el.parentElement; e; e = e.parentElement) anc.push(idOf(e));
    const text = texts.map((n) => n.textContent.trim()).join(" ").replace(/\s+/g, " ").slice(0, 40);
    for (const l of lines) {
      out.push({ id: idOf(el), anc, path: pathOf(el), text, x: l.left, y: l.top + window.scrollY, w: l.right - l.left, h: l.bottom - l.top });
    }
  }
  return out;
}

// Dvojica prvkov s textom, ktoré sa vodorovne prekrývajú (nad 4 px) a zvislo sú od
// seba menej než min px (záporná vzdialenosť je prekrytie), nie sú predok a potomok
// a nie sú na jednom riadku (rovnaký vrch do 2 px).
export function findGaps(boxes, min = 6) {
  const found = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      let a = boxes[i], b = boxes[j];
      if (a.id === b.id || a.anc.includes(b.id) || b.anc.includes(a.id)) continue;
      if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) <= 4) continue;
      if (Math.abs(a.y - b.y) <= 2) continue;
      if (a.y > b.y) [a, b] = [b, a];
      const d = b.y - (a.y + a.h);
      if (d >= min) continue;
      found.push({ upper: a.path, lower: b.path, upperText: a.text, lowerText: b.text, d: Math.round(d * 10) / 10 });
    }
  }
  return found;
}

export function formatGaps(found) {
  return found.map((g) => `${g.d} px: "${g.upperText}" [${g.upper}] nad "${g.lowerText}" [${g.lower}]`).join("\n");
}
