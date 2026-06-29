import test from "node:test";
import assert from "node:assert/strict";
import { adjudicate } from "../dist/adjudicate.js";

const cand = (id) => ({
  id, kind: "flag", text: "--x", status: "drifted", location: "README.md:1", context: "", note: "",
});

test("parses host verdicts into real/false rulings", async () => {
  const sample = async () =>
    JSON.stringify({
      verdicts: [
        { id: "a", realProblem: false, reason: "illustrative example" },
        { id: "b", realProblem: true, reason: "flag is missing" },
      ],
    });
  const m = await adjudicate([cand("a"), cand("b")], sample);
  assert.equal(m.get("a").real, false);
  assert.equal(m.get("b").real, true);
  assert.match(m.get("a").reason, /example/);
});

test("tolerates prose-wrapped / fenced JSON from the model", async () => {
  const sample = async () =>
    'Sure:\n```json\n{"verdicts":[{"id":"a","realProblem":false,"reason":"x"}]}\n```\nDone.';
  const m = await adjudicate([cand("a")], sample);
  assert.equal(m.get("a").real, false);
});

test("returns empty map when sampling throws, so caller keeps deterministic verdicts", async () => {
  const sample = async () => {
    throw new Error("sampling not supported");
  };
  const m = await adjudicate([cand("a")], sample);
  assert.equal(m.size, 0);
});

test("returns empty map on unparseable output", async () => {
  const m = await adjudicate([cand("a")], async () => "no json here");
  assert.equal(m.size, 0);
});

import { adjudicateVerdicts } from "../dist/adjudicate.js";

const verdict = (status, text) => ({
  claim: { docFile: "README.md", line: 1, kind: "flag", text, assertion: "", searchHints: [] },
  status,
  severity: status === "ok" ? "info" : "error",
  confidence: 0.8,
  explanation: "x",
  evidence: [],
  engine: "reference",
});

test("adjudicateVerdicts drops rejected drift, keeps ok and confirmed", async () => {
  const verdicts = [verdict("ok", "--keep"), verdict("drifted", "--example"), verdict("drifted", "--real")];
  const sample = async (_sys, user) => {
    const ids = [...user.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
    return JSON.stringify({
      verdicts: ids.map((id) => ({ id, realProblem: id.includes("--real"), reason: "r" })),
    });
  };
  const { kept, dismissed, ran } = await adjudicateVerdicts("/tmp", verdicts, sample);
  assert.equal(ran, true);
  assert.equal(dismissed, 1);
  const texts = kept.map((v) => v.claim.text);
  assert.ok(texts.includes("--keep"), "ok verdict passes through");
  assert.ok(texts.includes("--real"), "confirmed drift kept");
  assert.ok(!texts.includes("--example"), "rejected drift dropped");
});

test("adjudicateVerdicts leaves verdicts unchanged when sampling fails", async () => {
  const { kept, ran } = await adjudicateVerdicts("/tmp", [verdict("drifted", "--x")], async () => {
    throw new Error("no sampling");
  });
  assert.equal(ran, false);
  assert.equal(kept.length, 1);
});
