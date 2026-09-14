#!/usr/bin/env node
import { analyzeEvaluation, InputError } from "./core.mjs";
import { argumentValue, readJsonInput, writeJson } from "./io.mjs";

try {
  const args = process.argv.slice(2);
  const input = await readJsonInput(args);
  const artifactRoot = argumentValue(args, "--artifact-root");
  if (!artifactRoot) throw new InputError("--artifact-root is required.");
  writeJson(await analyzeEvaluation(input, { artifactRoot }));
} catch (error) {
  writeJson({
    schemaVersion: "1.0.0",
    ok: false,
    error: {
      code: "INVALID_INPUT",
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof InputError ? error.details : null,
    },
  });
  process.exitCode = 2;
}
