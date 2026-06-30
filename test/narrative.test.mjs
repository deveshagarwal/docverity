import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSections, checkSelfCount, checkNarrative } from "../dist/narrative.js";

function docRepo(readme) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docverity-narr-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(
    path.join(dir, "src", "cli.ts"),
    'program.command("run");\nfunction a(){} function b(){} function c(){}\n',
  );
  writeFileSync(path.join(dir, "README.md"), readme);
  return dir;
}

test("parseSections splits on headings and counts the first list", () => {
  const secs = parseSections("# T\n\nintro\n\n## Steps\n\nruns three things:\n\n- a\n- b\n- c\n");
  const steps = secs.find((s) => s.heading === "Steps");
  assert.ok(steps);
  assert.equal(steps.listCount, 3);
});

test("self-count flags a stated number that disagrees with the list", () => {
  const dir = docRepo("# T\n\n## Checks\n\nRuns three checks:\n\n- one\n- two\n- three\n- four\n");
  const v = checkSelfCount(dir, "README.md");
  assert.equal(v.length, 1);
  assert.equal(v[0].engine, "narrative");
  assert.equal(v[0].severity, "warning");
  assert.match(v[0].explanation, /three.*but the list under it has 4/);
});

test("self-count stays silent when the count matches", () => {
  const dir = docRepo("# T\n\n## Checks\n\nRuns three checks:\n\n- one\n- two\n- three\n");
  assert.deepEqual(checkSelfCount(dir, "README.md"), []);
});

test("self-count ignores numbers not introducing a list", () => {
  const dir = docRepo("# T\n\nThe default timeout is 30 seconds and the port is 8080.\n");
  assert.deepEqual(checkSelfCount(dir, "README.md"), []);
});

const sampler = (reply) => async () => reply;

test("narrative pass maps model findings to section verdicts", async () => {
  const dir = docRepo("# T\n\n## How it works\n\n1. parse\n2. report\n");
  const reply = JSON.stringify({
    findings: [
      { heading: "How it works", missing: "the run command", evidence: "src/cli.ts:1", reason: "omits a step" },
    ],
  });
  const v = await checkNarrative(dir, ["README.md"], sampler(reply));
  assert.equal(v.length, 1);
  assert.equal(v[0].claim.kind, "section");
  assert.equal(v[0].engine, "narrative");
  assert.match(v[0].claim.text, /How it works.*omits/);
});

test("narrative pass ignores findings for unknown headings", async () => {
  const dir = docRepo("# T\n\n## How it works\n\n1. parse\n2. report\n");
  const reply = JSON.stringify({ findings: [{ heading: "Nonexistent", missing: "x" }] });
  assert.deepEqual(await checkNarrative(dir, ["README.md"], sampler(reply)), []);
});

test("narrative pass survives unparseable output", async () => {
  const dir = docRepo("# T\n\n## How it works\n\n1. parse\n2. report\n");
  assert.deepEqual(await checkNarrative(dir, ["README.md"], sampler("nope")), []);
});
