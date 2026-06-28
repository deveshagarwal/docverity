import type { Claim, Verdict } from "./types.js";
import { searchToken, fileExists } from "./search.js";
import { driftSeverity } from "./severity.js";

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
      if (fileExists(root, claim.text)) {
        return {
          ...base,
          status: "ok",
          severity: "info",
          confidence: 0.95,
          explanation: `${claim.text} exists on disk.`,
        };
      }
      // A bare filename with no path separator is often a library or framework
      // name in code formatting (Node.js, config.js), not a repo file. Don't
      // assert drift on those; downgrade to unverifiable.
      if (!claim.text.includes("/")) {
        return {
          ...base,
          status: "unverifiable",
          severity: "info",
          confidence: 0.3,
          explanation: `${claim.text} is not a file in the repo; it may be a library or framework name rather than a path.`,
        };
      }
      return {
        ...base,
        status: "drifted",
        severity: driftSeverity("file"),
        confidence: 0.9,
        explanation: `The docs reference ${claim.text}, but no such file or directory exists.`,
        suggestedFix: `Update or remove the reference to ${claim.text}.`,
      };
    }

    case "flag":
    case "env":
    case "symbol": {
      const mode = claim.kind === "flag" ? "flag" : "word";
      const hits = await searchToken(root, claim.text, mode);
      if (hits.length > 0) {
        return {
          ...base,
          status: "ok",
          severity: "info",
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
      // Boundary-aware search (below) means a hit is a real, whole-token match,
      // so a miss is trustworthy enough to fail CI on, symbols included.
      return {
        ...base,
        status: "drifted",
        severity: driftSeverity(claim.kind),
        confidence: 0.8,
        explanation: `The docs mention the ${noun} ${claim.text}, but it does not appear anywhere in the source.`,
        suggestedFix: `Verify ${claim.text} still exists; it may have been renamed or removed.`,
      };
    }

    default:
      return {
        ...base,
        status: "unverifiable",
        severity: "info",
        confidence: 0.3,
        explanation: `Prose claim — needs the LLM engine to verify.`,
      };
  }
}
