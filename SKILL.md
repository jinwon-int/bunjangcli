---
name: bunjang-cli
description: 번개장터를 CLI로 검색, 상세조회, 찜, 채팅, 대량수집하는 도구를 사용할 때 참고하는 사용 스킬
---

# bunjang-cli Skill

## 목적
`bunjang-cli`를 이용해 번개장터에서 다음 작업을 수행한다.
- 검색
- 가격 필터 / 정렬
- 다페이지 수집
- 상품 상세 / 본문 조회
- 찜 추가 / 제거
- 채팅 목록 조회
- 판매자와 새 채팅 시작
- 기존 채팅방 메시지 전송
- 대량 결과를 JSON 파일 또는 AI용 TOON chunk로 저장

## 실행 원칙
- README 예시와 동일하게 **항상 `npx @jinon86/bunjang-cli ...` 형식**으로 실행한다.
- `auth login`은 headful 브라우저를 띄운 뒤 **현재 터미널이 TTY 상태여야 하고, 로그인 완료 후 터미널에서 Enter를 눌러야** 끝난다. 비-TTY 실행에서는 로그인 브라우저만 뜨고 완료 처리가 멈출 수 있으므로 interactive/TTY 세션으로 실행한다.
- **디스플레이가 없는 헤드리스 노드(SSH-only VPS 등)에서 에이전트가 직접 `auth login`을 실행할 수는 없다.** 화면 있는 머신에서 로그인 후 `auth export <dir>`로 세션을 내보내고, 보안 채널(scp/rsync over SSH)로 헤드리스 노드에 옮긴 뒤 `auth import <dir>`로 가져오게 한다. 자세한 절차는 README의 "헤드리스 서버에서 로그인하기" 참고. 내보낸 디렉토리는 로그인 쿠키를 담고 있으므로 비밀번호처럼 취급하고 안전한 채널로만 옮긴다.
- 검색 노이즈(광고, 타모델, 액세서리)가 섞일 수 있음을 전제하고, 필요하면 후처리로 정제한다.
- 대량 수집 시에는 `--start-page`, `--pages`, `--max-items`, `--with-detail`, `--output`을 우선 활용한다.
- AI 분석용으로 나눠 저장해야 하면 `--ai --output <directory>`를 사용해 `items-<n>.toon` chunk를 만든다.
- 실거래 액션(찜, 채팅, 구매 관련)은 로그인 세션이 살아 있는지 먼저 확인한다.
- 다페이지 export를 검증할 때는 각 item의 **`sourcePage`** 또는 **`summary.raw.page`** 값으로 페이지 기원을 확인한다.

## 검증/안전 원칙
- **데이터 추출 검증**이 목적일 때는 우선 아래 순서로 점검한다.
  1. `search`
  2. `item get` / `item list`
  3. `favorite list`
  4. `favorite add`
  5. `favorite remove`
- **채팅 / 구매**는 부수효과가 더 크므로, 명시적으로 요청받지 않았다면 실행하지 않는다.
- 결과 검증 시에는 가능하면 `--json`을 사용해서 구조를 확인한다.
- 찜 추가/삭제 검증은 같은 상품에 대해 `remove -> add` 또는 `add -> remove` 식으로 **왕복 확인**한다.
- 대량 수집 검증 시에는 `--output` 파일이 실제로 생성되었는지와 `summary/detail/error` 구조를 함께 확인한다.

## 기본 명령

### 로그인
```bash
npx @jinon86/bunjang-cli auth login
npx @jinon86/bunjang-cli auth logout
npx @jinon86/bunjang-cli --json auth status

# 헤드리스 노드 전용: 화면 있는 머신에서 export → scp/rsync로 이전 → 헤드리스에서 import
npx @jinon86/bunjang-cli auth export ./bunjang-session
npx @jinon86/bunjang-cli auth import /path/to/bunjang-session
```

- `auth login`은 브라우저에서 로그인 후 **터미널로 돌아와 Enter를 눌러야** 성공 처리된다.
- 따라서 자동화 도중 로그인할 때는 **TTY가 붙은 interactive 세션**(예: agentty, 직접 터미널 실행)로 돌려야 한다.
- 화면이 없는 노드에서는 `auth login`을 시도하지 말고 위 export/import 경로를 쓴다.

### 검색
```bash
npx @jinon86/bunjang-cli search "갤럭시 s25 울트라"
npx @jinon86/bunjang-cli search "갤럭시 s25 울트라" --price-min 900000 --price-max 1100000
npx @jinon86/bunjang-cli search "갤럭시 s25 울트라" --sort price_asc
```

### 다페이지 수집
```bash
npx @jinon86/bunjang-cli search "갤럭시 s25 울트라" \
  --start-page 1 \
  --pages 30 \
  --max-items 300 \
  --with-detail \
  --concurrency 8 \
  --output artifacts/galaxy-s25-ultra-300-with-detail.json
```

