import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { enrichWithGitHistory, isGitRepo, lastDocChange } from "../dist/git.js";
import { findUndocumented } from "../dist/coverage.js";

function git(dir, args, date) {
  const env = { ...process.env };
  if (date) {
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_DATE = date;
  }
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

// Build a repo where one undocumented var predates the last doc change and
// another was added after it.
function historyRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docverity-git-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  mkdirSync(path.join(dir, "src"));

  // Commit 1 (Jan): code already reads OLD_VAR.
  writeFileSync(path.join(dir, "src", "app.ts"), "const a = process.env.OLD_VAR;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "old"], "2020-01-01T00:00:00");

  // Commit 2 (Mar): the docs are written. This is the baseline.
  writeFileSync(path.join(dir, "README.md"), "# tool\nNothing documented here.\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "docs"], "2020-03-01T00:00:00");

  // Commit 3 (Jun): code starts reading NEW_VAR, after the docs.
  writeFileSync(
    path.join(dir, "src", "app.ts"),
    "const a = process.env.OLD_VAR;\nconst b = process.env.NEW_VAR;\n",
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "new"], "2020-06-01T00:00:00");
  return dir;
}

test("detects a git repo and the last doc change", () => {
  const dir = historyRepo();
  assert.equal(isGitRepo(dir), true);
  const base = lastDocChange(dir, ["README.md"]);
  assert.ok(base);
  assert.equal(base.date, "2020-03-01");
});

test("elevates undocumented surface added after the docs, not before", () => {
  const dir = historyRepo();
  const coverage = findUndocumented(dir, ["README.md"]);
  const { verdicts, commitsSince } = enrichWithGitHistory(dir, coverage, ["README.md"]);
  assert.equal(commitsSince, 1, "one commit after the doc baseline");

  const neu = verdicts.find((v) => v.claim.text === "NEW_VAR");
  const old = verdicts.find((v) => v.claim.text === "OLD_VAR");
  assert.ok(neu && old, "both vars are undocumented");

  assert.match(neu.explanation, /added after the docs were last updated \(2020-03-01\)/);
  assert.ok(neu.confidence >= 0.85, "newer finding is elevated");

  assert.doesNotMatch(old.explanation, /added after the docs/);
  assert.equal(old.confidence, 0.75, "older finding is untouched");
});

test("non-git directories degrade silently", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docverity-nogit-"));
  writeFileSync(path.join(dir, "README.md"), "# t\n");
  assert.equal(isGitRepo(dir), false);
  const res = enrichWithGitHistory(dir, [], ["README.md"]);
  assert.deepEqual(res, { verdicts: [], baseline: null, commitsSince: 0 });
});
