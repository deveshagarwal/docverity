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
