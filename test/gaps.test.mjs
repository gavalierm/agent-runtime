import { test } from "node:test";
import assert from "node:assert/strict";
import { findGaps } from "../browser/gaps.mjs";

const box = (id, y, o = {}) => ({ id, anc: [], path: `div#${id}`, text: String(id), x: 0, w: 200, h: 16, y, ...o });

test("findGaps: nalepený pár nájde, odsadený nie", () => {
  const f = findGaps([box(1, 0), box(2, 16), box(3, 60)], 6);
  assert.equal(f.length, 1);
  assert.equal(f[0].d, 0);
  assert.equal(f[0].upperText, "1");
});

test("findGaps: prekrytie sa hlási, predok a potomok nie", () => {
  assert.equal(findGaps([box(1, 0), box(2, 10)]).length, 1);
  assert.equal(findGaps([box(1, 0), box(2, 15)]).length, 1);
  assert.equal(findGaps([box(1, 0), box(2, 10, { anc: [1] })]).length, 0);
});

test("findGaps: ten istý riadok a vodorovne oddelené prvky sa preskočia", () => {
  assert.equal(findGaps([box(1, 0), box(2, 1, { x: 100 })]).length, 0);
  assert.equal(findGaps([box(1, 0, { w: 100 }), box(2, 16, { x: 102 })]).length, 0);
});
