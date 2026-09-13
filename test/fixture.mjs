import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { analyzeEvaluation, sha256Canonical } from "../scripts/core.mjs";

const actor = {
  author: "11111111-1111-4111-8111-111111111111",
  auditor: "22222222-2222-4222-8222-222222222222",
  evaluator: "33333333-3333-4333-8333-333333333333",
  adjudicator: "44444444-4444-4444-8444-444444444444",
};

const rawDigest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "evaluation-validity-auditor-"));
  const contents = new Map([
    ["manifest", '{"caseId":"case-1","split":"legacy"}\n{"caseId":"case-2","split":"holdout"}\n'],
    ["labels", '{"caseId":"case-1","label":true}\n{"caseId":"case-2","label":false}\n'],
    ["rubric", JSON.stringify({ schemaVersion: "1.0.0", dimensions: ["correctness"] })],
    ["oracle", JSON.stringify({ schemaVersion: "1.0.0", kind: "semantic-adjudication" })],
    ["aggregation", JSON.stringify({ schemaVersion: "1.0.0", denominator: "all-expected-results", metrics: [{ metricId: "passRate", operation: "rate" }, { metricId: "quality", operation: "mean" }] })],
    ["thresholds", JSON.stringify({ schemaVersion: "1.0.0", passRate: 0.5 })],
    ["evidence", JSON.stringify({ schemaVersion: "1.0.0", source: "independent-review" })],
  ]);
  const filenames = {
    manifest: "corpus.jsonl",
    labels: "labels.jsonl",
    rubric: "rubric.json",
    oracle: "oracle.json",
    aggregation: "aggregation.json",
    thresholds: "thresholds.json",
    evidence: "evidence.json",
  };
  for (const [id, value] of contents) await writeFile(path.join(root, filenames[id]), value, "utf8");

  const digest = Object.fromEntries([...contents].map(([id, value]) => [id, rawDigest(value)]));
  const candidateDigest = rawDigest("candidate-v1");
  const controlArtifacts = [
    artifact("manifest", "corpus-manifest", filenames.manifest, digest.manifest, "jsonl", "pre-execution", ["author", "auditor", "evaluator"]),
    artifact("labels", "labels", filenames.labels, digest.labels, "jsonl", "post-execution", ["auditor", "adjudicator"]),
    artifact("rubric", "rubric", filenames.rubric, digest.rubric, "json", "pre-execution", ["author", "auditor", "evaluator", "adjudicator"]),
    artifact("oracle", "oracle", filenames.oracle, digest.oracle, "json", "pre-execution", ["auditor", "adjudicator"]),
    artifact("aggregation", "aggregation-policy", filenames.aggregation, digest.aggregation, "json", "pre-execution", ["author", "auditor", "evaluator"]),
    artifact("thresholds", "thresholds", filenames.thresholds, digest.thresholds, "json", "pre-execution", ["author", "auditor"]),
  ];
  const frameValue = {
    schemaVersion: "1.0.0",
    evaluationId: "eval-1",
    candidateDigest,
    corpusDigest: digest.manifest,
    runBudget: 2,
    artifactDigests: Object.fromEntries(controlArtifacts.map((item) => [item.artifactId, item.digest])),
  };
  const frameText = JSON.stringify(frameValue);
  await writeFile(path.join(root, "frame.json"), frameText, "utf8");
  digest.frame = rawDigest(frameText);
  const artifacts = [
    artifact("frame", "frame", "frame.json", digest.frame, "json", "pre-execution", ["author", "auditor", "evaluator"]),
    ...controlArtifacts,
    artifact("independent-evidence", "evidence", filenames.evidence, digest.evidence, "json", "pre-execution", ["auditor"]),
  ];
  const base = {
    schemaVersion: "1.0.0",
    auditId: "audit-pre-1",
    auditPhase: "pre-execution",
    auditedAt: "2026-01-01T00:00:00Z",
    auditRoot: root,
    target: {
      evaluationId: "eval-1",
      frameDigest: digest.frame,
      candidateDigest,
      corpusDigest: digest.manifest,
      revision: "revision-1",
      frameCreatedAt: "2025-12-31T23:00:00Z",
      executionStartedAt: "2026-01-02T00:00:00Z",
    },
    actors: {
      authorIds: [actor.author],
      auditorId: actor.auditor,
      evaluatorIds: [actor.evaluator],
      adjudicatorIds: [actor.adjudicator],
    },
    artifacts,
    inventory: {
      manifestArtifactId: "manifest",
      caseIdField: "caseId",
      splitField: "split",
      splitPolicy: "disjoint",
      expectedCaseCount: 2,
      expectedCaseIdsDigest: sha256Canonical(["case-1", "case-2"]),
      expectedRunIds: ["run-1", "run-2"],
      missingResultPolicy: "include-as-failure",
    },
    runs: [],
    semanticJudgments: [
      { checkId: "ORACLE_FIT", status: "PASS", auditorActorId: actor.auditor, evidenceRefs: ["oracle"], code: "SEMANTIC_ORACLE_SUPPORTED" },
      { checkId: "NON_SELF_REPORTED_EVIDENCE", status: "PASS", auditorActorId: actor.auditor, evidenceRefs: ["independent-evidence"], code: "INDEPENDENT_EVIDENCE_PRESENT" },
    ],
    knownLimitations: [],
  };
  return { root, base, digest, actor };
}

export async function makePostFixture() {
  const fixture = await makeFixture();
  const preReport = await analyzeEvaluation(fixture.base);
  const preflightText = JSON.stringify(preReport);
  const runText = '{"caseId":"case-1","metrics":{"passRate":true,"quality":0.8}}\n{"caseId":"case-2","metrics":{"passRate":false,"quality":0.6}}\n';
  const metrics = { passRate: 0.25, quality: 0.35 };
  const aggregateText = JSON.stringify({ evaluationId: "eval-1", frameDigest: fixture.digest.frame, metrics });
  await writeFile(path.join(fixture.root, "preflight.json"), preflightText, "utf8");
  await writeFile(path.join(fixture.root, "run-1.jsonl"), runText, "utf8");
  await writeFile(path.join(fixture.root, "aggregate.json"), aggregateText, "utf8");
  const post = structuredClone(fixture.base);
  post.auditId = "audit-post-1";
  post.auditPhase = "post-execution";
  post.auditedAt = "2026-01-03T00:00:00Z";
  post.artifacts.push(
    artifact("preflight", "preflight-report", "preflight.json", rawDigest(preflightText), "json", "pre-execution", ["auditor"]),
    artifact("run-1-output", "run-output", "run-1.jsonl", rawDigest(runText), "jsonl", "post-execution", ["auditor", "adjudicator"]),
    artifact("aggregate-report", "aggregate-report", "aggregate.json", rawDigest(aggregateText), "json", "post-execution", ["auditor", "adjudicator"]),
  );
  post.runs = [
    { runId: "run-1", status: "completed", resultArtifactId: "run-1-output" },
    { runId: "run-2", status: "failed", resultArtifactId: null },
  ];
  return { ...fixture, post, preReport, metrics };
}

function artifact(artifactId, kind, locator, digest, format, availability, visibleToRoles) {
  return { artifactId, kind, locator, digest, format, availability, visibleToRoles, verified: true };
}
