import kleur from "kleur";
import type { Verdict, CheckOptions } from "./types.js";
import { meetsFailThreshold, severityRank } from "./severity.js";

export interface Summary {
  ok: number;
  drifted: number;
  unverifiable: number;
  undocumented: number;
  errors: number;
  warnings: number;
  failures: Verdict[];
}

/** A non-finite threshold must never silently pass all drift; fall back to 0.7. */
export function effectiveFailConfidence(opts: CheckOptions): number {
  return Number.isFinite(opts.failConfidence) ? opts.failConfidence : 0.7;
}

/** Whether a single verdict should fail the build, given confidence and severity. */
export function isFailure(v: Verdict, opts: CheckOptions): boolean {
  const failConfidence = effectiveFailConfidence(opts);
  if (v.status === "drifted" || v.status === "undocumented") {
    return v.confidence >= failConfidence && meetsFailThreshold(v.severity, opts.failOn);
  }
  if (v.status === "unverifiable") return opts.strict;
  return false;
}

/** Findings worth showing: drift and coverage gaps above the confidence floor. */
function reportable(verdicts: Verdict[], opts: CheckOptions): Verdict[] {
  const failConfidence = effectiveFailConfidence(opts);
  return verdicts
    .filter(
      (v) =>
        (v.status === "drifted" || v.status === "undocumented") &&
        v.confidence >= failConfidence,
    )
    .sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
        b.confidence - a.confidence,
    );
}

export function summarize(verdicts: Verdict[], opts: CheckOptions): Summary {
  let ok = 0;
  let drifted = 0;
  let unverifiable = 0;
  let undocumented = 0;
  const failures: Verdict[] = [];
  for (const v of verdicts) {
    if (v.status === "ok") ok++;
    else if (v.status === "drifted") drifted++;
    else if (v.status === "undocumented") undocumented++;
    else unverifiable++;
    if (isFailure(v, opts)) failures.push(v);
  }
  const shown = reportable(verdicts, opts);
  return {
    ok,
    drifted,
    unverifiable,
    undocumented,
    errors: shown.filter((v) => v.severity === "error").length,
    warnings: shown.filter((v) => v.severity === "warning").length,
    failures,
  };
}

const MARK: Record<string, (s: string) => string> = {
  error: (s) => kleur.red(s),
  warning: (s) => kleur.yellow(s),
  info: (s) => kleur.dim(s),
};

/** Pretty terminal report. Returns true if the check should fail the build. */
export function printReport(verdicts: Verdict[], opts: CheckOptions): boolean {
  const summary = summarize(verdicts, opts);
  const shown = reportable(verdicts, opts);
  const failed = summary.failures.length > 0;

  if (shown.length === 0) {
    console.log(
      kleur.green(`\n✓ No documentation problems found.`) +
        kleur.dim(
          ` (${summary.ok} claims verified, ${summary.unverifiable} unverifiable)\n`,
        ),
    );
    return failed;
  }

  const head =
    summary.errors > 0
      ? kleur.bold().red(
          `\n✗ ${summary.errors} error${summary.errors === 1 ? "" : "s"}` +
            (summary.warnings ? ` and ${summary.warnings} warning${summary.warnings === 1 ? "" : "s"}` : "") +
            ` in your docs:\n`,
        )
      : kleur.bold().yellow(
          `\n⚠ ${summary.warnings} warning${summary.warnings === 1 ? "" : "s"} in your docs:\n`,
        );
  console.log(head);

  for (const v of shown) {
    const mark = (MARK[v.severity] ?? MARK.info)(v.severity === "error" ? "✗" : "⚠");
    const loc = kleur.cyan(`${v.claim.docFile}:${v.claim.line}`);
    const tag = kleur.dim(`[${v.engine}] ${Math.round(v.confidence * 100)}%`);
    console.log(`  ${mark} ${loc} ${tag}`);
    console.log(`    ${kleur.bold(v.claim.text)}`);
    console.log(`    ${v.explanation}`);
    if (v.suggestedFix) {
      console.log(`    ${kleur.yellow("fix:")} ${kleur.dim(v.suggestedFix)}`);
    }
    console.log();
  }

  console.log(
    kleur.dim(
      `${summary.ok} ok · ${summary.drifted} drifted · ${summary.undocumented} undocumented · ${summary.unverifiable} unverifiable`,
    ),
  );
  if (!failed) {
    console.log(
      kleur.dim(`warnings only: build passes (raise --fail-on to enforce)\n`),
    );
  } else {
    console.log();
  }
  return failed;
}

// GitHub workflow commands need %/CR/LF escaped in data, and additionally
// :/, escaped in property values, or the annotation truncates or mis-targets.
const escData = (s: string): string =>
  s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s: string): string =>
  escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** GitHub Actions annotations: errors as ::error, everything else as ::warning. */
export function printGithubAnnotations(verdicts: Verdict[], opts: CheckOptions): void {
  for (const v of reportable(verdicts, opts)) {
    const level = v.severity === "error" ? "error" : "warning";
    const label = v.status === "undocumented" ? "undocumented" : "doc drift";
    const msg = `${label}: ${v.claim.text}. ${v.explanation}`;
    console.log(
      `::${level} file=${escProp(v.claim.docFile)},line=${v.claim.line},title=docverity::${escData(msg)}`,
    );
  }
}

export function toJson(verdicts: Verdict[], opts: CheckOptions): string {
  const summary = summarize(verdicts, opts);
  return JSON.stringify(
    {
      summary: {
        ok: summary.ok,
        drifted: summary.drifted,
        undocumented: summary.undocumented,
        unverifiable: summary.unverifiable,
        errors: summary.errors,
        warnings: summary.warnings,
        failed: summary.failures.length,
      },
      verdicts: verdicts.map((v) => ({
        doc: v.claim.docFile,
        line: v.claim.line,
        kind: v.claim.kind,
        text: v.claim.text,
        status: v.status,
        severity: v.severity,
        confidence: v.confidence,
        engine: v.engine,
        explanation: v.explanation,
        suggestedFix: v.suggestedFix,
      })),
    },
    null,
    2,
  );
}
