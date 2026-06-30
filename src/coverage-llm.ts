// LLM capability coverage (code -> docs, the behavioral direction).
//
// The deterministic coverage engine only sees tokens it has a pattern for
// (flags, env vars, subcommands, choice values). It is blind to *behaviors*:
// a new mode, an output format, an integration surface, a changed default. A
// whole feature can ship undocumented and the token scanner stays green.
//
// This pass hands the caller's model the docs and the project's entry-point
// source and asks the one question a token matcher cannot: what can a user do
// with this code that the documentation never tells them about? It runs only
// when a model is reachable (our key, the `claude` CLI, or an MCP host) and
// reports warnings — never build failures.

import type { Verdict } from "./types.js";
import { type Sampler, extractJson } from "./adjudicate.js";
import { readSourceFiles } from "./search.js";
import { allDocText, looksLikeCliFile, inSkippedDir } from "./coverage.js";

const SYSTEM = `You audit whether a project's DOCUMENTATION describes everything its CODE exposes to users. You are given the docs and the project's entry-point source.

List user-facing CAPABILITIES the code provides that the docs never describe: subcommands, modes, output formats, flags' behaviors, integration surfaces (e.g. an MCP server, a plugin API), notable defaults, or distinct features. These are gaps a user would want documented.

Rules:
- Only USER-FACING capabilities. Ignore internal helpers, refactors, type definitions, tests, and implementation detail.
- If the docs describe it in ANY words, it is documented — do not nitpick wording or completeness.
- Each item must be grounded in the provided source; give "file:line" evidence.
- Be conservative. When unsure whether something is user-facing or already documented, OMIT it. Favour precision over recall; a short, certain list is the goal.

Return STRICT JSON only: {"undocumented":[{"capability":"short name","evidence":"file:line","reason":"one sentence: what it does and that the docs omit it"}]}`;

const DOC_BUDGET = 60_000;
const FILE_BUDGET = 60_000;
const PER_FILE_CAP = 12_000;
const MAX_FILES = 6;
const MAX_FINDINGS = 12;

/** Gather the project's entry-point source as `=== path ===\n<slice>` blocks,
 * capped, for grounding the model. Shared by the capability and narrative passes. */
export function entrySourceBlob(root: string): string {
  const picked: { file: string; slice: string }[] = [];
  let budget = FILE_BUDGET;
  for (const { file, content } of readSourceFiles(root)) {
    if (picked.length >= MAX_FILES || budget <= 0) break;
    if (!isEntryFile(file, content)) continue;
    const slice = content.slice(0, PER_FILE_CAP);
    picked.push({ file, slice });
    budget -= slice.length;
  }
  return picked.map((f) => `=== ${f.file} ===\n${f.slice}`).join("\n\n");
}

function isEntryFile(file: string, content: string): boolean {
  if (inSkippedDir(file)) return false;
  if (
    /(^|[\\/])(cli|main|__main__|index|app|server|mcp|bin|cmd|root|commands?)\.[cm]?[jt]sx?$/i.test(
      file,
    ) ||
    /(^|[\\/])(cli|main|__main__|app|server)\.(py|go|rb)$/i.test(file)
  ) {
    return true;
  }
  return looksLikeCliFile(content);
}

/**
 * Ask the caller's model which user-facing capabilities the code exposes that
 * the docs never describe. Returns warning verdicts (kind "capability"). On any
 * failure (no sampler result, no entry files, unparseable JSON) returns [].
 */
export async function findUndocumentedCapabilities(
  root: string,
  sample: Sampler,
): Promise<Verdict[]> {
  const docs = allDocText(root).slice(0, DOC_BUDGET);
  if (!docs.trim()) return [];

  const sourceBlob = entrySourceBlob(root);
  if (!sourceBlob) return [];

  const fallbackFile = sourceBlob.split("\n", 1)[0].replace(/^=== | ===$/g, "");
  const user = `DOCUMENTATION:\n${docs}\n\n---\nENTRY-POINT SOURCE:\n${sourceBlob}`;

  let text: string;
  try {
    text = await sample(SYSTEM, user);
  } catch {
    return [];
  }

  let parsed: any;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    return [];
  }

  const items = Array.isArray(parsed?.undocumented) ? parsed.undocumented : [];
  const verdicts: Verdict[] = [];
  const seen = new Set<string>();
  for (const it of items.slice(0, MAX_FINDINGS)) {
    if (!it || typeof it.capability !== "string") continue;
    const cap = it.capability.trim();
    if (!cap || seen.has(cap.toLowerCase())) continue;
    seen.add(cap.toLowerCase());

    const ev = typeof it.evidence === "string" ? it.evidence : "";
    const [evFile, evLine] = ev.split(":");
    const file = evFile?.trim() || fallbackFile;
    const line = Number(evLine) || 1;

    verdicts.push({
      claim: {
        id: `coverage-llm:${cap}`,
        docFile: file,
        line,
        kind: "capability",
        text: cap,
        assertion: `${cap} is documented`,
        searchHints: [cap],
      },
      status: "undocumented",
      severity: "warning",
      confidence: 0.7,
      explanation:
        typeof it.reason === "string" && it.reason.trim()
          ? it.reason.trim()
          : `The code provides "${cap}", but the documentation does not describe it.`,
      suggestedFix: `Document "${cap}" in the README or docs, or confirm it is intentionally internal.`,
      evidence: [{ file, line, snippet: "" }],
      engine: "coverage-llm",
    });
  }
  return verdicts;
}
