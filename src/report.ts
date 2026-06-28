import kleur from "kleur";
import type { Verdict, CheckOptions } from "./types.js";

export interface Summary {
  ok: number;
  drifted: number;
  unverifiable: number;
  failures: Verdict[];
}

export function summarize(verdicts: Verdict[], opts: CheckOptions): Summary {
  let ok = 0;
  let drifted = 0;
  let unverifiable = 0;
  const failures: Verdict[] = [];

  for (const v of verdicts) {
    if (v.status === "ok") ok++;
    else if (v.status === "drifted") {
      drifted++;
      if (v.confidence >= opts.failConfidence) failures.push(v);
    } else {
      unverifiable++;
      if (opts.strict) failures.push(v);
    }
  }
  return { ok, drifted, unverifiable, failures };
}

/** Pretty terminal report. Returns true if the check should fail the build. */
export function printReport(verdicts: Verdict[], opts: CheckOptions): boolean {
  const summary = summarize(verdicts, opts);

  const drifts = verdicts
    .filter((v) => v.status === "drifted" && v.confidence >= opts.failConfidence)
    .sort((a, b) => b.confidence - a.confidence);

  if (drifts.length === 0) {
    console.log(
      kleur.green(`\n✓ No doc drift detected.`) +
        kleur.dim(
          ` (${summary.ok} claims verified, ${summary.unverifiable} unverifiable)\n`,
        ),
    );
    return opts.strict && summary.failures.length > 0;
  }

  console.log(
    kleur.bold().red(`\n✗ ${drifts.length} doc claim(s) drifted from the code:\n`),
  );

  for (const v of drifts) {
    const loc = kleur.cyan(`${v.claim.docFile}:${v.claim.line}`);
    const tag = kleur.dim(`[${v.engine}]`);
    const conf = kleur.dim(`${Math.round(v.confidence * 100)}%`);
    console.log(`  ${kleur.red("●")} ${loc} ${tag} ${conf}`);
    console.log(`    ${kleur.bold(v.claim.text)}`);
    console.log(`    ${v.explanation}`);
    if (v.suggestedFix) {
      console.log(`    ${kleur.yellow("fix:")} ${kleur.dim(v.suggestedFix)}`);
    }
    if (v.evidence.length) {
      const e = v.evidence[0];
      console.log(kleur.dim(`    seen: ${e.file}:${e.line}  ${e.snippet}`));
    }
    console.log();
  }

  console.log(
    kleur.dim(
      `${summary.ok} ok · ${summary.drifted} drifted · ${summary.unverifiable} unverifiable\n`,
    ),
  );
  return true;
}

/** GitHub Actions workflow-command annotations. */
export function printGithubAnnotations(verdicts: Verdict[], opts: CheckOptions): void {
  for (const v of verdicts) {
    if (v.status !== "drifted" || v.confidence < opts.failConfidence) continue;
    const msg = `${v.claim.text} — ${v.explanation}`.replace(/\n/g, " ");
    console.log(
      `::error file=${v.claim.docFile},line=${v.claim.line}::doc drift: ${msg}`,
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
        unverifiable: summary.unverifiable,
        failed: summary.failures.length,
      },
      verdicts: verdicts.map((v) => ({
        doc: v.claim.docFile,
        line: v.claim.line,
        kind: v.claim.kind,
        text: v.claim.text,
        status: v.status,
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
