// Git-aware staleness. The coverage engine asks "is this in the docs?"; git
// answers the sharper question "did this change *after* the docs last did?".
//
// A flag or env var the code added two commits after the README was last
// touched is a much stronger "you forgot to document this" signal than a bare
// token absence (which might be intentionally internal). We find the last
// commit that modified any doc file, then mark undocumented findings whose token
// appears in the code added since that point. All best-effort: no git, a shallow
// clone, or any failed command degrades silently to the plain coverage result.

import { spawnSync } from "node:child_process";
import type { Verdict } from "./types.js";

function git(root: string, args: string[]): string | null {
  try {
    const r = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) return null;
    return r.stdout;
  } catch {
    return null;
  }
}

export function isGitRepo(root: string): boolean {
  return git(root, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

export interface DocBaseline {
  sha: string; // last commit that touched a doc file
  date: string; // its commit date, YYYY-MM-DD
}

/** The most recent commit that modified any of the checked doc files. */
export function lastDocChange(root: string, docFiles: string[]): DocBaseline | null {
  if (!docFiles.length) return null;
  const out = git(root, ["log", "-1", "--format=%H|%cs", "--", ...docFiles]);
  const line = out?.trim();
  if (!line) return null;
  const [sha, date] = line.split("|");
  return sha ? { sha, date: date ?? "" } : null;
}

/** How many commits landed on the repo since the doc baseline. */
export function commitsSince(root: string, sha: string): number {
  const n = Number(git(root, ["rev-list", "--count", `${sha}..HEAD`])?.trim());
  return Number.isFinite(n) ? n : 0;
}

/** The lines of code added between the doc baseline and HEAD, docs excluded. */
function addedSinceDocs(root: string, sha: string, docFiles: string[]): string {
  const excludes = docFiles.map((d) => `:(exclude)${d}`);
  const out = git(root, ["diff", "--unified=0", `${sha}..HEAD`, "--", ".", ...excludes]);
  if (!out) return "";
  return out
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n");
}

export interface GitStaleness {
  verdicts: Verdict[];
  baseline: DocBaseline | null;
  commitsSince: number;
}

/**
 * Enrich coverage findings with git history: any undocumented token that the
 * code added *after* the docs were last updated gets a higher confidence and an
 * explanation that says when. Returns the (possibly unchanged) verdicts plus the
 * baseline and commit count for a staleness headline. Never throws.
 */
export function enrichWithGitHistory(
  root: string,
  verdicts: Verdict[],
  docFiles: string[],
): GitStaleness {
  if (!isGitRepo(root)) return { verdicts, baseline: null, commitsSince: 0 };
  const baseline = lastDocChange(root, docFiles);
  if (!baseline) return { verdicts, baseline: null, commitsSince: 0 };

  const since = commitsSince(root, baseline.sha);
  if (since === 0) return { verdicts, baseline, commitsSince: 0 };

  const added = addedSinceDocs(root, baseline.sha, docFiles);
  const enriched = verdicts.map((v) => {
    if (
      v.status === "undocumented" &&
      v.engine === "coverage" &&
      added.includes(v.claim.text)
    ) {
      return {
        ...v,
        confidence: Math.max(v.confidence, 0.85),
        explanation: `${v.explanation} It was added after the docs were last updated (${baseline.date}), so it likely needs documenting.`,
      };
    }
    return v;
  });

  return { verdicts: enriched, baseline, commitsSince: since };
}
