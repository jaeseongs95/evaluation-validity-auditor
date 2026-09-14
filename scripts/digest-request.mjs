#!/usr/bin/env node
import { digestRequest, InputError } from "./core.mjs";
import { readJsonInput, writeJson } from "./io.mjs";

try {
  writeJson(digestRequest(await readJsonInput(process.argv.slice(2))));
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
