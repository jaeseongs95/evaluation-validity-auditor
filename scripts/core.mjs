import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { validateReportSchema, validateRequestSchema, validateValidationSchema } from "./schema-validation.mjs";

const PRE_CHECKS = [
  "FRAME_FROZEN",
  "TARGET_BOUND",
  "CORPUS_INVENTORY_VALID",
  "SPLIT_POLICY_VALID",
  "LABELS_HIDDEN",
  "RUBRIC_FROZEN",
  "AGGREGATION_FROZEN",
  "ROLE_INDEPENDENCE",
  "AUDITED_BEFORE_EXECUTION",
  "ORACLE_FIT",
  "NON_SELF_REPORTED_EVIDENCE",
];

const POST_CHECKS = [
  "PREFLIGHT_REPORT_BOUND",
  "RUN_SET_COMPLETE",
  "CASE_SET_COMPLETE",
  "FAILURES_PRESERVED",
  "NO_POSTHOC_CONTROL_CHANGE",
  "AGGREGATE_RECOMPUTED",
  "PUBLISHED_METRICS_MATCH",
];

const REQUIRED_CONTROL_KINDS = [
  "frame",
  "corpus-manifest",
  "labels",
  "rubric",
  "oracle",
  "aggregation-policy",
  "thresholds",
];

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
  return { checkId, status, code, evidenceRefs: [...new Set(evidenceRefs)] };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function inspectArtifacts(input) {
  const root = await realpath(path.resolve(input.auditRoot));
  const states = new Map();
  for (const artifact of input.artifacts) {
    if (states.has(artifact.artifactId)) throw new InputError(`Duplicate artifact ID: ${artifact.artifactId}`);
    if (path.isAbsolute(artifact.locator)) throw new InputError(`Artifact locator must be relative: ${artifact.artifactId}`);
    const candidate = path.resolve(root, artifact.locator);
    if (!isWithin(root, candidate)) throw new InputError(`Artifact locator escapes auditRoot: ${artifact.artifactId}`);
    try {
      const resolved = await realpath(candidate);
      if (!isWithin(root, resolved)) throw new InputError(`Artifact symlink escapes auditRoot: ${artifact.artifactId}`);
      const bytes = await readFile(resolved);
      states.set(artifact.artifactId, {
        artifact,
        exists: true,
        digestMatches: sha256Raw(bytes) === artifact.digest,
        bytes,
      });
    } catch (error) {
      if (error instanceof InputError) throw error;
      states.set(artifact.artifactId, { artifact, exists: false, digestMatches: false, bytes: null });
    }
  }
  return { root, states };
}

function byKind(states, kind) {
  return [...states.values()].filter((state) => state.artifact.kind === kind);
}

function currentEvidence(states) {
  return [...states.values()]
    .filter((state) => state.exists && state.digestMatches && state.artifact.verified)
    .map((state) => ({
      artifactId: state.artifact.artifactId,
      kind: state.artifact.kind,
      locator: state.artifact.locator.replaceAll("\\", "/"),
      digest: state.artifact.digest,
    }))
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
}

