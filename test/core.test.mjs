import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeEvaluation, digestRequest, InputError, sha256Canonical, validateReport } from "../scripts/core.mjs";
import { makeFixture, makePostFixture, rawDigest } from "./fixture.mjs";

test("a frozen pre-execution evaluation passes without certifying results", async () => {
  const { root, base } = await makeFixture();
  const report = await analyzeEvaluation(base, { artifactRoot: root });
  assert.equal(report.verdict, "PASS");
  assert.equal(report.auditStage, "pre-execution");
  assert.equal(report.qualifiesAsQualityOrReleaseEvidence, false);
  assert.equal(report.recomputedMetrics.length, 0);
});

test("a complete post-execution audit recomputes every expected denominator", async () => {
  const { root, post } = await makePostFixture();
  const report = await analyzeEvaluation(post, { artifactRoot: root });
  assert.equal(report.verdict, "PASS");
  assert.equal(report.qualifiesAsQualityOrReleaseEvidence, true);
  assert.deepEqual(report.recomputedMetrics.map(({ metricId, numerator, denominator, value }) => ({ metricId, numerator, denominator, value })), [
    { metricId: "semantic-pass-rate", numerator: 1, denominator: 4, value: 0.25 },
    { metricId: "exact-pass-rate", numerator: 2, denominator: 4, value: 0.5 },
  ]);
});

test("semantic quality cannot rely on lexical matching alone", async () => {
  const { root, base } = await makeFixture();
  base.criteria[0].judgmentMethods = ["lexical-match"];
  const report = await analyzeEvaluation(base, { artifactRoot: root });
  assert.equal(report.verdict, "FAIL");
  assert.ok(report.blockingCodes.includes("SEMANTIC_LEXICAL_ONLY"));
});

test("self-report alone fails but supplementary self-report is allowed", async () => {
  const { root, base } = await makeFixture();
  assert.equal((await analyzeEvaluation(base, { artifactRoot: root })).verdict, "PASS");
  base.criteria[0].judgmentMethods = ["self-report"];
  const report = await analyzeEvaluation(base, { artifactRoot: root });
  assert.equal(report.verdict, "FAIL");
  assert.ok(report.blockingCodes.includes("SELF_REPORT_ONLY"));
});

test("deterministic exact criteria may use lexical matching", async () => {
  const { root, base } = await makeFixture();
  const report = await analyzeEvaluation(base, { artifactRoot: root });
  assert.equal(report.checks.find((item) => item.checkId === "JUDGMENT_METHOD_VALID").status, "PASS");
});

test("missing independent timing provenance blocks the audit", async () => {
  const { root, base } = await makeFixture();
  base.artifacts.find((item) => item.role === "rubric").provenance = null;
  const report = await analyzeEvaluation(base, { artifactRoot: root });
  assert.equal(report.verdict, "BLOCKED");
  assert.ok(report.blockingCodes.includes("PROVENANCE_MISSING"));
});

test("a control artifact observed after execution fails", async () => {
  const { root, post } = await makePostFixture();
  post.artifacts.find((item) => item.role === "rubric").provenance.observedAt = "2026-01-02T00:00:01Z";
  const report = await analyzeEvaluation(post, { artifactRoot: root });
  assert.equal(report.verdict, "FAIL");
  assert.ok(report.blockingCodes.includes("POSTHOC_INPUT"));
});

test("malformed result JSONL fails and is never aggregated", async () => {
  const { root, post } = await makePostFixture();
  const malformed = '{"schemaVersion":"1.0.0"\n';
  await writeFile(path.join(root, "run-1.jsonl"), malformed, "utf8");
  post.artifacts.find((item) => item.role === "result-records").digest = rawDigest(malformed);
  const report = await analyzeEvaluation(post, { artifactRoot: root });
  assert.equal(report.verdict, "FAIL");
  assert.ok(report.blockingCodes.includes("JSONL_PARSE_FAILED"));
  assert.equal(report.recomputedMetrics.length, 0);
});

