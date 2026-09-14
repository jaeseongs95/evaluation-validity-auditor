---
name: evaluation-validity-auditor
description: 동결된 스킬·모델 평가의 입력, 판정 방법과 결과 집계가 공정하고 재현 가능한지 실행 전후에 감사한다. 평가 실행·채점·수정이나 일반 구현 검증에는 사용하지 않는다.
license: MIT
metadata:
  version: "1.0.0"
---

# Evaluation Validity Auditor

평가 결과를 품질 gate, 완료 주장 또는 릴리스 근거로 사용하기 전에 평가 자체의 유효성을 독립적으로 확인한다. 이 스킬은 평가를 실행하거나 fixture, rubric, oracle, threshold, 결과와 실패 기록을 수정하지 않는다.

## 입력과 단계

`EvaluationValidityRequest.v1`과 하나의 명시적 artifact root를 받는다. 모든 locator는 이 root 안의 상대 경로여야 한다.

- `pre-execution`에서는 동결 시점, case inventory, 역할 독립성, 판정 방법, artifact digest와 provenance를 확인한다. 이 단계의 `PASS`는 결과 유효성을 인증하지 않는다.
- `post-execution`에서는 같은 검사를 다시 수행하고 모든 run·case·criterion, 실패·timeout, 결과 레코드와 공개 집계를 재계산한다. 품질 또는 릴리스 근거로는 이 단계의 `PASS`만 사용한다.

판정 전에 [감사 프로토콜](references/audit-protocol.md)을 읽는다. 결정적 검사는 CLI로 실행한다.

```bash
node scripts/cli.mjs --input request.json --artifact-root evidence
node scripts/digest-request.mjs --input request.json
node scripts/validate-report.mjs --request request.json --request-artifact request-artifact.json --report report.json --artifact-root evidence
```

## 불변조건

- 의미 보존이나 품질 criterion을 문자열 일치 또는 자기보고만으로 통과시키지 않는다. 명시적인 deterministic criterion에는 lexical match를 허용한다.
- rubric, fixture manifest, oracle, aggregation rule, target revision과 결과 digest를 보고서에 함께 결속한다.
- 누락·중복·unknown case/run/criterion과 malformed JSONL이 있으면 전체 결과를 집계하지 않는다.
- 평가 시작 뒤 관측된 control artifact가 입력에 영향을 주면 `FAIL`, 독립적인 timing provenance가 없으면 `BLOCKED`다.
- 감사자와 의미 판정자를 작성자·실행자와 분리한다. actor ID와 provenance source는 협력적 호출자가 제공한 주장임을 limitation으로 보존한다.
- 보고서에는 corpus, 정답, prompt, 모델 출력 또는 자유형 finding을 넣지 않는다. 고정 코드, 수량, digest와 opaque evidence reference만 기록한다.

## 판정

- `PASS`: 선택한 단계의 모든 필수 검사가 통과했다.
- `FAIL`: 현재 artifact가 잘못된 평가 설계, 오염, 불완전한 레코드 또는 잘못된 집계를 직접 증명한다.
- `BLOCKED`: 필수 artifact나 독립 provenance가 없거나 읽을 수 없어 판정할 수 없다.

잘못된 request schema, artifact-root 이탈과 외부 symlink/junction은 보고서가 아니라 `INVALID_INPUT`으로 반환한다. 새 evidence나 동결 frame이 들어오면 기존 보고서를 재사용하지 말고 새 요청 digest로 다시 감사한다.
