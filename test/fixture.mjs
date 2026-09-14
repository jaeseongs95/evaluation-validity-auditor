import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const actor = {
  author: "11111111-1111-4111-8111-111111111111",
  executor: "22222222-2222-4222-8222-222222222222",
  judge: "33333333-3333-4333-8333-333333333333",
  auditor: "44444444-4444-4444-8444-444444444444",
};

export const rawDigest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "evaluation-validity-auditor-"));
  const contents = new Map([
    ["manifest", '{"schemaVersion":"1.0.0","caseId":"case-1","split":"validation"}\n{"schemaVersion":"1.0.0","caseId":"case-2","split":"holdout"}\n'],
    ["rubric", JSON.stringify({ schemaVersion: "1.0.0", criteria: ["semantic-quality", "exact-output"] })],
    ["oracle", JSON.stringify({ schemaVersion: "1.0.0", kinds: ["independent-review", "lexical-match"] })],
    ["aggregation", JSON.stringify({ schemaVersion: "1.0.0", denominator: "all-expected-records", metricIds: ["semantic-pass-rate", "exact-pass-rate"] })],
    ["timing", JSON.stringify({ schemaVersion: "1.0.0", receipt: "frozen-before-execution" })],
    ["evidence", JSON.stringify({ schemaVersion: "1.0.0", source: "independent-review" })],
  ]);
  const filenames = {
    manifest: "fixture-manifest.jsonl",
    rubric: "rubric.json",
    oracle: "oracle.json",
    aggregation: "aggregation.json",
    timing: "timing.json",
    evidence: "evidence.json",
  };
  for (const [id, value] of contents) await writeFile(path.join(root, filenames[id]), value, "utf8");
  const digest = Object.fromEntries([...contents].map(([id, value]) => [id, rawDigest(value)]));
  const artifacts = [
    artifact("fixture-manifest", "fixture-manifest", filenames.manifest, digest.manifest, "jsonl", ["author", "executor", "judge", "auditor"]),
    artifact("rubric", "rubric", filenames.rubric, digest.rubric, "json", ["author", "executor", "judge", "auditor"]),
    artifact("oracle", "oracle", filenames.oracle, digest.oracle, "json", ["judge", "auditor"]),
    artifact("aggregation-rule", "aggregation-rule", filenames.aggregation, digest.aggregation, "json", ["author", "auditor"]),
    artifact("timing-evidence", "timing-evidence", filenames.timing, digest.timing, "json", ["auditor"]),
    artifact("independent-evidence", "evidence", filenames.evidence, digest.evidence, "json", ["judge", "auditor"]),
  ];
  const base = {
    schemaVersion: "1.0.0",
    auditId: "audit-pre-1",
    auditStage: "pre-execution",
    auditedAt: "2026-01-01T00:00:00Z",
    target: {
      evaluationId: "eval-1",
      identifier: "candidate-1",
      revision: "revision-1",
      digest: rawDigest("candidate-v1"),
    },
    frozenAt: "2025-12-31T22:00:00Z",
    executionStartedAt: "2026-01-02T00:00:00Z",
    actors: {
      authorIds: [actor.author],
      executorIds: [actor.executor],
      judgeIds: [actor.judge],
      auditorId: actor.auditor,
    },
    artifacts,
    expected: {
      caseIds: ["case-1", "case-2"],
      runIds: ["run-1", "run-2"],
      criterionIds: ["semantic-quality", "exact-output"],
    },
    criteria: [
      {
        criterionId: "semantic-quality",
        kind: "semantic",
        judgmentMethods: ["independent-review", "self-report"],
        oracleArtifactId: "oracle",
        evidenceRefs: ["independent-evidence"],
      },
      {
        criterionId: "exact-output",
        kind: "deterministic",
        judgmentMethods: ["lexical-match"],
        oracleArtifactId: "oracle",
        evidenceRefs: ["oracle"],
      },
    ],
    metrics: [
      {
        metricId: "semantic-pass-rate",
        criterionId: "semantic-quality",
        operation: "rate",
        denominator: "all-expected-records",
        numeratorOutcomes: ["PASS"],
        comparator: ">=",
        threshold: 0.25,
        claimedValue: null,
      },
      {
        metricId: "exact-pass-rate",
        criterionId: "exact-output",
        operation: "rate",
        denominator: "all-expected-records",
        numeratorOutcomes: ["PASS"],
        comparator: ">=",
        threshold: 0.5,
        claimedValue: null,
      },
    ],
    runs: [],
    knownLimitations: [],
  };
  return { root, base, digest, actor };
}

export async function makePostFixture() {
  const fixture = await makeFixture();
  const resultRecords = [
    result("case-1", "run-1", "semantic-quality", "PASS", fixture.actor.judge, "independent-review", "independent-evidence"),
    result("case-1", "run-1", "exact-output", "PASS", fixture.actor.judge, "lexical-match", "oracle"),
    result("case-2", "run-1", "semantic-quality", "FAIL", fixture.actor.judge, "independent-review", "independent-evidence"),
    result("case-2", "run-1", "exact-output", "PASS", fixture.actor.judge, "lexical-match", "oracle"),
  ];
  const resultText = `${resultRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const metrics = [
    { metricId: "semantic-pass-rate", numerator: 1, denominator: 4, value: 0.25, comparator: ">=", threshold: 0.25, passed: true },
    { metricId: "exact-pass-rate", numerator: 2, denominator: 4, value: 0.5, comparator: ">=", threshold: 0.5, passed: true },
  ];
  const aggregateText = JSON.stringify({ schemaVersion: "1.0.0", evaluationId: "eval-1", targetDigest: fixture.base.target.digest, metrics });
  await writeFile(path.join(fixture.root, "run-1.jsonl"), resultText, "utf8");
  await writeFile(path.join(fixture.root, "aggregate.json"), aggregateText, "utf8");
  const post = structuredClone(fixture.base);
  post.auditId = "audit-post-1";
  post.auditStage = "post-execution";
  post.auditedAt = "2026-01-03T00:00:00Z";
  post.metrics[0].claimedValue = 0.25;
  post.metrics[1].claimedValue = 0.5;
  post.artifacts.push(
    artifact("run-1-results", "result-records", "run-1.jsonl", rawDigest(resultText), "jsonl", ["judge", "auditor"], "2026-01-02T01:00:00Z"),
    artifact("aggregate-claim", "aggregate-claim", "aggregate.json", rawDigest(aggregateText), "json", ["auditor"], "2026-01-02T02:00:00Z"),
  );
  post.runs = [
    { runId: "run-1", status: "completed", resultArtifactId: "run-1-results" },
    { runId: "run-2", status: "failed", resultArtifactId: null },
  ];
  return { ...fixture, post, metrics, resultText, aggregateText };
}

function artifact(artifactId, role, locator, digest, mediaType, visibleToRoles, availableAt = "2025-12-31T20:00:00Z") {
  return {
    artifactId,
    role,
    locator,
    digest,
    mediaType,
    availableAt,
    visibleToRoles,
    provenance: {
      source: "trusted-system",
      observedAt: availableAt,
      evidenceRefs: [`receipt:${artifactId}`],
    },
  };
}

function result(caseId, runId, criterionId, outcome, judgeActorId, judgmentMethod, evidenceRef) {
  return {
    schemaVersion: "1.0.0",
    caseId,
    runId,
    criterionId,
    outcome,
    value: null,
    judgeActorId,
    judgmentMethod,
    evidenceRefs: [evidenceRef],
  };
}
