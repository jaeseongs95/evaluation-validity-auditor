#!/usr/bin/env node
import { validateReport } from "./core.mjs";
import { readJsonArgument, writeJson } from "./io.mjs";

try {
  const validation = await readJsonArgument(process.argv.slice(2));
  const errors = await validateReport(validation);
  writeJson({ schemaVersion: "1.0.0", valid: errors.length === 0, errors });
  if (errors.length > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ schemaVersion: "1.0.0", valid: false, errors: [error instanceof Error ? error.message : String(error)] }, null, 2)}\n`);
  process.exitCode = 1;
}
