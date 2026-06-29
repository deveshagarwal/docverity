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
  | "subcommand" // a CLI subcommand the program defines, e.g. `mcp`
  | "value" // an accepted option/enum value, e.g. --format github
  | "capability" // a user-facing behavior or mode (LLM coverage pass)
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
  /**
   * A weakly-asserted claim (e.g. an env var named only in inline prose, which
   * is often an example) — drift on it is a warning rather than an error.
   */
  weak?: boolean;
}

export interface Evidence {
  file: string;
  line: number;
  /** The matching source line, trimmed. */
  snippet: string;
}

export type Status =
  | "ok" // the claim is confirmed by the code
  | "drifted" // the docs say something the code contradicts
  | "unverifiable" // not enough evidence to decide
  | "undocumented"; // the code has something the docs never mention (coverage)

// How much a finding matters, independent of how confident we are it's real.
//  - error:   a reader acts on it and gets burned (wrong command/flag/env/default)
//  - warning: real but not blocking (stale path/symbol reference, a coverage gap)
//  - info:    unverifiable or trivial
export type Severity = "error" | "warning" | "info";

export interface Verdict {
  claim: Claim;
  status: Status;
  /** How much this finding matters. */
  severity: Severity;
  /** 0..1 confidence in the verdict. */
  confidence: number;
  /** The specific reason, e.g. "no occurrence of --json in the codebase". */
  explanation: string;
  /** Supporting evidence considered. */
  evidence: Evidence[];
  /** Optional suggested doc fix (LLM engine only). */
  suggestedFix?: string;
  /** Which engine produced this verdict. */
  engine: "reference" | "llm" | "coverage" | "coverage-llm";
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
  /** Also report code (flags, env vars) that the docs never mention. */
  coverage: boolean;
  /** Minimum confidence to count a "drifted" verdict as a failure. */
  failConfidence: number;
  /** Lowest severity that fails the build: error | warning | info | none. */
  failOn: Severity | "none";
  /** Treat "unverifiable" as failures too. */
  strict: boolean;
}
