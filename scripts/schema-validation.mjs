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

const requestSchema = load("contracts/evaluation-validity-request.v1.schema.json");
const caseRecordSchema = load("contracts/evaluation-case-record.v1.schema.json");
const resultRecordSchema = load("contracts/evaluation-result-record.v1.schema.json");
const aggregateClaimSchema = load("contracts/evaluation-aggregate-claim.v1.schema.json");
const reportSchema = load("contracts/evaluation-validity-report.v1.schema.json");
const validationSchema = load("contracts/evaluation-validity-validation.v1.schema.json");
const providerResultSchema = load("integration/provider-result.v1.schema.json");

function ajv() {
  const instance = new Ajv2020({ allErrors: true, strict: true });
  addFormats(instance);
  return instance;
}

const validator = ajv();
for (const schema of [requestSchema, caseRecordSchema, resultRecordSchema, aggregateClaimSchema, reportSchema]) validator.addSchema(schema);
export const validateRequestSchema = validator.getSchema(requestSchema.$id);
export const validateCaseRecordSchema = validator.getSchema(caseRecordSchema.$id);
export const validateResultRecordSchema = validator.getSchema(resultRecordSchema.$id);
export const validateAggregateClaimSchema = validator.getSchema(aggregateClaimSchema.$id);
export const validateReportSchema = validator.getSchema(reportSchema.$id);
export const validateValidationSchema = validator.compile(validationSchema);
export const schemaDocuments = { requestSchema, caseRecordSchema, resultRecordSchema, aggregateClaimSchema, reportSchema, validationSchema, providerResultSchema };

export function compileAllSchemas() {
  const isolated = ajv();
  for (const schema of [requestSchema, caseRecordSchema, resultRecordSchema, aggregateClaimSchema, reportSchema]) isolated.addSchema(schema);
  isolated.compile(validationSchema);
  const integration = ajv();
  integration.addSchema(reportSchema);
  integration.compile(providerResultSchema);
  return true;
}