function parseJson(state, label) {
  if (!state?.exists || !state.bytes) throw new InputError(`${label} is missing.`);
  if (state.artifact.format !== "json") throw new InputError(`${label} must use JSON format.`);
  const value = JSON.parse(state.bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError(`${label} must contain a JSON object.`);
  return value;
}

function parseJsonl(state, label) {
  if (!state?.exists || !state.bytes) throw new InputError(`${label} is missing.`);
  if (state.artifact.format !== "jsonl") throw new InputError(`${label} must use JSONL format.`);
  const text = state.bytes.toString("utf8");
  const records = text.split(/\r?\n/u).filter((line) => line.length > 0).map((line) => JSON.parse(line));
  if (records.some((record) => !record || typeof record !== "object" || Array.isArray(record))) {
    throw new InputError(`${label} must contain one JSON object per line.`);
  }
  return records;
}

function artifactHealth(state) {
  if (!state?.exists) return ["INSUFFICIENT_EVIDENCE", "ARTIFACT_MISSING"];
  if (!state.artifact.verified) return ["INSUFFICIENT_EVIDENCE", "ARTIFACT_UNVERIFIED"];
  if (!state.digestMatches) return ["FAIL", "DIGEST_MISMATCH"];
  return ["PASS", "CHECK_PASSED"];
}

function oneKind(states, kind) {
  const matches = byKind(states, kind);
  return matches.length === 1 ? matches[0] : null;
}

function parseManifest(state, input) {
  const records = parseJsonl(state, "corpus manifest");
  const ids = records.map((record) => record[input.inventory.caseIdField]);
  const validIds = ids.every((id) => typeof id === "string" && id.length > 0);
  const duplicate = validIds && new Set(ids).size !== ids.length;
  const countMatches = records.length === input.inventory.expectedCaseCount;
  const digestMatches = validIds && sha256Canonical(ids) === input.inventory.expectedCaseIdsDigest;
  const splitCounts = {};
  let splitValid = true;
  if (input.inventory.splitPolicy === "none") {
    splitValid = input.inventory.splitField === null;
  } else {
    splitValid = typeof input.inventory.splitField === "string";
    if (splitValid) {
      for (const record of records) {
        const split = record[input.inventory.splitField];
        if (typeof split !== "string" || split.length === 0) {
          splitValid = false;
          continue;
        }
        splitCounts[split] = (splitCounts[split] ?? 0) + 1;
      }
    }
  }
  return { records, ids, validIds, duplicate, countMatches, digestMatches, splitCounts, splitValid };
}

function structuralPreChecks(input, states) {
  const checks = [];
  const evidence = (kind) => byKind(states, kind).map((state) => state.artifact.artifactId);
  const uniqueKinds = REQUIRED_CONTROL_KINDS.every((kind) => byKind(states, kind).length === 1);
  const controlStates = REQUIRED_CONTROL_KINDS.flatMap((kind) => byKind(states, kind));
  const missing = !uniqueKinds || controlStates.some((state) => !state.exists);
  const unverified = controlStates.some((state) => state.exists && !state.artifact.verified);
  const changed = controlStates.some((state) => state.exists && !state.digestMatches);
  let frame = null;
  let frameValid = false;
  const frameState = oneKind(states, "frame");
  if (frameState?.exists && frameState.digestMatches && frameState.artifact.verified && frameState.artifact.format === "json") {
    try {
      frame = parseJson(frameState, "evaluation frame");
      const bound = Object.fromEntries(input.artifacts
        .filter((artifact) => REQUIRED_CONTROL_KINDS.includes(artifact.kind) && artifact.kind !== "frame")
        .map((artifact) => [artifact.artifactId, artifact.digest]));
      frameValid = frame.schemaVersion === "1.0.0"
        && frame.evaluationId === input.target.evaluationId
        && frame.candidateDigest === input.target.candidateDigest
        && frame.corpusDigest === input.target.corpusDigest
        && frame.runBudget === input.inventory.expectedRunIds.length
        && canonicalJson(frame.artifactDigests) === canonicalJson(bound);
    } catch {
      frameValid = false;
    }
  }
  const frameStatus = missing
    ? check("FRAME_FROZEN", "INSUFFICIENT_EVIDENCE", "ARTIFACT_MISSING", controlStates.map((state) => state.artifact.artifactId))
    : unverified ? check("FRAME_FROZEN", "INSUFFICIENT_EVIDENCE", "ARTIFACT_UNVERIFIED", controlStates.map((state) => state.artifact.artifactId))
    : changed ? check("FRAME_FROZEN", "FAIL", "DIGEST_MISMATCH", controlStates.map((state) => state.artifact.artifactId))
      : frameValid ? check("FRAME_FROZEN", "PASS", "CHECK_PASSED", controlStates.map((state) => state.artifact.artifactId))
        : check("FRAME_FROZEN", "FAIL", "FRAME_BINDING_INVALID", evidence("frame"));
  checks.push(frameStatus);

  const manifestState = oneKind(states, "corpus-manifest");
  const targetBound = frameState?.digestMatches && frameState.artifact.digest === input.target.frameDigest
    && manifestState?.digestMatches && manifestState.artifact.digest === input.target.corpusDigest
    && manifestState.artifact.artifactId === input.inventory.manifestArtifactId;
  checks.push(targetBound
    ? check("TARGET_BOUND", "PASS", "CHECK_PASSED", [...evidence("frame"), ...evidence("corpus-manifest")])
    : check("TARGET_BOUND", "FAIL", "FRAME_BINDING_INVALID", [...evidence("frame"), ...evidence("corpus-manifest")]));

  let manifest = null;
  try {
    manifest = manifestState?.digestMatches && manifestState.artifact.verified ? parseManifest(manifestState, input) : null;
  } catch {
    manifest = null;
  }
  const inventoryCode = !manifest ? "ARTIFACT_MISSING"
    : manifest.duplicate ? "CASE_DUPLICATE"
      : !manifest.countMatches ? "CASE_COUNT_MISMATCH"
        : !manifest.digestMatches ? "CASE_ID_DIGEST_MISMATCH" : "CHECK_PASSED";
  checks.push(check("CORPUS_INVENTORY_VALID", inventoryCode === "CHECK_PASSED" ? "PASS" : inventoryCode === "ARTIFACT_MISSING" ? "INSUFFICIENT_EVIDENCE" : "FAIL", inventoryCode, evidence("corpus-manifest")));
  checks.push(check("SPLIT_POLICY_VALID", manifest?.splitValid ? "PASS" : manifest ? "FAIL" : "INSUFFICIENT_EVIDENCE", manifest?.splitValid ? "CHECK_PASSED" : manifest ? "SPLIT_POLICY_INVALID" : "ARTIFACT_MISSING", evidence("corpus-manifest")));

  const labels = oneKind(states, "labels");
  const labelsHealthy = labels?.exists && labels.digestMatches && labels.artifact.verified;
  const labelsHidden = labelsHealthy && labels.artifact.availability === "post-execution" && !labels.artifact.visibleToRoles.includes("evaluator");
  checks.push(check("LABELS_HIDDEN", !labelsHealthy ? "INSUFFICIENT_EVIDENCE" : labelsHidden ? "PASS" : "FAIL", !labelsHealthy ? "ARTIFACT_MISSING" : labelsHidden ? "CHECK_PASSED" : "LABEL_LEAKAGE", evidence("labels")));

  for (const [checkId, kind] of [["RUBRIC_FROZEN", "rubric"], ["AGGREGATION_FROZEN", "aggregation-policy"]]) {
    const state = oneKind(states, kind);
    const [status, code] = artifactHealth(state);
    let effectiveStatus = status;
    let effectiveCode = code;
    if (status === "PASS" && kind === "aggregation-policy") {
      try {
        const policy = parseJson(state, "aggregation policy");
        const metrics = policy.metrics;
        const ids = Array.isArray(metrics) ? metrics.map((metric) => metric.metricId) : [];
        const valid = policy.schemaVersion === "1.0.0" && policy.denominator === "all-expected-results"
          && Array.isArray(metrics) && metrics.length > 0 && new Set(ids).size === ids.length
          && metrics.every((metric) => metric && typeof metric.metricId === "string" && ["rate", "mean", "sum"].includes(metric.operation));
        if (!valid) { effectiveStatus = "FAIL"; effectiveCode = "AGGREGATION_INVALID"; }
      } catch { effectiveStatus = "FAIL"; effectiveCode = "AGGREGATION_INVALID"; }
    }
    checks.push(check(checkId, effectiveStatus, effectiveStatus === "PASS" ? "CHECK_PASSED" : effectiveCode === "DIGEST_MISMATCH" ? "CONTROL_NOT_FROZEN" : effectiveCode, evidence(kind)));
  }

  const auditor = input.actors.auditorId;
  const producers = [...input.actors.authorIds, ...input.actors.evaluatorIds, ...input.actors.adjudicatorIds];
  const independent = input.actors.authorIds.length > 0 && input.actors.evaluatorIds.length > 0
    && !producers.includes(auditor)
    && input.actors.evaluatorIds.every((id) => !input.actors.adjudicatorIds.includes(id));
  checks.push(check("ROLE_INDEPENDENCE", independent ? "PASS" : "FAIL", independent ? "CHECK_PASSED" : "ROLE_CONFLICT"));

  const executionStart = input.target.executionStartedAt;
  if (input.auditPhase === "pre-execution") {
    const frameWasFrozen = Date.parse(input.target.frameCreatedAt) <= Date.parse(input.auditedAt);
    const timely = executionStart === null || Date.parse(input.auditedAt) <= Date.parse(executionStart);
    checks.push(check("AUDITED_BEFORE_EXECUTION", frameWasFrozen && timely ? "PASS" : "FAIL", !frameWasFrozen ? "FRAME_CREATED_AFTER_AUDIT" : timely ? "CHECK_PASSED" : "AUDIT_AFTER_EXECUTION"));
  } else {
    const preflightState = oneKind(states, "preflight-report");
    let preflight = null;
    try { preflight = parseJson(preflightState, "preflight report"); } catch { preflight = null; }
    const preflightTiming = preflightState?.digestMatches && preflightState.artifact.verified
      && preflight && validateReportSchema(preflight) && preflight.auditPhase === "pre-execution"
      && sameTarget(preflight, input)
      && preflight.checks.some((item) => item.checkId === "AUDITED_BEFORE_EXECUTION" && item.status === "PASS")
      && (executionStart === null || Date.parse(preflight.auditedAt) <= Date.parse(executionStart));
    checks.push(check("AUDITED_BEFORE_EXECUTION", preflightTiming ? "PASS" : preflight ? "FAIL" : "INSUFFICIENT_EVIDENCE", preflightTiming ? "CHECK_PASSED" : preflight ? "PREFLIGHT_REPORT_INVALID" : "ARTIFACT_MISSING", evidence("preflight-report")));
  }

  const artifactIds = new Set(input.artifacts.map((artifact) => artifact.artifactId));
  for (const checkId of ["ORACLE_FIT", "NON_SELF_REPORTED_EVIDENCE"]) {
    const judgments = input.semanticJudgments.filter((item) => item.checkId === checkId);
    if (judgments.length !== 1) {
      checks.push(check(checkId, "INSUFFICIENT_EVIDENCE", "EVIDENCE_MISSING"));
      continue;
    }
    const judgment = judgments[0];
    const allowedCodes = checkId === "ORACLE_FIT"
      ? { PASS: ["SEMANTIC_ORACLE_SUPPORTED", "LEXICAL_ORACLE_SCOPE_ONLY"], FAIL: ["SEMANTIC_ORACLE_INADEQUATE"], INSUFFICIENT_EVIDENCE: ["EVIDENCE_MISSING"], NEEDS_INPUT: ["POLICY_AMBIGUOUS"] }
      : { PASS: ["INDEPENDENT_EVIDENCE_PRESENT"], FAIL: ["SELF_REPORT_ONLY"], INSUFFICIENT_EVIDENCE: ["EVIDENCE_MISSING"], NEEDS_INPUT: ["POLICY_AMBIGUOUS"] };
    const bound = judgment.auditorActorId === auditor && judgment.evidenceRefs.every((ref) => artifactIds.has(ref) && states.get(ref)?.artifact.verified && states.get(ref)?.digestMatches);
    const coherent = allowedCodes[judgment.status]?.includes(judgment.code);
    checks.push(bound && coherent ? check(checkId, judgment.status, judgment.code, judgment.evidenceRefs) : check(checkId, bound ? "FAIL" : "INSUFFICIENT_EVIDENCE", bound ? "POLICY_AMBIGUOUS" : "EVIDENCE_MISSING", judgment.evidenceRefs));
  }
  return { checks, manifest, frame };
}

function reportTarget(input) {
  return {
    evaluationId: input.target.evaluationId,
    frameDigest: input.target.frameDigest,
    candidateDigest: input.target.candidateDigest,
    corpusDigest: input.target.corpusDigest,
    revision: input.target.revision,
  };
}

function sameTarget(report, input) {
  return canonicalJson(report.target) === canonicalJson(reportTarget(input));
}

function resultRecordsForRun(states, run) {
  if (run.status !== "completed" || !run.resultArtifactId) return null;
  const state = states.get(run.resultArtifactId);
  if (!state || state.artifact.kind !== "run-output" || !state.artifact.verified || !state.digestMatches) return null;
  try { return parseJsonl(state, `run ${run.runId} output`); } catch { return null; }
}

function recomputeMetrics(policy, expectedRunIds, expectedCaseIds, recordsByRun, missingPolicy) {
  const slots = expectedRunIds.flatMap((runId) => expectedCaseIds.map((caseId) => recordsByRun.get(runId)?.get(caseId) ?? null));
  if (missingPolicy === "reject-incomplete" && slots.some((record) => record === null)) return null;
  const metrics = {};
  for (const metric of policy.metrics) {
    let total = 0;
    for (const record of slots) {
      if (!record) continue;
      const value = record.metrics?.[metric.metricId];
      if (metric.operation === "rate") {
        if (value === true || value === 1) total += 1;
        else if (value !== false && value !== 0) return null;
      } else {
        if (typeof value !== "number" || !Number.isFinite(value)) return null;
        total += value;
      }
    }
    metrics[metric.metricId] = metric.operation === "sum" ? total : total / slots.length;
  }
  return metrics;
}

function postChecks(input, states, pre, expectedCaseIds) {
  const checks = [];
  const evidence = (kind) => byKind(states, kind).map((state) => state.artifact.artifactId);
  const preflightState = oneKind(states, "preflight-report");
  let preflight = null;
  try { preflight = parseJson(preflightState, "preflight report"); } catch { preflight = null; }
  const preflightValid = preflightState?.digestMatches && preflightState.artifact.verified
    && preflight && validateReportSchema(preflight) && preflight.verdict === "PASS"
    && preflight.auditPhase === "pre-execution" && sameTarget(preflight, input)
    && preflight.reportDigest === sha256Canonical(Object.fromEntries(Object.entries(preflight).filter(([key]) => key !== "reportDigest")));
  checks.push(check("PREFLIGHT_REPORT_BOUND", preflightValid ? "PASS" : preflight ? "FAIL" : "INSUFFICIENT_EVIDENCE", preflightValid ? "CHECK_PASSED" : preflight ? "PREFLIGHT_REPORT_INVALID" : "ARTIFACT_MISSING", evidence("preflight-report")));

  const expectedRuns = input.inventory.expectedRunIds;
  const actualRunIds = input.runs.map((run) => run.runId);
  const runDuplicate = new Set(actualRunIds).size !== actualRunIds.length;
  const runSetComplete = !runDuplicate && canonicalJson([...actualRunIds].sort()) === canonicalJson([...expectedRuns].sort());
  checks.push(check("RUN_SET_COMPLETE", runSetComplete ? "PASS" : "FAIL", runSetComplete ? "CHECK_PASSED" : runDuplicate ? "RUN_DUPLICATE" : "RUN_SET_INCOMPLETE", input.runs.map((run) => run.resultArtifactId).filter(Boolean)));
  checks.push(check("FAILURES_PRESERVED", runSetComplete ? "PASS" : "FAIL", runSetComplete ? "CHECK_PASSED" : "FAILURE_OMITTED"));

  const recordsByRun = new Map();
  let parseComplete = true;
  let caseComplete = runSetComplete;
  let observedCaseCount = 0;
  for (const run of input.runs) {
    const records = resultRecordsForRun(states, run);
    if (run.status === "completed" && !records) { parseComplete = false; caseComplete = false; continue; }
    if (!records) {
      if (input.inventory.missingResultPolicy === "reject-incomplete") caseComplete = false;
      recordsByRun.set(run.runId, new Map());
      continue;
    }
    const ids = records.map((record) => record.caseId);
    const unique = ids.every((id) => typeof id === "string" && id.length > 0) && new Set(ids).size === ids.length;
    const exact = unique && canonicalJson([...ids].sort()) === canonicalJson([...expectedCaseIds].sort());
    if (!exact) caseComplete = false;
    observedCaseCount += records.length;
    recordsByRun.set(run.runId, new Map(records.map((record) => [record.caseId, record])));
  }
  checks.push(check("CASE_SET_COMPLETE", caseComplete ? "PASS" : parseComplete ? "FAIL" : "FAIL", caseComplete ? "CHECK_PASSED" : parseComplete ? "RESULT_SET_INCOMPLETE" : "RESULT_PARSE_FAILED", evidence("run-output")));

  const controlChanged = pre.checks.slice(0, PRE_CHECKS.length).some((item) => ["DIGEST_MISMATCH", "CONTROL_NOT_FROZEN", "FRAME_BINDING_INVALID"].includes(item.code));
  checks.push(check("NO_POSTHOC_CONTROL_CHANGE", controlChanged ? "FAIL" : "PASS", controlChanged ? "CONTROL_CHANGED" : "CHECK_PASSED", REQUIRED_CONTROL_KINDS.flatMap((kind) => evidence(kind))));

  let metrics = null;
  let published = null;
  const policyState = oneKind(states, "aggregation-policy");
  const aggregateState = oneKind(states, "aggregate-report");
  try {
    const policy = parseJson(policyState, "aggregation policy");
    metrics = caseComplete && parseComplete ? recomputeMetrics(policy, expectedRuns, expectedCaseIds, recordsByRun, input.inventory.missingResultPolicy) : null;
  } catch { metrics = null; }
  checks.push(check("AGGREGATE_RECOMPUTED", metrics ? "PASS" : "FAIL", metrics ? "CHECK_PASSED" : "AGGREGATION_INVALID", [...evidence("aggregation-policy"), ...evidence("run-output")]));
  try {
    const aggregate = parseJson(aggregateState, "aggregate report");
    if (aggregateState.digestMatches && aggregateState.artifact.verified && aggregate.evaluationId === input.target.evaluationId
      && aggregate.frameDigest === input.target.frameDigest && aggregate.metrics && typeof aggregate.metrics === "object") published = aggregate.metrics;
  } catch { published = null; }
  const metricsMatch = metrics && published && canonicalJson(metrics) === canonicalJson(published);
  checks.push(check("PUBLISHED_METRICS_MATCH", metricsMatch ? "PASS" : published ? "FAIL" : "INSUFFICIENT_EVIDENCE", metricsMatch ? "CHECK_PASSED" : published ? "PUBLISHED_METRICS_MISMATCH" : "ARTIFACT_MISSING", evidence("aggregate-report")));
  return { checks, observedCaseCount, metrics: metrics ?? {}, published };
}

function verdictFor(checks) {
  if (checks.some((item) => item.status === "FAIL")) return "FAIL";
  if (checks.some((item) => item.status === "NEEDS_INPUT")) return "NEEDS_INPUT";
  if (checks.some((item) => item.status === "INSUFFICIENT_EVIDENCE")) return "BLOCKED";
  return "PASS";
}

export async function analyzeEvaluation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !validateRequestSchema(input)) {
    throw new InputError("EvaluationAuditRequest.v1 validation failed.", { errors: structuredClone(validateRequestSchema?.errors ?? []) });
  }
  const { states } = await inspectArtifacts(input);
  const pre = structuralPreChecks(input, states);
  let checks = pre.checks;
  let observedCaseCount = pre.manifest?.records.length ?? 0;
  let metrics = {};
  let published = null;
  if (input.auditPhase === "pre-execution") {
    if (input.runs.length !== 0) throw new InputError("pre-execution requests must not contain runs.");
  } else {
    const expectedCaseIds = pre.manifest?.ids?.filter((id) => typeof id === "string") ?? [];
    const post = postChecks(input, states, pre, expectedCaseIds);
    checks = [...checks, ...post.checks];
    observedCaseCount = post.observedCaseCount;
    metrics = post.metrics;
    published = post.published;
  }
  const verdict = verdictFor(checks);
  const blockingCodes = [...new Set(checks.filter((item) => item.status !== "PASS").map((item) => item.code))];
  const report = {
    schemaVersion: "1.0.0",
    auditId: input.auditId,
    auditPhase: input.auditPhase,
    auditedAt: input.auditedAt,
    auditorActorId: input.actors.auditorId,
    target: reportTarget(input),
    checks,
    inventory: {
      expectedCaseCount: input.inventory.expectedCaseCount,
      observedCaseCount,
      expectedRunCount: input.inventory.expectedRunIds.length,
      observedRunCount: input.runs.length,
      splitCounts: pre.manifest?.splitCounts ?? {},
    },
    recomputedMetrics: metrics,
    recomputedMetricsDigest: input.auditPhase === "post-execution" && Object.keys(metrics).length > 0 ? sha256Canonical(metrics) : null,
    publishedMetricsDigest: input.auditPhase === "post-execution" && published ? sha256Canonical(published) : null,
    verifiedEvidenceIndex: currentEvidence(states),
    blockingCodes,
    limitations: [...new Set([...input.knownLimitations, "CALLER_TRUSTED_ACTOR_IDENTITIES", "JSON_JSONL_ONLY_V1"])],
    verdict,
  };
  const complete = { ...report, reportDigest: sha256Canonical(report) };
  if (!validateReportSchema(complete)) throw new InputError("Generated report does not satisfy EvaluationValidityReport.v1.", { errors: structuredClone(validateReportSchema.errors) });
  return complete;
}

