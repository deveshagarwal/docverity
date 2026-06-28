// A tiny sample CLI used to demonstrate DocDrift.
// The README intentionally describes some things that no longer match this code.

export interface Config {
  json: boolean;
  verbose: boolean;
}

/** Parse argv into a Config. Supports --json and --verbose. */
export function parseConfig(argv: string[]): Config {
  return {
    json: argv.includes("--json"),
    verbose: argv.includes("--verbose"),
  };
}

function main(): void {
  const config = parseConfig(process.argv.slice(2));
  const token = process.env.API_TOKEN;
  if (!token) {
    console.error("Set API_TOKEN to authenticate.");
    process.exit(1);
  }
  if (config.json) {
    console.log(JSON.stringify({ ok: true }));
  } else {
    console.log("ok");
  }
}

main();
