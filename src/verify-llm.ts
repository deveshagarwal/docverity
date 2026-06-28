import { readFileSync } from "node:fs";
import path from "node:path";
import type { Claim, Evidence, Verdict, Status } from "./types.js";
import { searchLiteral } from "./search.js";
import { structuredCall } from "./llm.js";

const EXTRACT_SYSTEM = `You extract verifiable factual claims that a documentation file makes about a software codebase.

A claim is a specific, checkable assertion: a default value, a return type, a parameter name, a config key, an install step, a behavior ("by default X happens"), an output shape. Ignore marketing copy, aspirational statements, and anything not checkable against source code.

For each claim, provide search terms (identifiers, strings, file names) that would help locate the relevant code. Be precise; prefer fewer high-quality claims over many vague ones.`;

const VERIFY_SYSTEM = `You verify whether documentation claims still match the codebase, given source-code evidence.

For each claim, decide:
- "ok": the evidence confirms the claim is still true.
- "drifted": the evidence contradicts the claim (the docs are now wrong).
- "unverifiable": the evidence is insufficient to decide.

Be conservative. Only mark "drifted" when the evidence clearly contradicts the claim. When unsure, choose "unverifiable". A false "drifted" verdict is worse than a missed one. Give the specific contradiction and, when drifted, a concrete suggested doc fix.`;

interface RawProseClaim {
  line: number;
  text: string;
  assertion: string;
  searchHints: string[];
}

interface RawVerdict {
  id: string;
  status: Status;
  confidence: number;
  explanation: string;
  suggestedFix?: string;
}

const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          line: { type: "integer" },
          text: { type: "string" },
          assertion: { type: "string" },
          searchHints: { type: "array", items: { type: "string" } },
        },
        required: ["line", "text", "assertion", "searchHints"],
      },
    },
  },
  required: ["claims"],
};

const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["ok", "drifted", "unverifiable"] },
          confidence: { type: "number" },
          explanation: { type: "string" },
          suggestedFix: { type: "string" },
        },
        required: ["id", "status", "confidence", "explanation"],
      },
    },
  },
  required: ["verdicts"],
};

/** LLM engine: extract prose claims from a doc and verify them against the code. */
export async function verifyLlm(
  root: string,
  docFile: string,
  model: string,
): Promise<Verdict[]> {
  const abs = path.isAbsolute(docFile) ? docFile : path.join(root, docFile);
  const rel = path.relative(root, abs);
  const docText = readFileSync(abs, "utf8");
  const numbered = docText
    .split("\n")
    .map((l, i) => `${i + 1}: ${l}`)
    .join("\n");

  const { claims: raw } = await structuredCall<{ claims: RawProseClaim[] }>(
    model,
    EXTRACT_SYSTEM,
    `Documentation file: ${rel}\n\n${numbered}`,
    EXTRACT_SCHEMA,
  );
  if (!raw.length) return [];

  const claims: Claim[] = raw.map((c, i) => ({
    id: `${rel}~${i + 1}`,
    docFile: rel,
    line: c.line,
    kind: "prose",
    text: c.text,
    assertion: c.assertion,
    searchHints: c.searchHints,
  }));

  // Gather evidence for each claim from the source tree.
  const evidenceByClaim = new Map<string, Evidence[]>();
  for (const claim of claims) {
    const found: Evidence[] = [];
    for (const hint of claim.searchHints.slice(0, 4)) {
      found.push(...(await searchLiteral(root, hint, 4)));
    }
    evidenceByClaim.set(claim.id, dedupeEvidence(found).slice(0, 8));
  }

  const verifyPayload = claims.map((c) => ({
    id: c.id,
    claim: c.assertion,
    docText: c.text,
    evidence: evidenceByClaim.get(c.id) ?? [],
  }));

  const { verdicts: rawVerdicts } = await structuredCall<{ verdicts: RawVerdict[] }>(
    model,
    VERIFY_SYSTEM,
    `Verify these claims against the evidence:\n\n${JSON.stringify(verifyPayload, null, 2)}`,
    VERIFY_SCHEMA,
  );

  const byId = new Map(claims.map((c) => [c.id, c]));
  const out: Verdict[] = [];
  for (const v of rawVerdicts) {
    const claim = byId.get(v.id);
    if (!claim) continue;
    out.push({
      claim,
      status: v.status,
      confidence: v.confidence,
      explanation: v.explanation,
      suggestedFix: v.suggestedFix,
      evidence: evidenceByClaim.get(v.id) ?? [],
      engine: "llm",
    });
  }
  return out;
}

function dedupeEvidence(items: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const e of items) {
    const key = `${e.file}:${e.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
