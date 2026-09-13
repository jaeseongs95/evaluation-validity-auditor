import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (relative) => JSON.parse(readFileSync(path.join(root, relative), "utf8"));
const standaloneRuntime = path.join(root, "runtime", "schema-validation.mjs");
const suiteRuntime = path.resolve(root, "..", "..", "runtime", "schema-validation.mjs");
const runtimePath = (() => {
  try { readFileSync(standaloneRuntime); return standaloneRuntime; } catch { return suiteRuntime; }
})();
const { Ajv2020, addFormats } = await import(pathToFileURL(runtimePath).href);

const requestSchema = load("contracts/evaluation-audit-request.v1.schema.json");
const reportSchema = load("contracts/evaluation-validity-report.v1.schema.json");
const validationSchema = load("contracts/evaluation-report-validation.v1.schema.json");
const summarySchema = load("integration/evaluation-provider-summary.v1.schema.json");
const providerResultSchema = load("integration/provider-result.v1.schema.json");
const koreanProseSchema = load("integration/upstream/korean-prose-evaluation-validity-report.v1.schema.json");

function ajv() {
  const instance = new Ajv2020({ allErrors: true, strict: true });
  addFormats(instance);
  return instance;
}

const validator = ajv();
validator.addSchema(requestSchema);
validator.addSchema(reportSchema);
export const validateRequestSchema = validator.getSchema(requestSchema.$id);
export const validateReportSchema = validator.getSchema(reportSchema.$id);
export const validateValidationSchema = validator.compile(validationSchema);
const compatibilityValidator = ajv();
export const validateKoreanProseSchema = compatibilityValidator.compile(koreanProseSchema);
export const schemaDocuments = {
  requestSchema,
  reportSchema,
  validationSchema,
  summarySchema,
  providerResultSchema,
  koreanProseSchema,
};

export function compileAllSchemas() {
  const isolated = ajv();
  isolated.addSchema(requestSchema);
  isolated.addSchema(reportSchema);
  isolated.compile(validationSchema);
  const integration = ajv();
  integration.addSchema(summarySchema);
  integration.compile(providerResultSchema);
  const compatibility = ajv();
  compatibility.compile(koreanProseSchema);
  return true;
}
