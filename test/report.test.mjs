import test from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../dist/report.js";

const baseOpts = { failConfidence: 0.7, strict: false };
const verdict = (status, confidence) => ({
  claim: { docFile: "README.md", line: 1, text: "x" },
  status,
  confidence,
  explanation: "",
  evidence: [],
  engine: "reference",
});

test("drift below fail-confidence is counted but does not fail the build", () => {
  const s = summarize([verdict("drifted", 0.6)], { ...baseOpts });
  assert.equal(s.drifted, 1);
  assert.equal(s.failures.length, 0);
});

test("drift at or above fail-confidence fails the build", () => {
  const s = summarize([verdict("drifted", 0.9)], { ...baseOpts });
  assert.equal(s.failures.length, 1);
});

test("unverifiable claims fail only in strict mode", () => {
  const lenient = summarize([verdict("unverifiable", 0.3)], { ...baseOpts });
  assert.equal(lenient.failures.length, 0);

  const strict = summarize([verdict("unverifiable", 0.3)], { ...baseOpts, strict: true });
  assert.equal(strict.failures.length, 1);
});

test("ok verdicts are tallied and never fail", () => {
  const s = summarize([verdict("ok", 0.95), verdict("ok", 0.8)], { ...baseOpts });
  assert.equal(s.ok, 2);
  assert.equal(s.failures.length, 0);
});
