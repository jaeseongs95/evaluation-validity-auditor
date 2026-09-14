import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileAllSchemas } from "./schema-validation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "SKILL.md",
  "agents/openai.yaml",
  "contracts/evaluation-validity-request.v1.schema.json",
  "contracts/evaluation-case-record.v1.schema.json",
  "contracts/evaluation-result-record.v1.schema.json",
  "contracts/evaluation-aggregate-claim.v1.schema.json",
  "contracts/evaluation-validity-report.v1.schema.json",
  "contracts/evaluation-validity-validation.v1.schema.json",
  "integration/skill-descriptor.json",
  "integration/provider-result.v1.schema.json",
  "runtime/schema-validation.mjs",
  "runtime/lock.json",
  "runtime/THIRD_PARTY_NOTICES.md",
  "scripts/cli.mjs",
  "scripts/digest-request.mjs",
  "scripts/validate-report.mjs",
];

const text = async (relative) => readFile(path.join(root, relative), "utf8");
const failures = [];
for (const relative of required) {
  try { await text(relative); } catch { failures.push(`missing required file: ${relative}`); }
}

const packageJson = JSON.parse(await text("package.json"));
const descriptor = JSON.parse(await text("integration/skill-descriptor.json"));
const runtimeLock = JSON.parse(await text("runtime/lock.json"));
const skill = await text("SKILL.md");
if (!skill.startsWith("---\nname: evaluation-validity-auditor\n")) failures.push("SKILL.md name does not match the repository");
if (!/^\s*version:\s*["']?1\.0\.0["']?\s*$/mu.test(skill)) failures.push("SKILL.md version is not 1.0.0");
if (packageJson.version !== "1.0.0") failures.push("package version is not 1.0.0");
if (descriptor.providers.length !== 1) failures.push("descriptor must expose exactly one provider");
const provider = descriptor.providers[0];
if (provider?.skillId !== packageJson.name || provider?.version !== packageJson.version) failures.push("descriptor identity/version mismatch");
if (provider?.capabilities?.length !== 1 || provider.capabilities[0] !== "evaluation-validity-audit") failures.push("descriptor capability mismatch");
if (provider?.phase !== "evaluation-validity" || provider?.phaseOrder !== 68) failures.push("descriptor phase mismatch");
if (provider?.receiptPolicy?.mode !== "reference-only") failures.push("provider must use reference-only receipts");
const runtimeBytes = await readFile(path.join(root, "runtime/schema-validation.mjs"));
const runtimeDigest = `sha256:${createHash("sha256").update(runtimeBytes).digest("hex")}`;
if (runtimeDigest !== runtimeLock.bundleDigest) failures.push("runtime schema validator bundle digest mismatch");

const entries = await readdir(root, { recursive: true });
const domainSpecificPattern = new RegExp(["korean", "prose"].join("-"), "iu");
for (const entry of entries) {
  if (entry.startsWith(".git") || entry.startsWith("node_modules")) continue;
  try {
    const value = await text(entry);
    if (domainSpecificPattern.test(value)) failures.push(`domain-specific coupling remains: ${entry.replaceAll("\\", "/")}`);
  } catch {}
}

try { compileAllSchemas(); } catch (error) { failures.push(`schema compilation failed: ${error instanceof Error ? error.message : String(error)}`); }

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("repository checks passed\n");
}