test("a missing case fails the complete manifest check", async () => {
  const { root, base } = await makeFixture();
  const shortened = '{"schemaVersion":"1.0.0","caseId":"case-1","split":"validation"}\n';
  await writeFile(path.join(root, "fixture-manifest.jsonl"), shortened, "utf8");
  base.artifacts.find((item) => item.role === "fixture-manifest").digest = rawDigest(shortened);
  const report = await analyzeEvaluation(base, { artifactRoot: root });
  assert.equal(report.verdict, "FAIL");
  assert.ok(report.blockingCodes.includes("CASE_MISSING"));
});

test("digest mismatch fails while a missing artifact blocks", async () => {
  const first = await makeFixture();
  first.base.artifacts.find((item) => item.role === "rubric").digest = rawDigest("changed");
  assert.equal((await analyzeEvaluation(first.base, { artifactRoot: first.root })).verdict, "FAIL");

  const second = await makeFixture();
  second.base.artifacts.find((item) => item.role === "rubric").locator = "missing.json";
  const blocked = await analyzeEvaluation(second.base, { artifactRoot: second.root });
  assert.equal(blocked.verdict, "BLOCKED");
  assert.ok(blocked.blockingCodes.includes("ARTIFACT_MISSING"));
});

test("missing post-execution evidence remains BLOCKED instead of becoming FAIL", async () => {
  for (const role of ["oracle", "fixture-manifest", "result-records"]) {
    const { root, post } = await makePostFixture();
    post.artifacts.find((item) => item.role === role).locator = `missing-${role}.json`;
    const report = await analyzeEvaluation(post, { artifactRoot: root });
    assert.equal(report.verdict, "BLOCKED", role);
    assert.equal(report.checks.some((item) => item.status === "FAIL"), false, role);
  }
});

test("a post-execution audit cannot predate execution or its result evidence", async () => {
  const { root, post } = await makePostFixture();
  post.auditedAt = "2026-01-01T00:00:00Z";
  const report = await analyzeEvaluation(post, { artifactRoot: root });
  assert.equal(report.verdict, "FAIL");
  assert.equal(report.qualifiesAsQualityOrReleaseEvidence, false);
  assert.ok(report.blockingCodes.includes("AUDIT_NOT_POST_EXECUTION"));
  assert.ok(report.blockingCodes.includes("RESULT_EVIDENCE_NOT_AVAILABLE_AT_AUDIT"));
});

test("aggregate claims that omit failed-run denominators fail", async () => {
  const { root, post } = await makePostFixture();
  post.metrics[0].claimedValue = 0.5;
  const report = await analyzeEvaluation(post, { artifactRoot: root });
  assert.equal(report.verdict, "FAIL");
  assert.ok(report.blockingCodes.includes("AGGREGATE_MISMATCH"));
});

test("actor collisions fail independence", async () => {
  const { root, base } = await makeFixture();
  base.actors.auditorId = base.actors.executorIds[0];
  const report = await analyzeEvaluation(base, { artifactRoot: root });
  assert.equal(report.verdict, "FAIL");
  assert.ok(report.blockingCodes.includes("ROLE_CONFLICT"));
});

test("validation binds the frozen request and rejects report remapping", async () => {
  const { root, base } = await makeFixture();
  const report = await analyzeEvaluation(base, { artifactRoot: root });
  const envelope = {
    schemaVersion: "1.0.0",
    request: base,
    requestArtifact: { artifactId: "evaluation-validity-request", locator: "artifact://request/audit-pre-1", digest: sha256Canonical(base) },
    report,
  };
  assert.deepEqual(await validateReport(envelope, { artifactRoot: root }), []);
  envelope.report = { ...report, verdict: "FAIL" };
  const errors = await validateReport(envelope, { artifactRoot: root });
  assert.ok(errors.some((item) => item.includes("reportDigest")));
  assert.ok(errors.some((item) => item.includes("does not match")));
});

