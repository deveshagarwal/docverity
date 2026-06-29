// Host-LLM adjudication. The deterministic engine is a fast, high-recall but
// noisy scanner. When docverity runs inside an agent/MCP host that supports
// sampling, we hand each candidate finding (with its documentation context)
// back to the *caller's* model to decide whether it is a real problem — no API
// key of our own, and the judgement understands examples, removals, and
// third-party references that a token matcher cannot.

export type Sampler = (system: string, user: string) => Promise<string>;

export interface Candidate {
  id: string;
  kind: string;
  text: string;
  status: "drifted" | "undocumented";
  location: string; // file:line
  context: string; // surrounding doc/code lines
  note: string; // the deterministic explanation
}

export interface Adjudication {
  real: boolean;
  reason: string;
}

const SYSTEM = `You verify software documentation against code. A fast deterministic scanner flagged candidate problems by matching tokens (flags, env vars, paths, symbols); it is prone to false alarms. For each candidate, using the provided documentation/code context, decide whether it is a REAL documentation problem.

Mark realProblem=false (a false alarm) when the token is any of:
- an illustrative EXAMPLE — a variable, label, constant, sample flag, or placeholder in a code snippet or teaching prose ("options like --foo", a loop label OUTER_LOOP, an example env MY_VAR / API_KEY);
- documented as REMOVED, DEPRECATED, or "no longer supported" — migration guides, changelogs, and upgrade notes legitimately name things that are gone;
- ANOTHER tool's flag or variable (git, npm, node, tsc, docker, …), not the documented project's own;
- a STANDARD or runtime env var the project handles via a library or the platform (NO_COLOR, FORCE_COLOR, NODE_OPTIONS, NODE_DISABLE_COLORS);
- constructed DYNAMICALLY in code (e.g. \`PREFIX_\${name}\`) so the literal token never appears.

Mark realProblem=true ONLY when the documentation asserts the PROJECT'S OWN current flag/option/env/path/symbol or behavior, and the evidence shows it is missing, renamed, or different. When unsure, mark realProblem=false — favour precision over recall.

Return STRICT JSON only: {"verdicts":[{"id":"...","realProblem":true|false,"reason":"..."}]}`;

/** Pull the first balanced JSON object out of a model response. */
function extractJson(text: string): string {
  const start = text.indexOf("{");
  if (start < 0) return text;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/**
 * Ask the caller's model to adjudicate candidates. Returns a map id ->
 * {real, reason}. On any failure returns an empty map (caller keeps the
 * deterministic verdicts unchanged).
 */
export async function adjudicate(
  candidates: Candidate[],
  sample: Sampler,
): Promise<Map<string, Adjudication>> {
  const out = new Map<string, Adjudication>();
  if (!candidates.length) return out;

  const user =
    "Adjudicate each candidate documentation problem:\n\n" +
    JSON.stringify(candidates, null, 2);

  let text: string;
  try {
    text = await sample(SYSTEM, user);
  } catch {
    return out; // sampling unavailable/failed: caller falls back to deterministic
  }

  let parsed: any;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    return out;
  }
  for (const v of parsed?.verdicts ?? []) {
    if (v && typeof v.id === "string") {
      out.set(v.id, { real: Boolean(v.realProblem), reason: String(v.reason ?? "") });
    }
  }
  return out;
}
