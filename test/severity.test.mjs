import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyReference } from "../dist/verify-reference.js";
import { driftSeverity } from "../dist/severity.js";
import { isFailure, summarize } from "../dist/report.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "docverity-sev-"));
const claim = (kind, text) => ({
  id: "x", docFile: "README.md", line: 1, kind, text, assertion: "", searchHints: [text],
});
const verdict = (severity, status = "drifted", confidence = 0.9) => ({
  claim: { docFile: "README.md", line: 1, text: "x" },
  status, severity, confidence, explanation: "", evidence: [], engine: "reference",
});
const opts = (failOn) => ({ failConfidence: 0.7, failOn, strict: false });

test("flags/env are errors; files/symbols are warnings", () => {
  assert.equal(driftSeverity("flag"), "error");
  assert.equal(driftSeverity("env"), "error");
  assert.equal(driftSeverity("file"), "warning");
  assert.equal(driftSeverity("symbol"), "warning");
});

test("the reference engine stamps severity on drifts", async () => {
  const dir = tmp();
  const v = await verifyReference(dir, [claim("flag", "--gone"), claim("file", "src/gone.ts")]);
  const by = (t) => v.find((x) => x.claim.text === t);
  assert.equal(by("--gone").severity, "error");
  assert.equal(by("src/gone.ts").severity, "warning");
});

test("default policy fails on errors, not warnings", () => {
  assert.equal(isFailure(verdict("error"), opts("error")), true);
  assert.equal(isFailure(verdict("warning"), opts("error")), false);
});

test("--fail-on warning makes warnings fail too", () => {
  assert.equal(isFailure(verdict("warning"), opts("warning")), true);
  assert.equal(isFailure(verdict("error"), opts("warning")), true);
});

test("--fail-on none never fails on severity", () => {
  assert.equal(isFailure(verdict("error"), opts("none")), false);
  const s = summarize([verdict("error"), verdict("warning")], opts("none"));
  assert.equal(s.failures.length, 0);
});

test("summary counts errors and warnings among shown findings", () => {
  const s = summarize([verdict("error"), verdict("warning"), verdict("warning")], opts("error"));
  assert.equal(s.errors, 1);
  assert.equal(s.warnings, 2);
});
