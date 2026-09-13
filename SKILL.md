---
name: evaluation-validity-auditor
description: 동결된 평가의 설계와 실행 결과가 공정하고 재현 가능한지 실행 전후에 감사한다. 구현 요구사항 검증, 일반 코드 리뷰, 평가 실행·수정에는 사용하지 않는다.
license: MIT
metadata:
  version: "1.0.0"
---

# Evaluation Validity Auditor

평가 결과를 품질 게이트나 완료 근거로 사용하기 전에 평가 자체의 타당성을 감사한다. 구현의 요구사항 충족은 acceptance evidence 검증에, 고위험 변경의 최종 승인은 독립 감사 gate에, 반복 frame 변경의 의미 보존은 iteration frame 감사에 맡긴다.

## 적용 조건

- benchmark, holdout, 모델·스킬 평가 또는 품질 실험을 실행하기 전에 corpus, rubric, oracle, 역할과 집계 정책을 확인할 때 사용한다.
- 평가 결과를 완료·활성화·릴리스 근거로 쓰기 전에 run과 case 완전성, 실패 보존과 집계를 다시 확인할 때 사용한다.
- 평가를 실행하거나 fixture, rubric, oracle, threshold, 결과 또는 실패 기록을 수정하지 않는다.
- 파일 존재, 자기보고, 성공 exit code 또는 문구 일치만으로 의미 보존이나 품질 개선을 인정하지 않는다.

## 입력과 감사 단계

`EvaluationAuditRequest.v1`을 받는다. 모든 locator는 `auditRoot` 안의 상대 경로여야 하며 artifact digest, 동결 target, actor 역할, 예상 case·run inventory와 검증 근거가 필요하다.

- `pre-execution`: 실행 전에 frame 결속, corpus inventory와 split, label 가시성, 고정 rubric·oracle·aggregation, 역할 독립성, 감사 시점을 확인한다.
- `post-execution`: 통과한 preflight report를 결속하고 모든 run·case, 실패·timeout, 원시 결과와 공개 집계를 다시 계산한다.

판정 전에 [references/audit-protocol.md](references/audit-protocol.md)를 읽는다. 구조·digest·집계 검사는 다음 명령으로 재현한다.

```bash
node scripts/cli.mjs --input request.json
node scripts/validate-report.mjs --input validation-envelope.json
node integration/adapters/korean-prose.mjs --input korean-prose-envelope.json
```

명령은 JSON을 stdin으로도 받으며 파일을 수정하거나 평가를 시작하지 않는다.

## 판정 규칙

1. 결정적 검사는 현재 artifact bytes와 동결 digest를 직접 비교한다.
2. `ORACLE_FIT`과 `NON_SELF_REPORTED_EVIDENCE`는 독립 auditor의 구조화된 판단과 현재 evidence가 있어야 한다.
3. 검증된 실패가 하나라도 있으면 `FAIL`, 필요한 근거가 없으면 `BLOCKED`, 정책 의미가 확정되지 않았으면 `NEEDS_INPUT`이다.
4. 모든 필수 검사가 통과해야 `PASS`다. post-execution `PASS`는 pre-execution `PASS`를 요구한다.
5. 실패·timeout·누락 case를 분모에서 제거하지 않는다. v1 집계는 `all-expected-results`만 허용한다.
6. actor ID와 `verified`는 협력적 호출자가 제공한 값이다. 이 스킬은 신원이나 외부 증거 원문을 인증하지 않는다.

## 출력

`EvaluationValidityReport.v1`과 짧은 사용자 요약을 반환한다. 보고서에는 digest, 고정 코드, 수량과 evidence ref만 넣고 corpus, 정답, 모델 출력과 자유로운 평가 본문은 넣지 않는다.
