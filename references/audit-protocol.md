# Evaluation validity audit protocol

## Evidence boundary

Treat the frozen request and current artifact bytes as evidence. A caller-provided `verified` flag is necessary but does not authenticate identity or provenance. Preserve that limitation in every report.

Never copy corpus text, labels, model output, rubric prose, or free-form findings into the report. Use artifact IDs, locators, SHA-256 digests and fixed finding codes.

## Pre-execution audit

Confirm all of the following before evaluation starts:

1. The frame binds the evaluation ID, candidate digest, run budget and every control artifact digest.
2. The corpus manifest contains the frozen number and ordered digest of unique case IDs.
3. The declared split policy is internally consistent. `disjoint` requires one non-empty split per case; `none` forbids a split field.
4. Labels are post-execution artifacts and are not visible to evaluator roles.
5. Rubric, oracle, thresholds and aggregation policy are verified, present and bound by the frame.
6. The auditor is distinct from authors, evaluators and adjudicators; evaluators and adjudicators do not overlap.
7. The audit occurred no later than the declared execution start.
8. An independent semantic judgment substantiates `ORACLE_FIT` and `NON_SELF_REPORTED_EVIDENCE`.

Lexical matching can be a valid oracle for an explicitly lexical claim. It cannot by itself substantiate semantic preservation, factual correctness or quality improvement.

## Post-execution audit

Re-run every pre-execution check, then confirm:

1. The referenced preflight report is a current `PASS` for the same frame, candidate and corpus.
2. Every frozen run ID appears exactly once, including failed and timed-out runs.
3. Every completed run has one parseable JSONL result per expected case. Failed and timed-out runs remain in the expected denominator.
4. Control artifact bytes still match their frozen digests.
5. Metrics are recomputed from raw case results using the frozen aggregation policy. Missing values contribute zero under `include-as-failure`; `reject-incomplete` makes an incomplete result invalid.
6. Recomputed metrics exactly match the published aggregate report.

## Verdicts

- `PASS`: every required check passed.
- `FAIL`: current verified evidence demonstrates an invalid design or result.
- `BLOCKED`: evidence is missing, unverifiable or in an unsupported format.
- `NEEDS_INPUT`: the requested semantic claim, oracle or policy is materially ambiguous.

Do not repair, rerun, weaken thresholds, replace cases or reinterpret a previous failure while performing this audit.
