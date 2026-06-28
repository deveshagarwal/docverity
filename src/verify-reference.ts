import type { Claim, Verdict } from "./types.js";
import { searchLiteral, fileExists } from "./search.js";

/**
 * The deterministic engine: verify each claim by looking for hard evidence in
 * the source tree. No model, no API key. High precision by design — when in
 * doubt it returns "unverifiable" rather than "drifted".
 */
export async function verifyReference(root: string, claims: Claim[]): Promise<Verdict[]> {
  const verdicts: Verdict[] = [];

  for (const claim of claims) {
    verdicts.push(await verifyOne(root, claim));
  }
  return verdicts;
}

async function verifyOne(root: string, claim: Claim): Promise<Verdict> {
  const base = { claim, evidence: [], engine: "reference" as const };

  switch (claim.kind) {
    case "file": {
      const exists = fileExists(root, claim.text);
      return exists
        ? {
            ...base,
            status: "ok",
            confidence: 0.95,
            explanation: `${claim.text} exists on disk.`,
          }
        : {
            ...base,
            status: "drifted",
            confidence: 0.9,
            explanation: `The docs reference ${claim.text}, but no such file or directory exists.`,
            suggestedFix: `Update or remove the reference to ${claim.text}.`,
          };
    }

    case "flag":
    case "env":
    case "symbol": {
      const hits = await searchLiteral(root, claim.text);
      if (hits.length > 0) {
        return {
          ...base,
          status: "ok",
          confidence: 0.8,
          explanation: `Found ${hits.length} occurrence(s) of ${claim.text} in the source.`,
          evidence: hits.slice(0, 3),
        };
      }
      const noun =
        claim.kind === "flag"
          ? "CLI flag"
          : claim.kind === "env"
            ? "environment variable"
            : "symbol";
      return {
        ...base,
        status: "drifted",
        confidence: claim.kind === "symbol" ? 0.6 : 0.8,
        explanation: `The docs mention the ${noun} ${claim.text}, but it does not appear anywhere in the source.`,
        suggestedFix: `Verify ${claim.text} still exists; it may have been renamed or removed.`,
      };
    }

    default:
      return {
        ...base,
        status: "unverifiable",
        confidence: 0.3,
        explanation: `Prose claim — needs the LLM engine to verify.`,
      };
  }
}