### AI 분석용 TOON chunk 저장
```bash
npx @jinon86/bunjang-cli search "갤럭시 s25 울트라" \
  --start-page 1 \
  --pages 30 \
  --max-items 300 \
  --with-detail \
  --ai \
  --output artifacts/galaxy-s25-ultra-ai
```

- `--ai`는 `items-1.toon` ... `items-n.toon` chunk 파일을 만든다.
- `--ai`에서는 `--output`이 **파일이 아니라 디렉토리**여야 한다.
- manifest 파일은 만들지 않는다.
- 기본 chunk 목표는 50,000 tokens 이다.
- TOON 직렬화는 `@toon-format/toon`, 토큰 수 계산은 `gpt-tokenizer`의 `gpt-5` tokenizer 기준이다.

### 상품 상세
```bash
npx @jinon86/bunjang-cli item get 396049093
npx @jinon86/bunjang-cli --json item list --ids 396049093,395641230,394447826
```

### 찜
```bash
npx @jinon86/bunjang-cli favorite add 396049093
npx @jinon86/bunjang-cli favorite remove 396049093
npx @jinon86/bunjang-cli --json favorite list
```

### 채팅
```bash
npx @jinon86/bunjang-cli --json chat list
npx @jinon86/bunjang-cli --json chat start 396049093 --message "안녕하세요"
npx @jinon86/bunjang-cli --json chat send 84191651 --message "상품 상태 괜찮을까요?"
```

### 구매 흐름 확인
```bash
npx @jinon86/bunjang-cli --json purchase prepare 396049093
npx @jinon86/bunjang-cli --json purchase start 396049093
```


## 추천 사용법
- **최신순 300개 매물 정성 평가 워크플로우**
  1. 최신순으로 300개를 수집하고, 각 상품의 상세 본문까지 파일로 저장한다.
  2. 저장된 파일을 여러 청크로 분할한다.
  3. 서브에이전트를 가능한 한 여러 개 생성해서, 각자 자기 청크만 읽고 **정성적 가성비 점수**를 평가하게 한다.
  4. 각 서브에이전트의 평가 결과를 취합한다.
  5. 최종 보고를 바탕으로 **가성비 최종 TOP 5**를 선정한다.

### 예시 흐름
```bash
npx @jinon86/bunjang-cli search "갤럭시 s24 울트라" \
  --sort date \
  --start-page 1 \
  --pages 30 \
  --max-items 300 \
  --with-detail \
  --concurrency 8 \
  --output artifacts/galaxy-s24-ultra-300-with-detail.json
```

그 다음:
- export 파일을 50개 또는 100개 단위 청크로 나눈다.
- 각 청크를 서브에이전트에게 맡겨서 다음 기준으로 정성 평가한다.
  - 실매물 여부
  - 광고/교환/구매글 여부
  - 가격 대비 용량
  - 상태 표현(S급, 무잔상, 풀박스 등)
  - 자급제 / 정상해지 / 선약 가능 여부
  - 설명의 구체성
  - 판매지역 / 직거래 조건 명확성
- 서브에이전트별 상위 후보를 다시 합쳐 **최종 TOP 5**를 정한다.

## 추천 사용 흐름
1. `auth login`으로 로그인
2. `search`로 후보 수집
3. `item get` 또는 `--with-detail`로 본문 확보
4. 필요 시 AI로 후보 정제 / 랭킹
5. `favorite add`로 저장
6. `chat start` 또는 `chat send`로 판매자 문의

## 검증용 추천 흐름
1. `npx @jinon86/bunjang-cli --json auth status`
2. `npx @jinon86/bunjang-cli --json search "<검색어>" --max-items 5`
3. 검색 결과에서 `id` 하나를 골라 `npx @jinon86/bunjang-cli --json item get <id>`
4. `npx @jinon86/bunjang-cli --json favorite list`
5. 같은 `id`에 대해 `favorite add` / `favorite remove`를 왕복 실행
6. 결과 JSON에서 `transportUsed`, 핵심 필드, before/after 변화를 확인
7. 다페이지 export 검증 시 `sourcePage`가 여러 페이지에 걸쳐 섞여 있는지 확인

## 주의사항
- UI/DOM 변경에 따라 찜/채팅 동작이 깨질 수 있다.
- 검색 결과의 총 개수와 실제 페이지네이션 가능한 상품 수는 다를 수 있다.
- `chat start`는 상품 페이지에서 새 대화를 여는 용도이고, `chat send`는 기존 threadId가 있을 때 사용한다.
- `purchase start`는 최종 자동 구매확정까지 가지 않도록 설계되어 있다.
