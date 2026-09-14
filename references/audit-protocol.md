# Evaluation validity audit protocol

## Evidence boundary

Treat the frozen request, the explicit artifact root and the current artifact bytes as the evidence boundary. Do not authenticate a caller-provided actor ID or provenance label; record `COOPERATIVE_PROVENANCE_ASSERTIONS` in every report.

Never copy fixture text, labels, prompts, model outputs, rubric prose or free-form findings into a report. Use fixed codes, counts, artifact IDs and SHA-256 digests.

## Pre-execution audit

1. Resolve every relative locator inside the artifact root and reject absolute, traversal and escaping symlink or junction paths.
2. Verify exactly one fixture manifest, rubric, oracle, aggregation rule and timing evidence artifact, then compare current bytes with their frozen digests.
3. Parse the fixture manifest line by line with `EvaluationCaseRecord.v1`. Reject malformed, duplicate, missing, unknown or reordered cases.
4. Require the auditor to differ from every author, executor and judge. Require judges to differ from authors and executors.
5. A semantic criterion requires `independent-review`; `self-report` may only supplement it. A deterministic criterion may use `deterministic-oracle` or `lexical-match`.
6. Require independently observable provenance for every control artifact. The frozen time, audit time and execution start must preserve causal order.

A pre-execution `PASS` authorizes no mutation and certifies no eventual result.

## Post-execution audit

Repeat every pre-execution check, then:

1. Match the declared run set exactly, preserving failed and timed-out runs.
2. Parse completed-run JSONL with `EvaluationResultRecord.v1`; require exactly one record for each expected case and criterion.
3. Treat every failed or timed-out run slot as `ERROR` in the frozen all-expected-records denominator.
4. Recompute rate, mean and sum metrics from records. Missing numeric values contribute zero because the denominator remains frozen.
5. Validate `EvaluationAggregateClaim.v1` and require its numerator, denominator, value, comparator, threshold and pass state to match the recomputation and request claim.

Do not produce aggregate metrics if the run, case or result record set is invalid.

## Verdict precedence

1. Any demonstrated invalidity is `FAIL`.
2. Otherwise, missing or unverifiable required evidence is `BLOCKED`.
3. Only an all-pass post-execution report qualifies as quality or release evidence.

Do not repair, rerun, weaken thresholds, replace cases or reinterpret a previous failure while auditing.
