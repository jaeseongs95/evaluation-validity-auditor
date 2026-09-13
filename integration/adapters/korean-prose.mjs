#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { analyzeEvaluation, canonicalJson, InputError, sha256Canonical } from "../../scripts/core.mjs";
import { readJsonArgument, writeJson } from "../../scripts/io.mjs";
import { validateKoreanProseSchema } from "../../scripts/schema-validation.mjs";

function passed(report, checkId) {
  return report.checks.find((item) => item.checkId === checkId)?.status === "PASS";
}

function mappedStatus(report, mappedChecks) {
  if (report.verdict === "FAIL") return "invalid";
  if (report.verdict !== "PASS" || Object.values(mappedChecks).some((value) => value !== true)) return "insufficient-evidence";
  return "valid";
}

export async function adaptKoreanProse(envelope) {
  if (!envelope || envelope.schemaVersion !== "1.0.0" || !envelope.request || !envelope.report) {
    throw new InputError("Korean prose adapter requires schemaVersion, request, and report.");
  }
  if (envelope.request.auditPhase !== "pre-execution" || envelope.report.auditPhase !== "pre-execution") {
    throw new InputError("Korean prose compatibility accepts pre-execution audits only.");
  }
  const expected = await analyzeEvaluation(envelope.request);
  if (canonicalJson(expected) !== canonicalJson(envelope.report)) {
    throw new InputError("The report is not reproducible from the supplied request and evidence.");
  }
  const { actors, target, inventory } = envelope.request;
  if (actors.authorIds.length === 0 || actors.adjudicatorIds.length === 0) {
    throw new InputError("The Korean prose contract requires an author and adjudicator actor.");
  }
  if (target.executionStartedAt === null) {
    throw new InputError("The Korean prose contract requires a scheduled executionStartedAt timestamp.");
  }
  const splitCounts = envelope.report.inventory.splitCounts;
  if (!Number.isInteger(splitCounts.legacy) || !Number.isInteger(splitCounts.holdout)) {
    throw new InputError("The Korean prose contract requires legacy and holdout strata.");
  }
  const mappedChecks = {
    sourceAuthoritative: passed(envelope.report, "FRAME_FROZEN") && passed(envelope.report, "TARGET_BOUND"),
    noDuplicateCases: passed(envelope.report, "CORPUS_INVENTORY_VALID"),
    noCorpusOverlap: passed(envelope.report, "SPLIT_POLICY_VALID"),
    strataComplete: splitCounts.legacy + splitCounts.holdout === inventory.expectedCaseCount,
    auditedBeforeExecution: passed(envelope.report, "AUDITED_BEFORE_EXECUTION"),
  };
  const evidence = envelope.report.verifiedEvidenceIndex.map((item) => ({
    locator: item.locator,
    digest: item.digest,
    verified: true,
  }));
  if (evidence.length === 0) throw new InputError("The Korean prose contract requires verified evidence.");
  const output = {
    schemaVersion: "1.0.0",
    frameId: target.evaluationId,
    frameDigest: target.frameDigest,
    corpusDigest: target.corpusDigest,
    status: mappedStatus(envelope.report, mappedChecks),
    auditedAt: envelope.report.auditedAt,
    executionStartedAt: target.executionStartedAt,
    actors: {
      author: actors.authorIds[0],
      auditor: actors.auditorId,
      adjudicator: actors.adjudicatorIds[0],
    },
    checks: mappedChecks,
    strataCounts: {
      legacyCount: splitCounts.legacy,
      holdoutCount: splitCounts.holdout,
    },
    evidence,
  };
  const complete = { ...output, reportDigest: sha256Canonical(output) };
  if (!validateKoreanProseSchema(complete)) {
    throw new InputError("Mapped report does not satisfy the Korean prose contract.", { errors: structuredClone(validateKoreanProseSchema.errors) });
  }
  return complete;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    writeJson(await adaptKoreanProse(await readJsonArgument(process.argv.slice(2))));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ schemaVersion: "1.0.0", error: { code: "INVALID_INPUT", message: error instanceof Error ? error.message : String(error), details: error instanceof InputError ? error.details : null } }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
