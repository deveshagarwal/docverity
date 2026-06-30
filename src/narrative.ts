// Narrative drift: a doc SECTION that presents itself as an account of the
// system (a pipeline, an architecture, an enumeration of components) quietly
// stops being a faithful or complete account as the code grows. No single token
// is false and nothing is wholly undocumented, so the reference, coverage, and
// capability passes all stay green. This is the failure docverity hit on its own
// "How it works" section.
//
// Two layers, same shape as coverage:
//   - self-count consistency: deterministic, zero false positives. A section
//     that says "three checks" and then lists four contradicts itself.
//   - section faithfulness: model-backed. For sections that frame themselves as
//     a pipeline/enumeration, ask whether they omit a step the code runs.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { Verdict } from "./types.js";
import { type Sampler, extractJson } from "./adjudicate.js";
import { entrySourceBlob } from "./coverage-llm.js";

export interface Section {
  heading: string;
  line: number; // 1-based line of the heading
  body: string;
  bodyBeforeFirstList: string;
  listCount: number; // items in the first top-level list, 0 if none
}

const CARDINALS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};

/** Split a markdown doc into heading-delimited sections. */
export function parseSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let cur: { heading: string; line: number; body: string[] } | null = null;
  const flush = () => {
    if (cur) sections.push(finalizeSection(cur.heading, cur.line, cur.body));
  };
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(lines[i]);
    if (m) {
      flush();
      cur = { heading: m[2], line: i + 1, body: [] };
    } else if (cur) {
      cur.body.push(lines[i]);
    }
  }
  flush();
  return sections;
}

const isListItem = (l: string): boolean => /^\s*(?:[-*+]|\d+\.)\s+\S/.test(l);
const isTopListItem = (l: string): boolean => /^(?:[-*+]|\d+\.)\s+\S/.test(l);

function finalizeSection(heading: string, line: number, bodyLines: string[]): Section {
  // First contiguous block of top-level list items.
  let start = -1;
  let count = 0;
  for (let i = 0; i < bodyLines.length; i++) {
    if (isTopListItem(bodyLines[i])) {
      if (start < 0) start = i;
      count++;
    } else if (start >= 0 && bodyLines[i].trim() === "") {
      continue; // blank line between items is fine
    } else if (start >= 0 && !isListItem(bodyLines[i])) {
      break; // list ended
    }
  }
  const before = start < 0 ? bodyLines : bodyLines.slice(0, start);
  return {
    heading,
    line,
    body: bodyLines.join("\n"),
    bodyBeforeFirstList: before.join("\n"),
    listCount: count,
  };
}

function statedCount(section: Section): { n: number; phrase: string } | null {
  // The count claim must introduce the list: look in the heading and the prose
  // immediately before the first list item, not anywhere in the section.
  const beforeLines = section.bodyBeforeFirstList.split("\n").filter((l) => l.trim());
  const lead = beforeLines.length ? beforeLines[beforeLines.length - 1] : "";
  for (const hay of [section.heading, lead]) {
    const m = /\b(two|three|four|five|six|seven|eight|nine|[2-9])\s+([a-z][a-z-]+)/i.exec(hay);
    if (m) {
      const n = CARDINALS[m[1].toLowerCase()] ?? Number(m[1]);
      if (Number.isFinite(n)) return { n, phrase: `${m[1]} ${m[2]}` };
    }
  }
  return null;
}

/**
 * Deterministic: a section whose stated count of items disagrees with the list
 * it introduces. Pure self-contradiction, so it is reported with no model.
 */
export function checkSelfCount(root: string, docFile: string): Verdict[] {
  let text: string;
  try {
    text = readFileSync(path.join(root, docFile), "utf8");
  } catch {
    return [];
  }
  const verdicts: Verdict[] = [];
  for (const section of parseSections(text)) {
    if (section.listCount < 2) continue;
    const stated = statedCount(section);
    if (!stated || stated.n === section.listCount) continue;
    verdicts.push({
      claim: {
        id: `narrative:count:${docFile}:${section.line}`,
        docFile,
        line: section.line,
        kind: "section",
        text: stated.phrase,
        assertion: `the "${section.heading}" section lists ${stated.n} items`,
        searchHints: [],
      },
      status: "drifted",
      severity: "warning",
      confidence: 0.9,
      explanation: `The "${section.heading}" section says "${stated.phrase}" but the list under it has ${section.listCount} items.`,
      suggestedFix: `Update the count to match (${section.listCount}), or fix the list.`,
      evidence: [{ file: docFile, line: section.line, snippet: "" }],
      engine: "narrative",
    });
  }
  return verdicts;
}

