import type { Severity, ClaimKind, Status } from "./types.js";

const RANK: Record<Severity | "none", number> = {
  info: 1,
  warning: 2,
  error: 3,
  none: 99,
};

export function severityRank(s: Severity | "none"): number {
  return RANK[s] ?? RANK.error;
}

/** Does this severity meet or exceed the build's fail threshold? */
export function meetsFailThreshold(s: Severity, failOn: Severity | "none"): boolean {
  return severityRank(s) >= severityRank(failOn);
}

/**
 * Default severity for a drifted reference-engine claim. Things a reader
 * actively types or runs (flags, env vars, commands) are errors; navigational
 * references (a stale path or symbol mention) are warnings.
 */
export function driftSeverity(kind: ClaimKind): Severity {
  switch (kind) {
    case "flag":
    case "env":
    case "command":
      return "error";
    case "file":
    case "symbol":
      return "warning";
    default:
      return "error";
  }
}

/** Severity for a verdict status when an engine has not assigned one. */
export function defaultSeverity(status: Status, kind: ClaimKind): Severity {
  if (status === "drifted") return driftSeverity(kind);
  if (status === "undocumented") return "warning";
  if (status === "unverifiable") return "info";
  return "info";
}
