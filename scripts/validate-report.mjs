#!/usr/bin/env node
import { argumentValue, readJsonFile, readJsonInput, writeJson } from "./io.mjs";
import { validateReport } from "./core.mjs";

try {
  const args = process.argv.slice(2);
  const artifactRoot = argumentValue(args, "--artifact-root");
  if (!artifactRoot) throw new Error("--artifact-root is required.");
  const explicit = args.some((arg) => ["--request", "--request-artifact", "--report"].includes(arg));
  const validation = explicit
    ? {
      schemaVersion: "1.0.0",
      request: await readJsonFile(args, "--request"),
      requestArtifact: await readJsonFile(args, "--request-artifact"),
      report: await readJsonFile(args, "--report"),
    }
    : await readJsonInput(args);
  const errors = await validateReport(validation, { artifactRoot });
  writeJson({ schemaVersion: "1.0.0", valid: errors.length === 0, errors });
  if (errors.length > 0) process.exitCode = 1;
} catch (error) {
  writeJson({ schemaVersion: "1.0.0", valid: false, errors: [error instanceof Error ? error.message : String(error)] });
  process.exitCode = 2;
}
