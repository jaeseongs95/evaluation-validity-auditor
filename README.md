# Evaluation Validity Auditor

동결된 평가 설계와 완료된 평가 결과가 공정하고 재현 가능한지 독립적으로 감사하는 Codex 스킬입니다. 도메인에 종속되지 않은 JSON/JSONL 계약을 사용하며, 실행 전 preflight와 실행 후 result audit를 분리합니다.

## 빠른 시작

Node.js 22.13 이상과 `pnpm@11.19.0`이 필요합니다.

```bash
pnpm install --frozen-lockfile
node scripts/cli.mjs --input request.json
node scripts/validate-report.mjs --input validation-envelope.json
node integration/adapters/korean-prose.mjs --input korean-prose-envelope.json
pnpm validate
```

계약은 `contracts/`, Agent Governance Suite 연결용 provider descriptor와 한국어 산문 호환 어댑터는 `integration/`에 있습니다. CLI는 입력 artifact를 수정하거나 평가를 실행하지 않습니다.

## 판정

- `PASS`: 모든 필수 검사가 통과했습니다.
- `FAIL`: 검증된 무결성·설계·결과 오류가 있습니다.
- `BLOCKED`: 판정에 필요한 현재 근거가 없습니다.
- `NEEDS_INPUT`: 정책 의미나 semantic 판단이 확정되지 않았습니다.

출력에는 digest, 고정 코드, 수량과 artifact 참조만 포함하며 corpus·label·모델 출력 원문을 복사하지 않습니다.
