// Suggestion layer: docverity as a doc *author*, not just a detector. It reads
// what the code exposes and drafts the documentation to cover it: real markdown
// you can drop in, grounded in a deterministic scan of the undocumented surface
// so nothing is missed, and in the entry-point source so the prose is accurate.
//
// Default output prints the drafted improvements; `--write` appends them to a
// doc file inside replaceable markers so the change is additive and reviewable.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Sampler } from "./adjudicate.js";
import { extractJson } from "./adjudicate.js";
import { findUndocumented } from "./coverage.js";
import { entrySourceBlob } from "./coverage-llm.js";
import { allDocText } from "./coverage.js";

export interface Suggestion {
  title: string;
  action: "add" | "revise";
  target: string; // file and/or section the change belongs in
  markdown: string; // the drafted documentation
  why: string;
}

const SYSTEM = `You improve a software project's documentation so it covers everything the code exposes to users.

You are given the existing documentation, the project's entry-point source, and a deterministic list of undocumented surface (flags, env vars, subcommands, option values) found by a scanner.

Produce concrete documentation improvements:
- "add": drafted markdown for user-facing surface or behavior the docs do not yet cover (every item in the undocumented list must be covered, plus any user-facing behavior you can see in the code that the docs omit).
- "revise": a corrected/expanded version of an existing section that is incomplete or no longer matches the code.

For each suggestion give the EXACT markdown to use, accurate to the code. Describe what each thing does based on how the code uses it. Do NOT invent flags, options, or behavior that the code does not show. Group related items into one coherent section rather than one suggestion per token. Keep the project's existing tone.

Return STRICT JSON only:
{"suggestions":[{"title":"short label","action":"add"|"revise","target":"file and/or section it belongs in","markdown":"the documentation to add or the revised section","why":"one sentence"}]}`;

const MAX_SUGGESTIONS = 25;
const START = "<!-- docverity:suggestions:start -->";
const END = "<!-- docverity:suggestions:end -->";

function undocumentedHints(root: string, docFiles: string[]): string {
  let gaps: { kind: string; text: string }[] = [];
  try {
    gaps = findUndocumented(root, docFiles).map((v) => ({
      kind: v.claim.kind,
      text: v.claim.text,
    }));
  } catch {
    /* best-effort */
  }
  if (!gaps.length) return "(none detected deterministically)";
  return gaps.map((g) => `- ${g.text} (${g.kind})`).join("\n");
}

/** Draft documentation improvements. Needs a model; returns [] if it can't. */
export async function runSuggest(
  root: string,
  docFiles: string[],
  sample: Sampler,
): Promise<Suggestion[]> {
  const sourceBlob = entrySourceBlob(root);
  if (!sourceBlob) return [];
  const docs = allDocText(root).slice(0, 60_000);
  const hints = undocumentedHints(root, docFiles);

  const user = `EXISTING DOCUMENTATION:\n${docs || "(none)"}\n\n---\nUNDOCUMENTED SURFACE (deterministic scan):\n${hints}\n\n---\nENTRY-POINT SOURCE:\n${sourceBlob}`;

  let raw: string;
  try {
    raw = await sample(SYSTEM, user);
  } catch {
    return [];
  }
  let parsed: any;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return [];
  }

  const items = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  const out: Suggestion[] = [];
  for (const s of items.slice(0, MAX_SUGGESTIONS)) {
    if (!s || typeof s.markdown !== "string" || !s.markdown.trim()) continue;
    out.push({
      title: String(s.title ?? "Documentation").trim(),
      action: s.action === "revise" ? "revise" : "add",
      target: String(s.target ?? "").trim(),
      markdown: s.markdown.trim(),
      why: String(s.why ?? "").trim(),
    });
  }
  return out;
}

/** A markdown block bundling the suggestions, for printing or writing. */
export function renderSuggestionsBlock(suggestions: Suggestion[]): string {
  const parts = suggestions.map((s) => {
    const head = `### ${s.title} [${s.action}]`;
    const meta = [s.target && `Where: ${s.target}`, s.why].filter(Boolean).join(". ");
    return `${head}${meta ? `\n_${meta}_\n` : ""}\n${s.markdown}\n`;
  });
  return parts.join("\n");
}

/**
 * Insert the suggestions into a doc file between replaceable markers. Additive:
 * existing prose is never overwritten, and re-running replaces the prior block
 * rather than stacking. Returns the file written.
 */
export function writeSuggestions(
  root: string,
  file: string,
  suggestions: Suggestion[],
): string {
  const full = path.join(root, file);
  let existing = "";
  try {
    existing = readFileSync(full, "utf8");
  } catch {
    /* new file */
  }

  const body = renderSuggestionsBlock(suggestions);
  const block = `${START}\n## Suggested documentation (docverity)\n\nDrafted from the code. Review, edit, and move into place; then delete these markers.\n\n${body}\n${END}`;

  let next: string;
  const startIdx = existing.indexOf(START);
  const endIdx = existing.indexOf(END);
  if (startIdx >= 0 && endIdx > startIdx) {
    next = existing.slice(0, startIdx) + block + existing.slice(endIdx + END.length);
  } else {
    next = existing.replace(/\s*$/, "") + `\n\n${block}\n`;
  }
  writeFileSync(full, next, "utf8");
  return file;
}
