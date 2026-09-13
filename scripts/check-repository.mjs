import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileAllSchemas, schemaDocuments } from "./schema-validation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "SKILL.md",
  "agents/openai.yaml",
  "contracts/evaluation-audit-request.v1.schema.json",
  "contracts/evaluation-validity-report.v1.schema.json",
  "contracts/evaluation-report-validation.v1.schema.json",
  "integration/skill-descriptor.json",
  "integration/adapters/korean-prose.mjs",
  "integration/upstream/korean-prose-evaluation-validity-report.v1.schema.json",
  "integration/upstream/lock.json",
  "runtime/schema-validation.mjs",
  "runtime/lock.json",
  "runtime/THIRD_PARTY_NOTICES.md",
];

const text = async (relative) => readFile(path.join(root, relative), "utf8");
const failures = [];
for (const relative of required) {
  try { await text(relative); } catch { failures.push(`missing required file: ${relative}`); }
}

const packageJson = JSON.parse(await text("package.json"));
const descriptor = JSON.parse(await text("integration/skill-descriptor.json"));
const upstreamLock = JSON.parse(await text("integration/upstream/lock.json"));
const runtimeLock = JSON.parse(await text("runtime/lock.json"));
const skill = await text("SKILL.md");
if (!skill.startsWith("---\nname: evaluation-validity-auditor\n")) failures.push("SKILL.md name does not match the directory");
if (!/^\s*version:\s*["']?1\.0\.0["']?\s*$/mu.test(skill)) failures.push("SKILL.md version is not 1.0.0");
if (packageJson.version !== "1.0.0") failures.push("package version is not 1.0.0");
if (descriptor.providers.length !== 2) failures.push("descriptor must expose exactly two providers");
if (descriptor.providers.some((provider) => provider.skillId !== packageJson.name || provider.version !== packageJson.version)) failures.push("descriptor identity/version mismatch");
if (descriptor.providers.some((provider) => provider.receiptPolicy?.mode !== "reference-only")) failures.push("providers must use reference-only receipts");
if (new Set(descriptor.providers.map((provider) => provider.phaseOrder)).size !== descriptor.providers.length) failures.push("provider phase orders must be unique");
const snapshotBytes = await readFile(path.join(root, "integration/upstream/korean-prose-evaluation-validity-report.v1.schema.json"));
const snapshotDigest = `sha256:${createHash("sha256").update(snapshotBytes).digest("hex")}`;
if (snapshotDigest !== upstreamLock.snapshotDigest) failures.push("Korean prose compatibility snapshot digest mismatch");
const runtimeBytes = await readFile(path.join(root, "runtime/schema-validation.mjs"));
const runtimeDigest = `sha256:${createHash("sha256").update(runtimeBytes).digest("hex")}`;
if (runtimeDigest !== runtimeLock.bundleDigest) failures.push("runtime schema validator bundle digest mismatch");

const reportCodes = new Set(schemaDocuments.reportSchema.$defs.code.enum);
const summaryCodes = new Set(schemaDocuments.summarySchema.properties.blockingCodes.items.enum);
if ([...reportCodes].some((code) => !summaryCodes.has(code)) || [...summaryCodes].some((code) => !reportCodes.has(code))) failures.push("summary blocking codes do not match report codes");

try { compileAllSchemas(); } catch (error) { failures.push(`schema compilation failed: ${error instanceof Error ? error.message : String(error)}`); }

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("repository checks passed\n");
}
