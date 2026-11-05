# data 폴더 안내 (Claude가 읽는 설명서)

이 폴더는 https://mammoth1230.github.io/market/ 대시보드의 자료입니다.
GitHub Actions가 1시간마다 `scripts/collect.mjs`로 받아 저장하고, 몇 개는 사람이 손으로 고칩니다.
Claude 프로젝트에 이 저장소를 연결해 두면, 아래 설명대로 파일을 읽고 질문에 답할 수 있어요.

## 읽을 때 지킬 것

- **출처 표시**: ✅ 공식 기관·공식 API / 🟡 공식 기관 자료지만 공개 API가 아님 / 🟠 비공식(민간 사이트 내부 주소). 답할 때 출처와 등급을 함께 말한다.
- **날짜**: 시각은 모두 UTC(ISO 8601, 끝에 Z). 한국시간 = UTC + 9시간. `updated` = 이 사이트가 받아 온 시각이고, 자료 자체의 기준일은 따로 적혀 있다.
- **없는 값은 지어내지 않는다**: 파일에 없으면 "자료에 없음"이라고 답한다.
- 투자 조언이 아니라 정보 제공용이다.

## 파일별 설명

| 파일 | 내용 | 모양 |
|---|---|---|
| `latest.json` | 최신 시세 | `quotes[]` = `{ name, symbol, price, date, changePct(전일대비 %), time, high52, low52, open(장중 여부), src }` |
| `history.json` | 날짜별 종가 (끝난 날만, 최근 400개) | `{ 심볼: [[날짜, 종가], ...] }` 오래된 순. 심볼: `^GSPC` S&P500, `^IXIC` 나스닥, `^KS11` 코스피, `^KQ11` 코스닥, `CL=F` WTI, `BZ=F` 브렌트, `KRW=X` 원/달러, `JPY=X` 달러/엔, `EUR=X` 달러/유로(1달러=몇 유로), `GBP=X`, `CNY=X`, `^VIX`, `^TNX` 미국 10년물(%), `JGB10` 일본 10년물(%), `BTC-KRW`, `ETH-KRW`, 관심 종목 코드 |
| `rates.json` | 주요국 기준금리 (✅ BIS + 중앙은행 공식 일별 자료 + 직접 반영) | `rates.나라 = { rate, asOf, src, how('bis'/'official'/'manual' = 값이 온 곳), changes[[적용일, 금리]], monthly[[월, 금리]] }`. 나라: KR US XM(유로존) JP AU GB CA CN. 미국 `rate`는 목표 범위의 가운데 값(3.875 = 3.75~4.00%) |
| `rates-manual.json` | BIS에 아직 안 들어간 최근 금리 결정 (손으로 입력) | `override.나라 = { rate, since(적용일), src }` |
| `kalshi.json` | 칼시 예측시장 금리 결정 확률 | `kalshi.나라.meetings[] = { close(마감), label(1순위), prob(%), thin(거래 적음), options[] }`, `year.hikes/cuts` = 올해 남은 인상·인하 확률 |
| `bls.json` | 미국 노동통계국 발표치 (✅) | `cpi`·`core`(근원 CPI 지수), `ppi`(최종수요), `payrolls`(비농업 고용, 천 명), `unemp`(실업률 %) = `[[YYYY-MM, 값]]` |
| `events.json` | 주요 일정 (손으로 입력, 공식 일정표 확인) | `[{ date(한국시간 포함), cat, kind, tag, title, local(현지 시각), desc, tentative(잠정), ref(지표의 대상 월) }]` |
| `guides.json` | 일정 종류별 '읽는 법' 해설 | `{ kind: { title, points[] } }` |
| `credit.json` | 신용융자잔고·투자자예탁금 (🟡 금융투자협회) | `rows[[날짜, 코스피 신용, 코스닥 신용, 예탁금]]` 단위 조원 |
| `flows.json` | 투자자별 순매수 (🟠 네이버) | `KOSPI`·`KOSDAQ` = `[[날짜, 개인, 외국인, 기관]]` 단위 억원, 최근 약 1년 반. 당일 값은 장중 잠정치 |
| `fng.json` | CNN 공포·탐욕 (🟠) | `score`, `rating`, `prev/week/month/year`, `history[[날짜, 점수]]` |
| `valuation.json` | S&P500 P/E·CAPE (🟠 multpl.com 월별) | `pe`·`cape` = `{ value, date, pct25(최근 25년 중 위치 %), mean }` |
| `valuation-manual.json` | S&P500 선행 P/E (✅ FactSet, 매주 손으로 입력) | `forwardPE = { value, date, avg5, avg10, url }` |
| `ndx.json` | 나스닥100 P/E (🟠 WSJ 표, Birinyi Associates 매주 금요일) | `pe`(지난 12개월 이익), `pe52`(1년 전), `fwd`(예상 이익 기준), `date`, `history[[날짜, P/E]]` |
| `portfolios.json` | 투자 거물 포트폴리오 | `investors[] = { key, name, role, src, filed(신고일), asOf(기준일), count(종목 수), top[[회사, 비중 %, 'Put'/'Call'/'']], url(원문) }`. 기관 = ✅ SEC 13F(분기, 미국 상장 롱 포지션만), 캐시 우드 = ✅ ARK 매일 공개 |
| `stocks.json` | 관심 종목 기업 정보 (🟠 네이버) | `stocks.코드 = { infos{시총, PER, PBR, ...}, fin{ period, sales, op, unit } }` |
| `watchlist.json` | 관심 종목 목록 (손으로 입력) | `stocks[] = { name, code, yahoo, market }` |
| `news.json` | 카드 아래 뉴스 제목 (Google 뉴스 RSS, 최근 2일) | `{ 열쇠: [{ tag, title, source, link, date }] }` |
| `state.json` | 하루 1번 바뀌는 공식 파일을 마지막으로 받은 시각 | |

## 이렇게 물어보면 좋아요

- "최근 1년 코스피 외국인 누적 순매수는? 언제 가장 많이 팔았어?" → `flows.json`
- "지난 FOMC 결과와 다음 회의 칼시 확률 알려 줘" → `events.json` + `rates.json` + `kalshi.json`
- "원/달러가 1년 동안 엔·유로와 비교해 얼마나 약해졌어?" → `history.json`
- "버핏이랑 캐시 우드가 둘 다 가진 종목 있어?" → `portfolios.json`
- "S&P500·나스닥100 P/E가 1년 전보다 비싸졌어?" → `valuation.json`, `ndx.json`
