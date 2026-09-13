import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { adaptKoreanProse } from "../integration/adapters/korean-prose.mjs";
import { analyzeEvaluation, InputError, sha256Canonical, validateReport } from "../scripts/core.mjs";
import { makeFixture, makePostFixture } from "./fixture.mjs";

test("a frozen pre-execution evaluation passes", async () => {
  const { base } = await makeFixture();
  const report = await analyzeEvaluation(base);
  assert.equal(report.verdict, "PASS");
  assert.equal(report.auditPhase, "pre-execution");
  assert.equal(report.checks.length, 11);
  assert.equal(report.blockingCodes.length, 0);
});

test("label visibility to an evaluator fails preflight", async () => {
  const { base } = await makeFixture();
  base.artifacts.find((item) => item.kind === "labels").visibleToRoles.push("evaluator");
  const report = await analyzeEvaluation(base);
  assert.equal(report.verdict, "FAIL");
  assert.ok(report.blockingCodes.includes("LABEL_LEAKAGE"));
});

test("a frame created after the audit is rejected", async () => {
  const { base } = await makeFixture();
  base.target.frameCreatedAt = "2026-01-01T01:00:00Z";
  const report = await analyzeEvaluation(base);
  assert.equal(report.verdict, "FAIL");
  assert.ok(report.blockingCodes.includes("FRAME_CREATED_AFTER_AUDIT"));
});

test("semantic status and code must agree", async () => {
  const { base } = await makeFixture();
  const judgment = base.semanticJudgments.find((item) => item.checkId === "NON_SELF_REPORTED_EVIDENCE");
  judgment.code = "SELF_REPORT_ONLY";
  const report = await analyzeEvaluation(base);
  assert.equal(report.verdict, "FAIL");
  assert.ok(report.blockingCodes.includes("POLICY_AMBIGUOUS"));
});

test("a post-execution audit preserves failed runs and recomputes the denominator", async () => {
  const { post, metrics } = await makePostFixture();
  const report = await analyzeEvaluation(post);
  assert.equal(report.verdict, "PASS");
  assert.deepEqual(report.recomputedMetrics, metrics);
  assert.equal(report.inventory.expectedRunCount, 2);
  assert.equal(report.inventory.observedRunCount, 2);
});

test("published metrics that omit a failed run are rejected", async () => {
  const { post, root } = await makePostFixture();
  const changed = JSON.stringify({ evaluationId: "eval-1", frameDigest: post.target.frameDigest, metrics: { passRate: 0.5, quality: 0.7 } });
  await writeFile(path.join(root, "aggregate.json"), changed, "utf8");
  const aggregate = post.artifacts.find((item) => item.kind === "aggregate-report");
  aggregate.digest = `sha256:${(await import("node:crypto")).createHash("sha256").update(changed).digest("hex")}`;
  const report = await analyzeEvaluation(post);
  assert.equal(report.verdict, "FAIL");
  assert.ok(report.blockingCodes.includes("PUBLISHED_METRICS_MISMATCH"));
});

test("report validation rejects a modified report", async () => {
  const { base } = await makeFixture();
  const report = await analyzeEvaluation(base);
  const envelope = {
    schemaVersion: "1.0.0",
    request: base,
    requestArtifact: { locator: "request.json", digest: sha256Canonical(base) },
    report: { ...report, verdict: "FAIL" },
  };
  const errors = await validateReport(envelope);
  assert.ok(errors.some((item) => item.includes("reportDigest")));
  assert.ok(errors.some((item) => item.includes("does not match")));
});

test("artifact traversal outside auditRoot is rejected", async () => {
  const { base } = await makeFixture();
  base.artifacts[0].locator = "../outside.json";
  await assert.rejects(() => analyzeEvaluation(base), InputError);
});

test("failed runs cannot claim a result artifact", async () => {
  const { post } = await makePostFixture();
  post.runs[1].resultArtifactId = "run-1-output";
  await assert.rejects(() => analyzeEvaluation(post), InputError);
});

test("Korean prose adapter emits the existing compatibility contract", async () => {
  const { base } = await makeFixture();
  const report = await analyzeEvaluation(base);
  const adapted = await adaptKoreanProse({ schemaVersion: "1.0.0", request: base, report });
  assert.equal(adapted.status, "valid");
  assert.deepEqual(adapted.strataCounts, { legacyCount: 1, holdoutCount: 1 });
  assert.equal(adapted.reportDigest, sha256Canonical(Object.fromEntries(Object.entries(adapted).filter(([key]) => key !== "reportDigest"))));
});

test("CLI summary exposes only the reference-safe provider summary", async () => {
  const { base } = await makeFixture();
  const output = await runCli(JSON.stringify(base));
  const summary = JSON.parse(output);
  assert.equal(summary.verdict, "PASS");
  assert.equal(summary.targetDigest, base.target.frameDigest);
  assert.deepEqual(Object.keys(summary).sort(), ["auditPhase", "auditorActorId", "blockingCodes", "reportDigest", "schemaVersion", "targetDigest", "verdict"].sort());
});

function runCli(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/cli.mjs", "--summary"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let error = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(error)));
    child.stdin.end(input);
  });
}