export async function validateReport(validation) {
  const errors = [];
  if (!validateValidationSchema(validation)) {
    return [`validation envelope schema validation failed: ${JSON.stringify(validateValidationSchema.errors)}`];
  }
  const expectedRequestDigest = sha256Canonical(validation.request);
  if (validation.requestArtifact.digest !== expectedRequestDigest) errors.push("requestArtifact.digest does not match the canonical frozen request");
  const reportPayload = { ...validation.report };
  delete reportPayload.reportDigest;
  if (validation.report.reportDigest !== sha256Canonical(reportPayload)) errors.push("reportDigest does not match the canonical report");
  if (!validateReportSchema(validation.report)) errors.push(`report schema validation failed: ${JSON.stringify(validateReportSchema.errors)}`);
  try {
    const expected = await analyzeEvaluation(validation.request);
    if (canonicalJson(expected) !== canonicalJson(validation.report)) errors.push("report does not match the current request and artifact evidence");
  } catch (error) {
    errors.push(`request cannot substantiate report: ${error instanceof Error ? error.message : String(error)}`);
  }
  return errors;
}

export function summarizeReport(report) {
  return {
    schemaVersion: "1.0.0",
    auditPhase: report.auditPhase,
    auditorActorId: report.auditorActorId,
    targetDigest: report.target.frameDigest,
    reportDigest: report.reportDigest,
    verdict: report.verdict,
    blockingCodes: report.blockingCodes,
  };
}

export const REQUIRED_CHECKS = { pre: PRE_CHECKS, post: [...PRE_CHECKS, ...POST_CHECKS] };
