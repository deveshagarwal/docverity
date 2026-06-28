import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Default doc discovery: README at root plus markdown under docs/. */
export function discoverDocs(root: string): string[] {
  const found: string[] = [];
  for (const name of ["README.md", "README.markdown", "readme.md"]) {
    if (existsSync(path.join(root, name))) {
      found.push(name);
      break;
    }
  }
  const docsDir = path.join(root, "docs");
  if (existsSync(docsDir) && statSync(docsDir).isDirectory()) {
    walkMarkdown(docsDir, root, found);
  }
  return found;
}

function walkMarkdown(dir: string, root: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkMarkdown(full, root, out);
    else if (entry.endsWith(".md")) out.push(path.relative(root, full));
  }
}
