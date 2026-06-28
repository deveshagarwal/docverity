// Core data model for DocDrift.
//
// A "claim" is one checkable assertion that a documentation file makes about
// the codebase. The pipeline is: extract claims -> locate evidence in the
// repo -> verify each claim against that evidence -> report.

export type ClaimKind =
  | "file" // references a file or directory path
  | "flag" // references a CLI flag, e.g. --json
  | "env" // references an environment variable, e.g. API_KEY
  | "symbol" // references a function/class/identifier in code
  | "command" // a shell command shown in a code block
  | "prose"; // a free-text assertion (verified only by the LLM engine)

export interface Claim {
  /** Stable id, used to dedupe and reference in output. */
  id: string;
  /** The documentation file this came from. */
  docFile: string;
  /** 1-based line number in the doc where the claim appears. */
  line: number;
  kind: ClaimKind;
  /** The literal token or sentence asserted, e.g. "--json" or "src/index.ts". */
  text: string;
  /** Human-readable description of what is being asserted. */
  assertion: string;
  /** Terms to search the codebase for when locating evidence. */
  searchHints: string[];
}

export interface Evidence {
  file: string;
  line: number;
  /** The matching source line, trimmed. */
  snippet: string;
}

export type Status = "ok" | "drifted" | "unverifiable";

export interface Verdict {
  claim: Claim;
  status: Status;
  /** 0..1 confidence in the verdict. */
  confidence: number;
  /** The specific reason, e.g. "no occurrence of --json in the codebase". */
  explanation: string;
  /** Supporting evidence considered. */
  evidence: Evidence[];
  /** Optional suggested doc fix (LLM engine only). */
  suggestedFix?: string;
  /** Which engine produced this verdict. */
  engine: "reference" | "llm";
}

export interface CheckOptions {
  /** Repo root to analyze. */
  root: string;
  /** Glob-ish list of doc files (resolved before this point). */
  docFiles: string[];
  /** Run the LLM claim verifier (requires ANTHROPIC_API_KEY). */
  useLlm: boolean;
  /** Model id for the LLM engine. */
  model: string;
  /** Minimum confidence to count a "drifted" verdict as a failure. */
  failConfidence: number;
  /** Treat "unverifiable" as failures too. */
  strict: boolean;
}
