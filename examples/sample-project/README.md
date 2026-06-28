# sample-project

A tiny example CLI. This README contains a few claims that no longer match the
code in `src/index.ts`, so Docverity has something to find.

## Usage

Run the CLI and pass `--json` to get machine-readable output:

```bash
API_TOKEN=xxx node dist/index.js --json
```

Use `--pretty` to get human-friendly formatting.

You can also enable detailed logs by setting `LEGACY_KEY` in your environment.

## Configuration

Configuration is parsed by the `loadConfig()` function. See `src/legacy.ts` for
the full option list. The `--verbose` flag turns on extra logging.

## Behavior

By default, the CLI prints its result as JSON. If `API_TOKEN` is not set, the
command exits with a non-zero status. The `parseConfig` function returns an
object with a `timeout` field that defaults to 5000 milliseconds.
