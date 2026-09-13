#!/usr/bin/env node
import { analyzeEvaluation, InputError, summarizeReport } from "./core.mjs";
import { readJsonArgument, writeJson } from "./io.mjs";

try {
  let input;
  try { input = await readJsonArgument(process.argv.slice(2)); }
  catch (error) { throw new InputError("Could not read the audit request.", { reason: error instanceof Error ? error.message : String(error) }); }
  const report = await analyzeEvaluation(input);
  writeJson(process.argv.includes("--summary") ? summarizeReport(report) : report);
} catch (error) {
  const payload = {
    schemaVersion: "1.0.0",
    error: {
      code: error instanceof InputError ? "INVALID_INPUT" : "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof InputError ? error.details : null,
    },
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
}