test("request digest is stable across object key order", async () => {
  const { base } = await makeFixture();
  const reordered = Object.fromEntries(Object.entries(base).reverse());
  assert.equal(digestRequest(base).digest, digestRequest(reordered).digest);
});

test("artifact traversal and absolute paths are adapter errors", async () => {
  const { root, base } = await makeFixture();
  base.artifacts[0].locator = "../outside.json";
  await assert.rejects(() => analyzeEvaluation(base, { artifactRoot: root }), InputError);
  base.artifacts[0].locator = path.join(root, "fixture-manifest.jsonl");
  await assert.rejects(() => analyzeEvaluation(base, { artifactRoot: root }), InputError);
});

test("symlinks or junctions outside artifact root are rejected when supported", async (t) => {
  const { root, base } = await makeFixture();
  const outside = path.join(os.tmpdir(), `evaluation-outside-${process.pid}`);
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "fixture-manifest.jsonl"), "{}", "utf8");
  try { await symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir"); }
  catch { t.skip("symlink creation is not available"); return; }
  base.artifacts[0].locator = "escape/fixture-manifest.jsonl";
  await assert.rejects(() => analyzeEvaluation(base, { artifactRoot: root }), InputError);
});

test("CLI returns exit 0 for a valid FAIL report and exit 2 for invalid input", async () => {
  const { root, base } = await makeFixture();
  base.criteria[0].judgmentMethods = ["self-report"];
  const failed = await runCli(["scripts/cli.mjs", "--artifact-root", root], JSON.stringify(base));
  assert.equal(failed.code, 0);
  assert.equal(JSON.parse(failed.stdout).verdict, "FAIL");
  const invalid = await runCli(["scripts/cli.mjs", "--artifact-root", root], "{}");
  assert.equal(invalid.code, 2);
  assert.equal(JSON.parse(invalid.stdout).error.code, "INVALID_INPUT");
});

test("digest and report-validation CLIs implement the documented exit contract", async () => {
  const { root, base } = await makeFixture();
  const report = await analyzeEvaluation(base, { artifactRoot: root });
  const requestPath = path.join(root, "request.json");
  const artifactPath = path.join(root, "request-artifact.json");
  const reportPath = path.join(root, "report.json");
  await writeFile(requestPath, JSON.stringify(base), "utf8");
  await writeFile(artifactPath, JSON.stringify({ artifactId: "evaluation-validity-request", locator: "artifact://request/audit-pre-1", digest: sha256Canonical(base) }), "utf8");
  await writeFile(reportPath, JSON.stringify(report), "utf8");
  const digest = await runCli(["scripts/digest-request.mjs", "--input", requestPath], "");
  assert.equal(digest.code, 0);
  assert.equal(JSON.parse(digest.stdout).digest, sha256Canonical(base));
  const valid = await runCli(["scripts/validate-report.mjs", "--request", requestPath, "--request-artifact", artifactPath, "--report", reportPath, "--artifact-root", root], "");
  assert.equal(valid.code, 0);
  assert.equal(JSON.parse(valid.stdout).valid, true);
  const modified = { ...report, verdict: "FAIL" };
  await writeFile(reportPath, JSON.stringify(modified), "utf8");
  const invalidReport = await runCli(["scripts/validate-report.mjs", "--request", requestPath, "--request-artifact", artifactPath, "--report", reportPath, "--artifact-root", root], "");
  assert.equal(invalidReport.code, 1);
  assert.equal(JSON.parse(invalidReport.stdout).valid, false);
  const invalidInvocation = await runCli(["scripts/validate-report.mjs", "--artifact-root", root], "");
  assert.equal(invalidInvocation.code, 2);
  const missingRoot = await runCli(["scripts/validate-report.mjs", "--request", requestPath, "--request-artifact", artifactPath, "--report", reportPath, "--artifact-root", path.join(root, "absent")], "");
  assert.equal(missingRoot.code, 2);
  assert.match(JSON.parse(missingRoot.stdout).errors[0], /Artifact root/u);
});

function runCli(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
