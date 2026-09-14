import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  validateAggregateClaimSchema,
  validateCaseRecordSchema,
  validateReportSchema,
  validateRequestSchema,
  validateResultRecordSchema,
  validateValidationSchema,
} from "./schema-validation.mjs";

const CONTROL_ROLES = ["fixture-manifest", "rubric", "oracle", "aggregation-rule", "timing-evidence"];
const POST_ROLES = ["result-records", "aggregate-claim"];
const PRE_CHECK_IDS = [
  "ARTIFACT_INTEGRITY",
  "FRAME_FROZEN",
  "CASE_MANIFEST_COMPLETE",
  "ROLE_INDEPENDENCE",
  "JUDGMENT_METHOD_VALID",
  "AGGREGATION_RULE_VALID",
  "TIMING_PROVENANCE_VALID",
  "NO_POSTHOC_INPUT",
];
const POST_CHECK_IDS = ["RUN_SET_COMPLETE", "RESULT_RECORDS_COMPLETE", "AGGREGATE_RECOMPUTED", "CLAIM_MATCHES"];

export class InputError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = "InputError";
    this.details = details;
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new InputError("Input contains a non-JSON value.");
}

export function sha256Canonical(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function sha256Raw(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function check(checkId, status, code, evidenceRefs = []) {
  return { checkId, status, code, evidenceRefs: [...new Set(evidenceRefs)].sort() };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isAbsoluteOnAnyPlatform(locator) {
  return path.isAbsolute(locator) || path.win32.isAbsolute(locator) || path.posix.isAbsolute(locator);
}

async function inspectArtifacts(input, artifactRoot) {
  if (typeof artifactRoot !== "string" || artifactRoot.length === 0) throw new InputError("--artifact-root is required.");
  let root;
  try { root = await realpath(path.resolve(artifactRoot)); }
  catch { throw new InputError("Artifact root does not exist or cannot be resolved."); }
  const states = new Map();
  for (const artifact of input.artifacts) {
    if (states.has(artifact.artifactId)) throw new InputError(`Duplicate artifact ID: ${artifact.artifactId}`);
    if (isAbsoluteOnAnyPlatform(artifact.locator)) throw new InputError(`Artifact locator must be relative: ${artifact.artifactId}`);
    const candidate = path.resolve(root, artifact.locator);
    if (!isWithin(root, candidate)) throw new InputError(`Artifact locator escapes artifact root: ${artifact.artifactId}`);
    try {
      const resolved = await realpath(candidate);
      if (!isWithin(root, resolved)) throw new InputError(`Artifact symlink escapes artifact root: ${artifact.artifactId}`);
      const bytes = await readFile(resolved);
      states.set(artifact.artifactId, { artifact, exists: true, digestMatches: sha256Raw(bytes) === artifact.digest, bytes });
    } catch (error) {
      if (error instanceof InputError) throw error;
      states.set(artifact.artifactId, { artifact, exists: false, digestMatches: false, bytes: null });
    }
  }
  return states;
}

function byRole(states, role) {
  return [...states.values()].filter((state) => state.artifact.role === role);
}

function oneRole(states, role) {
  const matches = byRole(states, role);
  return matches.length === 1 ? matches[0] : null;
}

function artifactIds(states, roles) {
  return [...states.values()].filter((state) => roles.includes(state.artifact.role)).map((state) => state.artifact.artifactId);
}

function artifactIntegrityCheck(input, states) {
  const requiredRoles = input.auditStage === "post-execution" ? [...CONTROL_ROLES, ...POST_ROLES] : CONTROL_ROLES;
  const missingRole = requiredRoles.some((role) => {
    const count = byRole(states, role).length;
    return role === "result-records" ? count < 1 : count !== 1;
  });
  const duplicateRole = requiredRoles.some((role) => role !== "result-records" && byRole(states, role).length > 1);
  const relevant = [...states.values()];
  const missing = relevant.some((state) => !state.exists);
  const mismatched = relevant.some((state) => state.exists && !state.digestMatches);
  const refs = relevant.map((state) => state.artifact.artifactId);
  if (duplicateRole) return check("ARTIFACT_INTEGRITY", "FAIL", "REQUIRED_ARTIFACT_ROLE_INVALID", refs);
  if (missingRole) return check("ARTIFACT_INTEGRITY", "BLOCKED", "REQUIRED_ARTIFACT_ROLE_INVALID", refs);
  if (mismatched) return check("ARTIFACT_INTEGRITY", "FAIL", "DIGEST_MISMATCH", refs);
  if (missing) return check("ARTIFACT_INTEGRITY", "BLOCKED", "ARTIFACT_MISSING", refs);
  return check("ARTIFACT_INTEGRITY", "PASS", "CHECK_PASSED", refs);
}

function parseJsonState(state, validator) {
  if (!state?.exists || !state.digestMatches || state.artifact.mediaType !== "json") return { ok: false, code: "ARTIFACT_MISSING", value: null };
  try {
    const value = JSON.parse(state.bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "AGGREGATE_CLAIM_INVALID", value: null };
    if (validator && !validator(value)) return { ok: false, code: "AGGREGATE_CLAIM_INVALID", value: null };
    return { ok: true, code: "CHECK_PASSED", value };
  } catch {
    return { ok: false, code: "AGGREGATE_CLAIM_INVALID", value: null };
  }
}

function parseJsonlState(state, validator, schemaCode) {
  if (!state?.exists || !state.digestMatches) return { ok: false, code: "ARTIFACT_MISSING", records: [] };
  if (state.artifact.mediaType !== "jsonl") return { ok: false, code: schemaCode, records: [] };
  const records = [];
  try {
    for (const line of state.bytes.toString("utf8").split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (!validator(record)) return { ok: false, code: schemaCode, records };
      records.push(record);
    }
  } catch {
    return { ok: false, code: "JSONL_PARSE_FAILED", records };
  }
  return { ok: true, code: "CHECK_PASSED", records };
}

function frameCheck(input) {
  const frozenAt = Date.parse(input.frozenAt);
  const auditedAt = Date.parse(input.auditedAt);
  const startedAt = input.executionStartedAt === null ? null : Date.parse(input.executionStartedAt);
  if (frozenAt > auditedAt) return check("FRAME_FROZEN", "FAIL", "FRAME_FROZEN_AFTER_AUDIT");
  if (startedAt !== null && frozenAt > startedAt) return check("FRAME_FROZEN", "FAIL", "FRAME_FROZEN_AFTER_EXECUTION");
  if (input.auditStage === "pre-execution" && startedAt !== null && auditedAt > startedAt) return check("FRAME_FROZEN", "FAIL", "AUDIT_NOT_PRE_EXECUTION");
  if (input.auditStage === "post-execution" && startedAt !== null && auditedAt < startedAt) return check("FRAME_FROZEN", "FAIL", "AUDIT_NOT_POST_EXECUTION");
  return check("FRAME_FROZEN", "PASS", "CHECK_PASSED");
}

function parseCaseManifest(input, states) {
  const state = oneRole(states, "fixture-manifest");
  const parsed = parseJsonlState(state, validateCaseRecordSchema, "CASE_SCHEMA_INVALID");
  const refs = state ? [state.artifact.artifactId] : [];
  if (!parsed.ok) return { check: check("CASE_MANIFEST_COMPLETE", parsed.code === "ARTIFACT_MISSING" ? "BLOCKED" : "FAIL", parsed.code, refs), records: parsed.records };
  const ids = parsed.records.map((record) => record.caseId);
  if (new Set(ids).size !== ids.length) return { check: check("CASE_MANIFEST_COMPLETE", "FAIL", "CASE_DUPLICATE", refs), records: parsed.records };
  const expected = input.expected.caseIds;
  const missing = expected.filter((id) => !ids.includes(id));
  const unknown = ids.filter((id) => !expected.includes(id));
  if (missing.length > 0) return { check: check("CASE_MANIFEST_COMPLETE", "FAIL", "CASE_MISSING", refs), records: parsed.records };
  if (unknown.length > 0) return { check: check("CASE_MANIFEST_COMPLETE", "FAIL", "CASE_UNKNOWN", refs), records: parsed.records };
  if (canonicalJson(ids) !== canonicalJson(expected)) return { check: check("CASE_MANIFEST_COMPLETE", "FAIL", "CASE_ORDER_MISMATCH", refs), records: parsed.records };
  return { check: check("CASE_MANIFEST_COMPLETE", "PASS", "CHECK_PASSED", refs), records: parsed.records };
}

function roleCheck(input) {
  const { authorIds, executorIds, judgeIds, auditorId } = input.actors;
  const producers = [...authorIds, ...executorIds, ...judgeIds];
  const judgeConflict = judgeIds.some((id) => authorIds.includes(id) || executorIds.includes(id));
  return producers.includes(auditorId) || judgeConflict
    ? check("ROLE_INDEPENDENCE", "FAIL", "ROLE_CONFLICT")
    : check("ROLE_INDEPENDENCE", "PASS", "CHECK_PASSED");
}

function methodCheck(input, states) {
  const ids = input.criteria.map((criterion) => criterion.criterionId);
  if (new Set(ids).size !== ids.length || canonicalJson([...ids].sort()) !== canonicalJson([...input.expected.criterionIds].sort())) {
    return check("JUDGMENT_METHOD_VALID", "FAIL", "JUDGMENT_METHOD_MISMATCH");
  }
  const artifactIdSet = new Set(states.keys());
  for (const criterion of input.criteria) {
    const methods = criterion.judgmentMethods;
    if (criterion.kind === "semantic" && !methods.includes("independent-review")) {
      if (methods.length === 1 && methods[0] === "self-report") return check("JUDGMENT_METHOD_VALID", "FAIL", "SELF_REPORT_ONLY", criterion.evidenceRefs);
      if (methods.includes("lexical-match")) return check("JUDGMENT_METHOD_VALID", "FAIL", "SEMANTIC_LEXICAL_ONLY", criterion.evidenceRefs);
      return check("JUDGMENT_METHOD_VALID", "FAIL", "JUDGMENT_METHOD_MISMATCH", criterion.evidenceRefs);
    }
    if (criterion.kind === "deterministic" && !methods.some((method) => ["deterministic-oracle", "lexical-match"].includes(method))) {
      return check("JUDGMENT_METHOD_VALID", "FAIL", methods.length === 1 && methods[0] === "self-report" ? "SELF_REPORT_ONLY" : "JUDGMENT_METHOD_MISMATCH", criterion.evidenceRefs);
    }
    const oracle = criterion.oracleArtifactId ? states.get(criterion.oracleArtifactId) : null;
    if (!oracle || !oracle.exists) {
      return check("JUDGMENT_METHOD_VALID", "BLOCKED", "ARTIFACT_MISSING", [criterion.oracleArtifactId].filter(Boolean));
    }
    if (oracle.artifact.role !== "oracle" || !oracle.digestMatches || criterion.evidenceRefs.some((ref) => !artifactIdSet.has(ref))) {
      return check("JUDGMENT_METHOD_VALID", "FAIL", "ORACLE_BINDING_INVALID", [criterion.oracleArtifactId, ...criterion.evidenceRefs].filter(Boolean));
    }
    if (criterion.kind === "semantic" && criterion.evidenceRefs.length === 0) return check("JUDGMENT_METHOD_VALID", "BLOCKED", "PROVENANCE_MISSING");
  }
  return check("JUDGMENT_METHOD_VALID", "PASS", "CHECK_PASSED", input.criteria.flatMap((criterion) => [criterion.oracleArtifactId, ...criterion.evidenceRefs]).filter(Boolean));
}

function aggregationRuleCheck(input, states) {
  const state = oneRole(states, "aggregation-rule");
  if (!state?.exists || !state.digestMatches) return check("AGGREGATION_RULE_VALID", "BLOCKED", "ARTIFACT_MISSING", state ? [state.artifact.artifactId] : []);
  if (state.artifact.mediaType !== "json") return check("AGGREGATION_RULE_VALID", "FAIL", "AGGREGATION_INVALID", [state.artifact.artifactId]);
  let rule;
  try { rule = JSON.parse(state.bytes.toString("utf8")); } catch { return check("AGGREGATION_RULE_VALID", "FAIL", "AGGREGATION_INVALID", [state.artifact.artifactId]); }
  const metricIds = input.metrics.map((metric) => metric.metricId);
  const valid = rule?.schemaVersion === "1.0.0"
    && rule.denominator === "all-expected-records"
    && Array.isArray(rule.metricIds)
    && new Set(metricIds).size === metricIds.length
    && canonicalJson([...rule.metricIds].sort()) === canonicalJson([...metricIds].sort())
    && input.metrics.every((metric) => input.expected.criterionIds.includes(metric.criterionId));
  return check("AGGREGATION_RULE_VALID", valid ? "PASS" : "FAIL", valid ? "CHECK_PASSED" : "AGGREGATION_INVALID", [state.artifact.artifactId]);
}

function provenanceCheck(states) {
  const controls = [...states.values()].filter((state) => CONTROL_ROLES.includes(state.artifact.role));
  const missing = controls.some((state) => state.artifact.provenance === null);
  return missing
    ? check("TIMING_PROVENANCE_VALID", "BLOCKED", "PROVENANCE_MISSING", controls.map((state) => state.artifact.artifactId))
    : check("TIMING_PROVENANCE_VALID", "PASS", "CHECK_PASSED", controls.flatMap((state) => state.artifact.provenance.evidenceRefs));
}

function posthocCheck(input, states) {
  if (input.executionStartedAt === null) return check("NO_POSTHOC_INPUT", "PASS", "CHECK_PASSED");
  const startedAt = Date.parse(input.executionStartedAt);
  const controls = [...states.values()].filter((state) => CONTROL_ROLES.includes(state.artifact.role));
  const posthoc = controls.some((state) => Date.parse(state.artifact.availableAt) > startedAt
    || (state.artifact.provenance && Date.parse(state.artifact.provenance.observedAt) > startedAt));
  const auditedAt = Date.parse(input.auditedAt);
  const resultEvidence = [...states.values()].filter((state) => POST_ROLES.includes(state.artifact.role));
  const unavailableAtAudit = input.auditStage === "post-execution" && resultEvidence.some((state) => {
    const availableAt = Date.parse(state.artifact.availableAt);
    const observedAt = state.artifact.provenance ? Date.parse(state.artifact.provenance.observedAt) : availableAt;
    return availableAt < startedAt || availableAt > auditedAt || observedAt < startedAt || observedAt > auditedAt;
  });
  return posthoc
    ? check("NO_POSTHOC_INPUT", "FAIL", "POSTHOC_INPUT", controls.map((state) => state.artifact.artifactId))
    : unavailableAtAudit
      ? check("NO_POSTHOC_INPUT", "FAIL", "RESULT_EVIDENCE_NOT_AVAILABLE_AT_AUDIT", resultEvidence.map((state) => state.artifact.artifactId))
    : check("NO_POSTHOC_INPUT", "PASS", "CHECK_PASSED", controls.map((state) => state.artifact.artifactId));
}

function runCheck(input) {
  const actual = input.runs.map((run) => run.runId);
  if (new Set(actual).size !== actual.length) return check("RUN_SET_COMPLETE", "FAIL", "RUN_DUPLICATE");
  const missing = input.expected.runIds.filter((id) => !actual.includes(id));
  const unknown = actual.filter((id) => !input.expected.runIds.includes(id));
  if (missing.length > 0) return check("RUN_SET_COMPLETE", "FAIL", "RUN_MISSING");
  if (unknown.length > 0) return check("RUN_SET_COMPLETE", "FAIL", "RUN_UNKNOWN");
  return check("RUN_SET_COMPLETE", "PASS", "CHECK_PASSED", input.runs.map((run) => run.resultArtifactId).filter(Boolean));
}

function parseResults(input, states) {
  const records = [];
  for (const run of input.runs) {
    if (run.status !== "completed") continue;
    const state = states.get(run.resultArtifactId);
    if (!state || state.artifact.role !== "result-records") {
      return { check: check("RESULT_RECORDS_COMPLETE", "BLOCKED", "ARTIFACT_MISSING", [run.resultArtifactId]), records };
    }
    const parsed = parseJsonlState(state, validateResultRecordSchema, "RESULT_SCHEMA_INVALID");
    if (!parsed.ok) return { check: check("RESULT_RECORDS_COMPLETE", parsed.code === "ARTIFACT_MISSING" ? "BLOCKED" : "FAIL", parsed.code, [state.artifact.artifactId]), records };
    if (parsed.records.some((record) => record.runId !== run.runId)) {
      return { check: check("RESULT_RECORDS_COMPLETE", "FAIL", "RESULT_UNKNOWN", [state.artifact.artifactId]), records: [...records, ...parsed.records] };
    }
    records.push(...parsed.records);
  }
  const keys = records.map((record) => `${record.runId}\u0000${record.caseId}\u0000${record.criterionId}`);
  if (new Set(keys).size !== keys.length) return { check: check("RESULT_RECORDS_COMPLETE", "FAIL", "RESULT_DUPLICATE", artifactIds(states, ["result-records"])), records };
  const completedRuns = input.runs.filter((run) => run.status === "completed").map((run) => run.runId);
  const expectedKeys = completedRuns.flatMap((runId) => input.expected.caseIds.flatMap((caseId) => input.expected.criterionIds.map((criterionId) => `${runId}\u0000${caseId}\u0000${criterionId}`)));
  if (expectedKeys.some((key) => !keys.includes(key))) return { check: check("RESULT_RECORDS_COMPLETE", "FAIL", "RESULT_MISSING", artifactIds(states, ["result-records"])), records };
  if (keys.some((key) => !expectedKeys.includes(key))) return { check: check("RESULT_RECORDS_COMPLETE", "FAIL", "RESULT_UNKNOWN", artifactIds(states, ["result-records"])), records };
  const criteria = new Map(input.criteria.map((criterion) => [criterion.criterionId, criterion]));
  const artifacts = new Set(states.keys());
  const invalid = records.some((record) => {
    const criterion = criteria.get(record.criterionId);
    const actualMethodAllowed = criterion?.kind === "semantic"
      ? record.judgmentMethod === "independent-review"
      : ["deterministic-oracle", "lexical-match"].includes(record.judgmentMethod);
    return !criterion
      || !input.actors.judgeIds.includes(record.judgeActorId)
      || !criterion.judgmentMethods.includes(record.judgmentMethod)
      || !actualMethodAllowed
      || record.evidenceRefs.some((ref) => !artifacts.has(ref));
  });
  if (invalid) return { check: check("RESULT_RECORDS_COMPLETE", "FAIL", "JUDGMENT_METHOD_MISMATCH", artifactIds(states, ["result-records"])), records };
  return { check: check("RESULT_RECORDS_COMPLETE", "PASS", "CHECK_PASSED", artifactIds(states, ["result-records"])), records };
}

function compare(value, comparator, threshold) {
  if (comparator === ">=") return value >= threshold;
  if (comparator === ">") return value > threshold;
  if (comparator === "=") return value === threshold;
  if (comparator === "<=") return value <= threshold;
  return value < threshold;
}

function nearlyEqual(left, right) {
  return Math.abs(left - right) <= 1e-12 * Math.max(1, Math.abs(left), Math.abs(right));
}

function recompute(input, records, prerequisites) {
  if (prerequisites.some((item) => item.status === "FAIL")) return { check: check("AGGREGATE_RECOMPUTED", "FAIL", "AGGREGATION_INVALID"), metrics: [] };
  if (prerequisites.some((item) => item.status === "BLOCKED")) return { check: check("AGGREGATE_RECOMPUTED", "BLOCKED", "ARTIFACT_MISSING"), metrics: [] };
  const byKey = new Map(records.map((record) => [`${record.runId}\u0000${record.caseId}\u0000${record.criterionId}`, record]));
  const metrics = [];
  for (const metric of input.metrics) {
    const slots = input.expected.runIds.flatMap((runId) => input.expected.caseIds.map((caseId) => byKey.get(`${runId}\u0000${caseId}\u0000${metric.criterionId}`) ?? { outcome: "ERROR", value: null }));
    const denominator = slots.length;
    let numerator = 0;
    if (metric.operation === "rate") numerator = slots.filter((record) => metric.numeratorOutcomes.includes(record.outcome)).length;
    else {
      for (const record of slots) {
        if (record.value === null) continue;
        if (typeof record.value !== "number" || !Number.isFinite(record.value)) return { check: check("AGGREGATE_RECOMPUTED", "FAIL", "AGGREGATION_INVALID"), metrics: [] };
        numerator += record.value;
      }
    }
    const value = metric.operation === "sum" ? numerator : numerator / denominator;
    metrics.push({
      metricId: metric.metricId,
      numerator,
      denominator,
      value,
      comparator: metric.comparator,
      threshold: metric.threshold,
      claimedValue: metric.claimedValue,
      claimMatches: nearlyEqual(value, metric.claimedValue),
      thresholdPassed: compare(value, metric.comparator, metric.threshold),
    });
  }
  return { check: check("AGGREGATE_RECOMPUTED", "PASS", "CHECK_PASSED"), metrics };
}

function claimCheck(input, states, metrics, aggregateStatus) {
  if (aggregateStatus === "BLOCKED") return check("CLAIM_MATCHES", "BLOCKED", "ARTIFACT_MISSING");
  if (aggregateStatus === "FAIL") return check("CLAIM_MATCHES", "FAIL", "AGGREGATION_INVALID");
  const state = oneRole(states, "aggregate-claim");
  if (!state?.exists) return check("CLAIM_MATCHES", "BLOCKED", "AGGREGATE_CLAIM_MISSING");
  const parsed = parseJsonState(state, validateAggregateClaimSchema);
  if (!parsed.ok) return check("CLAIM_MATCHES", "FAIL", "AGGREGATE_CLAIM_INVALID", [state.artifact.artifactId]);
  const claim = parsed.value;
  if (claim.evaluationId !== input.target.evaluationId || claim.targetDigest !== input.target.digest) return check("CLAIM_MATCHES", "FAIL", "AGGREGATE_MISMATCH", [state.artifact.artifactId]);
  const claimedById = new Map(claim.metrics.map((metric) => [metric.metricId, metric]));
  const matches = claim.metrics.length === metrics.length && metrics.every((metric) => {
    const claimed = claimedById.get(metric.metricId);
    return claimed
      && nearlyEqual(claimed.numerator, metric.numerator)
      && claimed.denominator === metric.denominator
      && nearlyEqual(claimed.value, metric.value)
      && claimed.comparator === metric.comparator
      && nearlyEqual(claimed.threshold, metric.threshold)
      && claimed.passed === metric.thresholdPassed
      && metric.claimMatches;
  });
  return check("CLAIM_MATCHES", matches ? "PASS" : "FAIL", matches ? "CHECK_PASSED" : "AGGREGATE_MISMATCH", [state.artifact.artifactId]);
}

function verdictFor(checks) {
  if (checks.some((item) => item.status === "FAIL")) return "FAIL";
  if (checks.some((item) => item.status === "BLOCKED")) return "BLOCKED";
  return "PASS";
}

function bindings(input) {
  return input.artifacts.map(({ artifactId, role, digest }) => ({ artifactId, role, digest })).sort((left, right) => left.artifactId.localeCompare(right.artifactId));
}

function evidenceIndex(states) {
  return [...states.values()]
    .filter((state) => state.exists && state.digestMatches)
    .map((state) => ({ artifactId: state.artifact.artifactId, role: state.artifact.role, digest: state.artifact.digest }))
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
}

export async function analyzeEvaluation(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !validateRequestSchema(input)) {
    throw new InputError("EvaluationValidityRequest.v1 validation failed.", { errors: structuredClone(validateRequestSchema?.errors ?? []) });
  }
  const states = await inspectArtifacts(input, options.artifactRoot);
  const caseManifest = parseCaseManifest(input, states);
  const checks = [
    artifactIntegrityCheck(input, states),
    frameCheck(input),
    caseManifest.check,
    roleCheck(input),
    methodCheck(input, states),
    aggregationRuleCheck(input, states),
    provenanceCheck(states),
    posthocCheck(input, states),
  ];
  let records = [];
  let metrics = [];
  if (input.auditStage === "post-execution") {
    const run = runCheck(input);
    const result = parseResults(input, states);
    checks.push(run, result.check);
    records = result.records;
    const aggregate = recompute(input, records, [run, result.check, caseManifest.check]);
    metrics = aggregate.metrics;
    checks.push(aggregate.check, claimCheck(input, states, metrics, aggregate.check.status));
  }
  const verdict = verdictFor(checks);
  const expectedResults = input.expected.caseIds.length * input.expected.runIds.length * input.expected.criterionIds.length;
  const report = {
    schemaVersion: "1.0.0",
    auditId: input.auditId,
    auditStage: input.auditStage,
    auditedAt: input.auditedAt,
    auditorActorId: input.actors.auditorId,
    requestDigest: sha256Canonical(input),
    target: structuredClone(input.target),
    artifactBindings: bindings(input),
    checks,
    coverage: {
      expectedCases: input.expected.caseIds.length,
      observedCases: caseManifest.records.length,
      expectedRuns: input.expected.runIds.length,
      observedRuns: input.runs.length,
      expectedResults,
      observedResults: records.length,
    },
    recomputedMetrics: metrics,
    verifiedEvidenceIndex: evidenceIndex(states),
    blockingCodes: [...new Set(checks.filter((item) => item.status !== "PASS").map((item) => item.code))].sort(),
    limitations: [...new Set([...input.knownLimitations, "COOPERATIVE_PROVENANCE_ASSERTIONS", "JSON_JSONL_ONLY_V1"])].sort(),
    qualifiesAsQualityOrReleaseEvidence: input.auditStage === "post-execution" && verdict === "PASS",
    verdict,
  };
  const complete = { ...report, reportDigest: sha256Canonical(report) };
  if (!validateReportSchema(complete)) throw new InputError("Generated report does not satisfy EvaluationValidityReport.v1.", { errors: structuredClone(validateReportSchema.errors) });
  return complete;
}

export async function validateReport(validation, options = {}) {
  if (!validation || typeof validation !== "object" || Array.isArray(validation)) throw new InputError("EvaluationValidityValidation.v1 must be an object.");
  if (!validateValidationSchema(validation)) {
    const schemaErrors = structuredClone(validateValidationSchema.errors ?? []);
    const reportOnly = schemaErrors.length > 0 && schemaErrors.every((error) => error.instancePath === "/report" || error.instancePath.startsWith("/report/"));
    if (reportOnly) return [`report schema validation failed: ${JSON.stringify(schemaErrors)}`];
    throw new InputError("EvaluationValidityValidation.v1 input validation failed.", { errors: schemaErrors });
  }
  const errors = [];
  const requestDigest = sha256Canonical(validation.request);
  if (validation.requestArtifact.digest !== requestDigest) errors.push("requestArtifact.digest does not match the canonical frozen request");
  if (validation.report.requestDigest !== requestDigest) errors.push("report.requestDigest does not match the canonical frozen request");
  const payload = { ...validation.report };
  delete payload.reportDigest;
  if (validation.report.reportDigest !== sha256Canonical(payload)) errors.push("reportDigest does not match the canonical report");
  try {
    const expected = await analyzeEvaluation(validation.request, options);
    if (canonicalJson(expected) !== canonicalJson(validation.report)) errors.push("report does not match the current request and artifact evidence");
  } catch (error) {
    if (error instanceof InputError) throw error;
    errors.push(`request cannot substantiate report: ${error instanceof Error ? error.message : String(error)}`);
  }
  return errors;
}

export function digestRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !validateRequestSchema(input)) {
    throw new InputError("EvaluationValidityRequest.v1 validation failed.", { errors: structuredClone(validateRequestSchema?.errors ?? []) });
  }
  return {
    schemaVersion: "1.0.0",
    artifactId: "evaluation-validity-request",
    digest: sha256Canonical(input),
  };
}

export const REQUIRED_CHECKS = { pre: PRE_CHECK_IDS, post: [...PRE_CHECK_IDS, ...POST_CHECK_IDS] };