// A section worth auditing against the code: one that frames itself as an
// account of how the system is built or what it does, step by step.
const DESCRIPTIVE_HEADING =
  /how\s+.*\bworks?\b|architecture|overview|\bdesign\b|pipeline|internals|under the hood|lifecycle|how it works|the\s+\w+\s+(?:checks|steps|stages|phases|passes|engines|commands)/i;

function isDescriptive(section: Section): boolean {
  // Either the heading announces a description, or the body is a sequence of
  // 3+ steps (an ordered enumeration of the system's process).
  return DESCRIPTIVE_HEADING.test(section.heading) || section.listCount >= 3;
}

const SYSTEM = `You check whether documentation SECTIONS that describe how a system works are still faithful to the code.

Each section below presents itself as an account of the system: a pipeline, an architecture, or an enumeration of components/steps. You are also given the project's entry-point source.

Find sections that MATERIALLY omit or misstate a member of the set they enumerate, so a reader relying on that section would have an incomplete or wrong picture: e.g. a numbered pipeline that lists 4 steps when the code runs 6, or a list of components that leaves one out.

Rules:
- Only MATERIAL structural omissions or contradictions in the section's OWN account. A step/component the code clearly runs that the section's enumeration leaves out.
- Ignore wording, level of detail, and style. A correct high-level summary is fine.
- Ignore anything merely documented in a DIFFERENT section; judge each section as a self-contained account.
- Be conservative. If a section is a faithful account, do not flag it. Favour precision over recall.

Return STRICT JSON only: {"findings":[{"heading":"exact section heading","missing":"the step/component left out","evidence":"file:line","reason":"one sentence"}]}`;

const MAX_SECTIONS = 8;

/**
 * Model-backed: audit descriptive sections against the entry-point source for
 * omitted steps/components. One batched call. Returns [] on any failure.
 */
export async function checkNarrative(
  root: string,
  docFiles: string[],
  sample: Sampler,
): Promise<Verdict[]> {
  const sourceBlob = entrySourceBlob(root);
  if (!sourceBlob) return [];

  // Collect candidate sections across docs, capped, with their location.
  const candidates: { docFile: string; section: Section }[] = [];
  for (const docFile of docFiles) {
    let text: string;
    try {
      text = readFileSync(path.join(root, docFile), "utf8");
    } catch {
      continue;
    }
    for (const section of parseSections(text)) {
      if (isDescriptive(section)) candidates.push({ docFile, section });
      if (candidates.length >= MAX_SECTIONS) break;
    }
    if (candidates.length >= MAX_SECTIONS) break;
  }
  if (!candidates.length) return [];

  const sectionsForModel = candidates.map((c) => ({
    heading: c.section.heading,
    text: c.section.body.slice(0, 4000),
  }));
  const user = `ENTRY-POINT SOURCE:\n${sourceBlob}\n\n---\nSECTIONS:\n${JSON.stringify(
    sectionsForModel,
    null,
    2,
  )}`;

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

  const findings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  const verdicts: Verdict[] = [];
  const seen = new Set<string>();
  for (const f of findings) {
    if (!f || typeof f.heading !== "string") continue;
    const hit = candidates.find((c) => c.section.heading === f.heading.trim());
    if (!hit || seen.has(hit.section.heading)) continue;
    seen.add(hit.section.heading);
    const missing = typeof f.missing === "string" ? f.missing.trim() : "a step the code runs";

    verdicts.push({
      claim: {
        id: `narrative:${hit.docFile}:${hit.section.line}`,
        docFile: hit.docFile,
        line: hit.section.line,
        kind: "section",
        text: `"${hit.section.heading}" omits ${missing}`,
        assertion: `the "${hit.section.heading}" section is a complete account`,
        searchHints: [],
      },
      status: "drifted",
      severity: "warning",
      confidence: 0.7,
      explanation:
        typeof f.reason === "string" && f.reason.trim()
          ? f.reason.trim()
          : `The "${hit.section.heading}" section omits ${missing}, which the code does.`,
      suggestedFix: `Update the "${hit.section.heading}" section to include ${missing}.`,
      evidence: [{ file: hit.docFile, line: hit.section.line, snippet: "" }],
      engine: "narrative",
    });
  }
  return verdicts;
}
