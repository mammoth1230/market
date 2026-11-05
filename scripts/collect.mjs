// GitHub Actions가 1시간마다 실행하는 수집 스크립트
// 브라우저에서는 CORS 때문에 못 가져오는 자료를 대신 모아서 data/ 폴더의 JSON 파일로 저장한다.
//   latest.json  최신 시세 (Yahoo + 일본 국채)        history.json  날짜별 종가 기록 (끝난 날만)
//   credit.json  신용잔고·예탁금 (금투협)              flows.json    투자자별 순매수 (네이버)
//   rates.json   주요국 기준금리 (BIS)                 kalshi.json   금리 예측 확률 (칼시)
//   fng.json     CNN 공포탐욕                          valuation.json S&P500 P/E·CAPE (multpl)
//   stocks.json  관심 종목 기업 정보 (네이버)          bls.json      미국 지표 발표치 (BLS)
//   news.json    카드 아래 뉴스 (Google 뉴스)
//   ndx.json     나스닥100 P/E (WSJ)                   portfolios.json 투자 거물 포트폴리오 (SEC 13F·ARK)

import { readFile, writeFile } from 'node:fs/promises';

// ── 공통 도구 ──
const UA = { 'User-Agent': 'Mozilla/5.0' };
// 로봇을 거절하는 사이트(CNN·WSJ)에는 브라우저처럼 보이는 머리말을 쓴다
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
const MAX_DAYS = 400;   // 날짜별 기록은 최근 400개(약 1년 반)만 보관

// 주소에서 받아오기: 실패(HTTP 오류)면 바로 알려 준다
async function http(url, { headers, ...opts } = {}) {
  const res = await fetch(url, { ...opts, headers: { ...UA, ...headers } });
  if (!res.ok) throw new Error(`${url.slice(0, 60)}…: HTTP ${res.status}`);
  return res;
}
const getJSON = (url, opts) => http(url, opts).then(r => r.json());
const getText = (url, opts) => http(url, opts).then(r => r.text());

async function load(file, fallback) {   // 예전에 저장한 파일 읽기 (없으면 fallback)
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}
const save = (file, obj) => writeFile(file, JSON.stringify(obj) + '\n');   // 빈칸 없이 작게 저장

// 1시간마다 돌지만 천천히 바뀌는 자료는 가끔만 받는다 (상대 서버 배려 + 하루 요청 한도)
async function stale(file, minutes) {
  const { updated } = await load(file, {});
  return !updated || Date.now() - new Date(updated) > minutes * 60e3;
}

// 자료 하나가 실패해도 나머지는 계속 (실패한 자료는 예전 파일이 그대로 남는다)
async function section(name, fn) {
  try { console.log(name, await fn()); } catch (e) { console.error(name, '실패:', e.message); }
}

// [날짜, 값] 목록 두 개를 날짜 기준으로 합치기 (같은 날은 새 값으로), 날짜순 정렬 후 최근 MAX_DAYS개
function mergeByDate(oldRows = [], newRows = []) {
  const byDate = Object.fromEntries(oldRows.map(r => [r[0], r.slice(1)]));
  for (const r of newRows) byDate[r[0]] = r.slice(1);
  return Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).slice(-MAX_DAYS).map(([d, v]) => [d, ...v]);
}
const ymd = s => s.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');   // '20261102' → '2026-11-02'

// ── 1. 시세: Yahoo Finance (🟠 비공식 — 공식 출처 인증키를 받으면 차례로 옮길 것들) ──
// 지수·유가·관심 종목만 남았다. 환율·VIX·미국 10년물·코인은 아래 2번의 공식 출처로 옮겼다
const SYMBOLS = [
  ['S&P 500', '^GSPC'], ['나스닥', '^IXIC'], ['코스피', '^KS11'], ['코스닥', '^KQ11'],
  ['WTI', 'CL=F'], ['브렌트유', 'BZ=F'],            // CL=F·BZ=F = 원유 선물
];
const YAHOO = '🟠 Yahoo Finance (비공식)';
const watch = (await load('data/watchlist.json', { stocks: [] })).stocks;   // 관심 종목 목록
const history = await load('data/history.json', {});
const quotes = [];

async function getQuote(name, symbol) {
  const r = (await getJSON('https://query1.finance.yahoo.com/v8/finance/chart/'
    + encodeURIComponent(symbol) + '?range=1y&interval=1d')).chart.result[0];
  const m = r.meta;
  // gmtoffset = 거래소 현지 시차(초). 한국 장은 한국 날짜로 붙여야 하루가 밀리지 않는다
  const day = sec => new Date((sec + (m.gmtoffset || 0)) * 1000).toISOString().slice(0, 10);
  const today = day(m.regularMarketTime);
  const reg = m.currentTradingPeriod?.regular;   // 오늘 정규장 시작·끝
  const t = Date.now() / 1000;
  // 지금 장이 열려 있고, 가격도 오늘 장중 값인가 (장 시작 직후엔 Yahoo가 아직 어제 종가를 줄 때가 있다)
  const open = reg ? t >= reg.start && t < reg.end && m.regularMarketTime >= reg.start : null;

  // 기록 합치기: '끝난 날'만 남긴다. 장중 가격은 수집 때마다 바뀌어서 매번 history.json을 다시 저장(커밋)하게 되므로
  // 오늘 값은 장이 끝난 뒤에만 넣고, 장중에는 화면이 latest.json의 가격을 그래프 끝에 붙인다
  const closes = r.indicators.quote[0].close;
  const done = r.timestamp.map((ts, i) => [day(ts), closes[i]]).filter(([d, v]) => v != null && d < today);
  let rows = mergeByDate(history[symbol], done).filter(([d]) => d !== today);
  if (!open) rows = mergeByDate(rows, [[today, m.regularMarketPrice]]);
  history[symbol] = rows.map(([d, v]) => [d, Number(v.toPrecision(6))]);   // 유효숫자 6자리 (0.8915 같은 환율도 살리기)

  // 전일 종가 = 우리 기록에서 오늘보다 앞선 마지막 값
  // (Yahoo 일별 목록엔 어제 줄이 하루 넘게 빠져 있을 때가 있지만, 우리 기록엔 어제 마감 값이 남아 있다)
  const prev = history[symbol].filter(([d]) => d < today).at(-1)?.[1];
  quotes.push({
    name, symbol, price: m.regularMarketPrice, date: today, open, src: YAHOO,
    changePct: prev ? (m.regularMarketPrice / prev - 1) * 100 : 0,
    time: new Date(m.regularMarketTime * 1000).toISOString(),
    high52: m.fiftyTwoWeekHigh, low52: m.fiftyTwoWeekLow,
  });
}

await section('시세(Yahoo)', async () => {
  for (const [name, symbol] of [...SYMBOLS, ...watch.map(s => [s.name, s.yahoo])]) {
    try { await getQuote(name, symbol); } catch (e) { console.error(symbol, '실패:', e.message); }
  }
  return quotes.length + '개';
});

// ── 2. ✅ 공식 출처의 하루 단위 자료 ──
// rows = [[날짜, 값], ...] 오래된 순. 공식 자료는 기록을 통째로 그 출처 값으로 바꾼다 (다른 출처와 섞지 않기)
// live = 오늘 줄이 아직 진행 중인 값이면 true (코인): 기록에는 끝난 날만 넣고, 오늘 값은 최신 시세로만 쓴다
function addOfficial(name, symbol, rows, src, { time, live = false } = {}) {
  rows = rows.filter(([, v]) => v != null && !isNaN(v)).sort(([a], [b]) => a.localeCompare(b)).slice(-MAX_DAYS);
  const [date, price] = rows.at(-1), prev = rows.at(-2)?.[1] ?? price;
  history[symbol] = (live ? rows.slice(0, -1) : rows).map(([d, v]) => [d, Number(v.toPrecision(6))]);
  // 52주 최고·최저 = 최근 1년 (날짜로 자른다: 주식은 1년에 약 250거래일, 코인은 365일이라 개수로 자르면 틀린다)
  const yearAgo = new Date(Date.parse(date) - 365 * 864e5).toISOString().slice(0, 10);
  const year = rows.filter(([d]) => d > yearAgo).map(r => r[1]);
  quotes.push({ name, symbol, price, date, open: live, src, changePct: (price / prev - 1) * 100,
                time: time ? time(date) : date + 'T00:00:00Z', high52: Math.max(...year), low52: Math.min(...year) });
  return `${price} (${date})`;
}
const mdy = s => s.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$3-$1-$2');   // '10/30/2026' → '2026-10-30'

// 하루 한 번 바뀌는 공식 파일은 2시간에 한 번만 내려받고, 그 사이엔 저장해 둔 기록으로 시세를 만든다
// (Cboe VIX 파일은 400KB쯤이라 매번 받으면 낭비). 마지막으로 받은 시각은 data/state.json에
const state = await load('data/state.json', {});
async function daily(key, symbol, fetchRows) {
  if (state[key] && Date.now() - new Date(state[key]) < 120 * 60e3 && history[symbol]?.length) return history[symbol];
  const rows = await fetchRows();
  state[key] = now();
  return rows;
}

// 일본 국채 10년물: 일본 재무성(MOF) 이번 달 금리표(CSV). 한 줄 예: R8.10.30,1.659,... (R8 = 레이와 8년 = 2026년, 11번째 칸이 10년물)
// 이번 달 표만 주므로 지난 기록과 합친다
await section('일본 국채', async () => {
  const rows = await daily('JGB10', 'JGB10', async () =>
    mergeByDate(history.JGB10, (await getText('https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv')).split('\n')
      .map(l => l.split(',')).filter(c => /^R\d+\.\d+\.\d+$/.test(c[0]) && c[10])
      .map(c => {
        const [y, mo, d] = c[0].slice(1).split('.').map(Number);
        return [`${2018 + y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, Number(c[10])];
      })));
  return addOfficial('일본 국채 10년물', 'JGB10', rows, '✅ 일본 재무성 국채금리표', { time: d => d + 'T06:00:00Z' });
});

// VIX: VIX를 만들어 발표하는 Cboe의 공식 일별 파일 (DATE,OPEN,HIGH,LOW,CLOSE)
await section('VIX', async () => {
  const rows = await daily('VIX', '^VIX', async () =>
    (await getText('https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv'))
      .trim().split('\n').slice(1).map(l => l.split(',')).map(c => [mdy(c[0]), Number(c[4])]));
  return addOfficial('VIX 공포지수', '^VIX', rows, '✅ Cboe 공식 일별 종가', { time: d => d + 'T20:15:00Z' });
});

// 미국 국채 10년물: 미국 재무부 공식 일별 금리표 (올해 + 작년 파일, 최신이 위)
await section('미국 국채', async () => {
  const rows = await daily('UST10', '^TNX', async () => {
    const y = new Date().getUTCFullYear(), out = [];
    for (const year of [y - 1, y]) {
      const lines = (await getText('https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/'
        + `${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`)).trim().split('\n');
      const col = lines[0].split(',').findIndex(h => h.replace(/"/g, '') === '10 Yr');
      for (const l of lines.slice(1)) { const c = l.split(','); out.push([mdy(c[0]), Number(c[col])]); }
    }
    return out;
  });
  return addOfficial('미국 국채 10년물', '^TNX', rows, '✅ 미국 재무부 일별 금리', { time: d => d + 'T21:00:00Z' });
});

// 환율: 유럽중앙은행(ECB) 기준환율 (매일 오후 2시 15분 CET 발표). ECB는 '1유로 = 몇 ○○'로 주므로
// '1달러 = 몇 ○○'는 (○○/유로) ÷ (달러/유로)로 바꾼다
const FX = [['원/달러', 'KRW=X', 'KRW'], ['달러/엔', 'JPY=X', 'JPY'], ['달러/파운드', 'GBP=X', 'GBP'],
            ['달러/위안', 'CNY=X', 'CNY'], ['달러/유로', 'EUR=X', 'EUR']];
await section('환율(ECB)', async () => {
  let fresh = null;
  await daily('ECB', 'KRW=X', async () => {
    const start = new Date(Date.now() - 560 * 864e5).toISOString().slice(0, 10);
    const csv = (await getText(`https://data-api.ecb.europa.eu/service/data/EXR/D.USD+KRW+JPY+GBP+CNY.EUR.SP00.A?startPeriod=${start}&format=csvdata&detail=dataonly`))
      .trim().split('\n').slice(1).map(l => l.split(','));
    const byCur = { EUR: {} };   // { USD: { '2026-11-02': 1.1216, ... }, KRW: {...} }
    for (const c of csv) (byCur[c[2]] ||= {})[c[6]] = Number(c[7]);
    for (const d in byCur.USD) byCur.EUR[d] = 1;   // 1유로 = 1유로
    fresh = Object.fromEntries(FX.map(([, symbol, cur]) => [symbol,
      Object.entries(byCur.USD).filter(([d]) => byCur[cur][d]).map(([d, usd]) => [d, byCur[cur][d] / usd])]));
    return fresh['KRW=X'];
  });
  for (const [name, symbol] of FX)
    addOfficial(name, symbol, fresh ? fresh[symbol] : history[symbol], '✅ 유럽중앙은행 기준환율', { time: d => d + 'T13:15:00Z' });
  return `원/달러 ${quotes.find(q => q.symbol === 'KRW=X')?.price.toFixed(2)}`;
});

// 코인: 업비트 공식 API 일봉 (하루 = 오전 9시 ~ 다음날 오전 9시, 원화). 한 번에 200개까지라 두 번 받는다
await section('코인(업비트)', async () => {
  for (const [name, symbol, market] of [['비트코인 (BTC)', 'BTC-KRW', 'KRW-BTC'], ['이더리움 (ETH)', 'ETH-KRW', 'KRW-ETH']]) {
    const first = await getJSON(`https://api.upbit.com/v1/candles/days?market=${market}&count=200`);
    await sleep(200);
    const more = await getJSON(`https://api.upbit.com/v1/candles/days?market=${market}&count=200&to=${first.at(-1).candle_date_time_utc}`);
    const rows = [...first, ...more].map(c => [c.candle_date_time_kst.slice(0, 10), c.trade_price]);
    addOfficial(name, symbol, mergeByDate([], rows), '✅ 업비트 공식 API', { live: true, time: () => now() });
    await sleep(200);
  }
  return '2개';
});

await save('data/latest.json', { updated: now(), quotes });
await save('data/history.json', history);
await save('data/state.json', state);

// ── 3. 신용융자잔고 · 투자자예탁금: 금융투자협회 통계(FreeSIS) ──
// 통계 사이트가 표를 채울 때 쓰는 주소에 '어떤 표, 어느 기간'을 보내면 JSON으로 돌려준다 (최신 날짜가 앞)
// 하루 한 번 발표되는 자료라 3시간에 한 번만
if (await stale('data/credit.json', 180)) await section('신용잔고', async () => {
  const day = d => d.toISOString().slice(0, 10).replaceAll('-', '');
  const kofia = OBJ_NM => getJSON('https://freesis.kofia.or.kr/meta/getMetaDataList.do', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ dmSearch: { tmpV40: '1000000', tmpV41: '1', tmpV1: 'D',
      tmpV45: day(new Date(Date.now() - 400 * 864e5)), tmpV46: day(new Date()), OBJ_NM } }),
  }).then(j => j.ds1);
  const funds = await kofia('STATSCU0100000060BO');    // 증시자금: TMPV2 = 투자자예탁금
  const credit = await kofia('STATSCU0100000070BO');   // 신용공여: TMPV3 = 코스피, TMPV4 = 코스닥
  const deposit = Object.fromEntries(funds.map(r => [r.TMPV1, r.TMPV2]));
  const jo = v => Math.round(v / 1e4) / 100;           // 백만원 → 조원
  // 날짜별 [날짜, 코스피 신용, 코스닥 신용, 예탁금]
  const rows = credit.map(r => [ymd(r.TMPV1), jo(r.TMPV3), jo(r.TMPV4), jo(deposit[r.TMPV1] ?? NaN)])
    .sort(([a], [b]) => a.localeCompare(b));
  await save('data/credit.json', { updated: now(), rows });
  return rows.at(-1).join(' ');
});

// ── 4. 투자자별 순매수(억원): 네이버 증권 모바일 내부 주소 (비공식, 언제든 바뀔 수 있음) ──
// 과거를 한 번에 주지 않으므로 날짜별로 하나씩 물어보고, 우리 쪽 data/flows.json에 직접 쌓는다
// 처음 한 번은 12개월 누적 그래프용으로 1년치(380일)를 채우고(몇 분 걸림), 그 뒤로는 최근 4일만 다시 확인 (당일 값은 장중 잠정치라서)
await section('수급', async () => {
  const flows = await load('data/flows.json', {});
  const num = s => Number(String(s).replace(/[,+]/g, ''));   // '+6,028' → 6028
  flows.filled ||= {};   // 시장별로 1년치 채우기를 마친 날
  for (const market of ['KOSPI', 'KOSDAQ']) {
    const found = [], have = new Set((flows[market] || []).map(r => r[0]));
    const back = flows.filled[market] ? 4 : 380;
    for (let i = 0; i < back; i++) {
      const kst = new Date(Date.now() + 9 * 3600e3 - i * 864e5);   // 한국 날짜
      if (kst.getUTCDay() === 0 || kst.getUTCDay() === 6) continue;   // 주말은 장이 없으니 묻지 않기
      const day = kst.toISOString().slice(0, 10).replaceAll('-', '');
      if (i >= 4 && have.has(ymd(day))) continue;   // 이미 받아 둔 지난 날은 다시 묻지 않기
      // 하루치가 실패해도 나머지 날은 계속 (실패한 날은 건너뛴다)
      const t = await getJSON(`https://m.stock.naver.com/api/index/${market}/trend?bizdate=${day}`).catch(e => (console.error(market, day, e.message), {}));
      const vals = [num(t.personalValue), num(t.foreignValue), num(t.institutionalValue)];
      if (t.bizdate === day && vals.some(v => v !== 0)) found.push([ymd(day), ...vals]);   // 휴장일(전부 0)은 건너뛰기
      await sleep(200);   // 상대 서버에 부담 주지 않게 잠깐 쉬기
    }
    flows[market] = mergeByDate(flows[market], found);
    flows.filled[market] ||= now().slice(0, 10);
  }
  flows.updated = now();
  await save('data/flows.json', flows);
  return flows.KOSPI.at(-1).join(' ');
});

// ── 5. 주요국 기준금리: 국제결제은행(BIS) 정책금리 통계 (키 없이 CSV로 공개) ── 3시간에 한 번
// 나라 코드: KR 한국, US 미국, XM 유로존, JP 일본, AU 호주, GB 영국, CA 캐나다, CN 중국
const BANKS = ['KR', 'US', 'XM', 'JP', 'AU', 'GB', 'CA', 'CN'];
if (await stale('data/rates.json', 180)) await section('기준금리', async () => {
  const bis = async (freq, start) =>   // 한 줄 = FREQ,나라,날짜,값
    (await getText(`https://stats.bis.org/api/v1/data/WS_CBPOL/${freq}.${BANKS.join('+')}?startPeriod=${start}&format=csv&detail=dataonly`))
      .trim().split('\n').slice(1).map(l => l.trim().split(','))
      .filter(c => c[3] !== '' && !isNaN(Number(c[3]))).map(([, area, t, v]) => [area, t, Number(v)]);
  const monthly = await bis('M', `${new Date().getUTCFullYear() - 5}-01`);                         // 5년 그래프용
  const daily = await bis('D', new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10));    // 최근값·결정 결과용
  const rates = {};
  for (const b of BANKS) {
    const d = daily.filter(r => r[0] === b), last = d.at(-1);
    const m = monthly.filter(r => r[0] === b).map(r => [r[1], r[2]]);
    // 금리가 바뀐 날만 남기기 → 일정표의 '결과: 인상 3.50→3.75%'에 쓴다
    const changes = d.filter((r, i) => i === 0 || r[2] !== d[i - 1][2]).map(r => [r[1], r[2]]);
    rates[b] = { rate: last ? last[2] : m.at(-1)?.[1], asOf: last ? last[1] : m.at(-1)?.[0], src: 'BIS', changes, monthly: m };
  }
  // BIS에 아직 안 들어간 최근 결정은 data/rates-manual.json에 적어 두면 덮어쓴다
  for (const [b, o] of Object.entries((await load('data/rates-manual.json', {})).override || {})) {
    if (rates[b] && o.since > (rates[b].asOf || '')) {
      Object.assign(rates[b], { rate: o.rate, asOf: o.since, src: o.src });
      rates[b].changes.push([o.since, o.rate]);
    }
  }
  await save('data/rates.json', { updated: now(), rates });
  return BANKS.map(b => `${b} ${rates[b].rate}`).join(' ');
});

// ── 6. 칼시(Kalshi) 예측시장: 다음 금리 결정에 사람들이 돈을 건 확률 ──
// 가격 0.71달러 = '그 결과가 나올 확률 71%'로 읽는다
const KALSHI = {
  US: 'KXFEDDECISION', KR: 'KXCBDECISIONKOREA', XM: 'KXCBDECISIONEU', JP: 'KXCBDECISIONJAPAN',
  AU: 'KXCBDECISIONAUSTRALIA', GB: 'KXCBDECISIONENGLAND', CA: 'KXCBDECISIONCANADA',
};
const kalshiEvents = (series, limit) => getJSON('https://api.elections.kalshi.com/trade-api/v2/events'
  + `?series_ticker=${series}&status=open&limit=${limit}&with_nested_markets=true`).then(j => j.events);
function kLabel(s) {   // 'Hike 25bps' → '인상', 'Hike >25bps' → '인상 0.25%p 초과'
  const big = />|more than/i.test(s) ? ' 0.25%p 초과' : '';
  return /cut/i.test(s) ? '인하' + big : /hike/i.test(s) ? '인상' + big : '동결';
}
await section('칼시', async () => {
  const kalshi = {}, year = {};
  for (const [b, series] of Object.entries(KALSHI)) {
    try {
      const meetings = (await kalshiEvents(series, 10)).map(e => {
        const options = e.markets.map(m => ({
          label: kLabel(m.yes_sub_title || ''),
          prob: Math.round((Number(m.last_price_dollars) || (Number(m.yes_bid_dollars) + Number(m.yes_ask_dollars)) / 2) * 100),
          volume: Number(m.volume_fp || 0),
        }));
        const top = [...options].sort((a, c) => c.prob - a.prob)[0];
        return { ticker: e.event_ticker, close: e.markets[0].close_time, label: top.label, prob: top.prob,
                 thin: options.reduce((s, o) => s + o.volume, 0) < 5000,   // 거래가 적으면 숫자가 거칠다
                 options: options.map(({ label, prob }) => ({ label, prob })) };
      }).filter(m => m.options.some(o => o.prob > 0) && new Date(m.close) > new Date())   // 거래가 있고 아직 안 끝난 회의만
        .sort((a, c) => new Date(a.close) - new Date(c.close));
      kalshi[b] = { series, meetings: meetings.slice(0, 2) };
    } catch (e) {
      console.error(`칼시 ${b} 실패:`, e.message);
    }
    await sleep(300);
  }
  // 올해 연준 인상·인하 횟수 시장: '정확히 N번' 칸들의 확률로 '추가 인상'과 '인하 0번' 확률을 만든다
  for (const [key, series] of [['hikes', 'KXRATEHIKE'], ['cuts', 'KXRATECUTCOUNT']]) {
    try {
      const ev = (await kalshiEvents(series, 3)).find(e => e.event_ticker.includes(String(new Date().getUTCFullYear()).slice(2)));
      if (!ev) continue;
      // 'Exactly 2' → 2, 'At least 4' → 4. 이미 끝난 칸은 빼고, 남은 칸 중 가장 작은 수 = 지금까지 횟수
      const rows = ev.markets.filter(m => m.status === 'active' || new Date(m.close_time) > new Date())
        .map(m => ({ n: Number((m.yes_sub_title.match(/\d+/) || [0])[0]), p: Number(m.last_price_dollars) }));
      const done = Math.min(...rows.map(r => r.n));
      year[key] = { title: ev.title, done, more: Math.round(rows.filter(r => r.n > done).reduce((s, r) => s + r.p, 0) * 100),
                    none: Math.round((rows.find(r => r.n === done)?.p || 0) * 100) };
    } catch (e) {
      console.error(`칼시 ${key} 실패:`, e.message);
    }
  }
  await save('data/kalshi.json', { updated: now(), kalshi, year });
  return Object.entries(kalshi).map(([b, k]) => `${b} ${k.meetings[0]?.label} ${k.meetings[0]?.prob}%`).join(' ');
});

// ── 7. CNN 공포·탐욕 지수: CNN 웹페이지가 그래프를 그릴 때 쓰는 주소 (비공식) ──
// 로봇처럼 보이면 거절(418)하므로 브라우저처럼 머리말을 붙인다
await section('공포탐욕', async () => {
  const j = await getJSON('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', { headers: {
    'User-Agent': BROWSER,
    'Accept': 'application/json, text/plain, */*', 'Referer': 'https://edition.cnn.com/', 'Origin': 'https://edition.cnn.com',
  } });
  const f = j.fear_and_greed, r1 = v => Math.round(v * 10) / 10;
  await save('data/fng.json', {
    updated: now(), time: f.timestamp, score: r1(f.score), rating: f.rating,
    prev: r1(f.previous_close), week: r1(f.previous_1_week), month: r1(f.previous_1_month), year: r1(f.previous_1_year),
    history: j.fear_and_greed_historical.data.map(p => [new Date(p.x).toISOString().slice(0, 10), r1(p.y)]),
  });
  return `${r1(f.score)} ${f.rating}`;
});

// ── 8. S&P500 밸류에이션: multpl.com 월별 표 (P/E, 경기조정 P/E = CAPE) ── 6시간에 한 번
async function multpl(path) {
  // 표 한 줄 = <td>Oct 30, 2026</td><td> 40.13 </td>  (값 칸의 꾸밈 글자는 지우고 숫자만, 최신이 앞)
  return [...(await getText(`https://www.multpl.com/${path}/table/by-month`)).matchAll(/<tr[^>]*>\s*<td>([^<]+)<\/td>\s*<td>([\s\S]*?)<\/td>/g)]
    .map(([, d, v]) => [new Date(d + ' UTC').toISOString().slice(0, 10), Number(v.replace(/<[^>]+>|&#?\w+;|[^\d.]/g, ''))])
    .filter(([, v]) => v > 0);
}
if (await stale('data/valuation.json', 360)) await section('밸류에이션', async () => {
  const stat = rows => {
    const [date, value] = rows[0], last25 = rows.slice(0, 300).map(r => r[1]);   // 최근 25년(300개월)
    return { value, date, pct25: Math.round(last25.filter(v => v < value).length / last25.length * 100),
             mean: Math.round(rows.reduce((s, r) => s + r[1], 0) / rows.length * 10) / 10 };
  };
  const pe = stat(await multpl('s-p-500-pe-ratio')), cape = stat(await multpl('shiller-pe'));
  await save('data/valuation.json', { updated: now(), pe, cape });
  return `P/E ${pe.value} CAPE ${cape.value}`;
});

// ── 9. 관심 종목 기업 정보: 네이버 증권 (비공식) — 시총·PER·PBR·배당·외인소진율, 최근 연간 매출·영업이익 ── 1시간에 한 번
// 한국 종목은 m.stock.naver.com, 해외 종목(코드에 . 이 있는 것)은 api.stock.naver.com 주소를 쓴다
if (watch.length && await stale('data/stocks.json', 50)) await section('관심 종목', async () => {
  const num = v => Number(String(v ?? '').replace(/,/g, ''));
  const stocks = {};
  for (const s of watch) {
    try {
      const overseas = s.code.includes('.');
      const info = overseas
        ? (await getJSON(`https://api.stock.naver.com/stock/${s.code}/basic`)).stockItemTotalInfos
        : (await getJSON(`https://m.stock.naver.com/api/stock/${s.code}/integration`)).totalInfos;
      const fin = overseas
        ? await getJSON(`https://api.stock.naver.com/stock/${s.code}/finance/annual`)
        : (await getJSON(`https://m.stock.naver.com/api/stock/${s.code}/finance/annual`)).financeInfo;
      const period = fin.trTitleList.filter(t => t.isConsensus !== 'Y').at(-1);   // 예상치(E)가 아닌 가장 최근 결산
      const row = title => num(fin.rowList.find(r => r.title === title)?.columns?.[period.key]?.value);
      stocks[s.code] = {
        infos: Object.fromEntries(info.map(x => [x.key, x.value])),   // { 시총: '1,292조 276억', PER: '9.91배', ... }
        fin: { period: period.title.replace(/\.$/, ''), sales: row('매출액'), op: row(overseas ? 'EBIT' : '영업이익'),
               opName: overseas ? 'EBIT(영업이익)' : '영업이익', unit: overseas ? 'USD백만' : '억원' },
      };
    } catch (e) {
      console.error(`종목 ${s.name} 실패:`, e.message);
    }
    await sleep(300);
  }
  await save('data/stocks.json', { updated: now(), stocks });
  return Object.keys(stocks).length + '개';
});

// ── 10. 미국 지표 실제 발표치: 미국 노동통계국(BLS) 공개 API (키 없이 하루 25번까지) ── 6시간에 한 번
// CPI(전체·근원), PPI(최종수요), 비농업 고용자 수, 실업률 → 일정표의 '결과'에 쓴다
const BLS = { cpi: 'CUUR0000SA0', core: 'CUUR0000SA0L1E', ppi: 'WPUFD4', payrolls: 'CES0000000001', unemp: 'LNS14000000' };
if (await stale('data/bls.json', 360)) await section('BLS', async () => {
  const y = new Date().getUTCFullYear();
  const j = await getJSON('https://api.bls.gov/publicAPI/v1/timeseries/data/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seriesid: Object.values(BLS), startyear: String(y - 1), endyear: String(y) }),
  });
  if (j.status !== 'REQUEST_SUCCEEDED') throw new Error(j.message?.join(' ') || j.status);
  const bls = { updated: now() };
  for (const [key, id] of Object.entries(BLS)) {
    // 'M09' 같은 월만 (M13 = 연평균, 값이 '-'인 발표 없던 달은 빼기) → [['2026-09', 336.94], ...] 오래된 순
    bls[key] = (j.Results.series.find(x => x.seriesID === id)?.data || [])
      .filter(d => /^M(0[1-9]|1[0-2])$/.test(d.period) && !isNaN(Number(d.value)))
      .map(d => [`${d.year}-${d.period.slice(1)}`, Number(d.value)]).reverse();
  }
  await save('data/bls.json', bls);
  return Object.keys(BLS).map(k => `${k} ${bls[k].at(-1)?.join('=')}`).join(' ');
});

// ── 11. 나스닥100 P/E: 월스트리트저널(WSJ) 'P/E & Yields on Major Indexes' 표 (🟠 비공식) ── 6시간에 한 번
// 숫자는 Birinyi Associates가 매주 금요일 갱신. 웹페이지 안에 표 자료(JSON)가 들어 있어서 그 부분만 읽는다
// 예: ..."tradeDate":"2026-10-30T00:00:00","instruments":[{..."name":"NASDAQ 100 Index","priceEarningsRatio":"29.92",...}]
// 과거 기록은 주지 않으므로 받을 때마다 data/ndx.json의 history에 [날짜, P/E]로 쌓는다
if (await stale('data/ndx.json', 360)) await section('나스닥100 P/E', async () => {
  const page = (await getText('https://www.wsj.com/market-data/stocks/peyields', { headers: { 'User-Agent': BROWSER } })).replace(/\\"/g, '"');
  const at = page.indexOf('"name":"NASDAQ 100 Index"');
  if (at < 0) throw new Error('표에서 NASDAQ 100 Index 줄을 못 찾음');
  const row = JSON.parse(page.slice(page.lastIndexOf('{', at), page.indexOf('}', at) + 1));
  const date = page.slice(page.lastIndexOf('"tradeDate":"', at)).match(/"tradeDate":"(\d{4}-\d{2}-\d{2})/)[1];
  const old = await load('data/ndx.json', {});
  const pe = Number(row.priceEarningsRatio);
  await save('data/ndx.json', {
    updated: now(), date, pe, pe52: Number(row.priceEarningsRatio52WeekAgo), fwd: Number(row.priceEarningsRatioEstimate),
    history: mergeByDate(old.history, [[date, pe]]),
  });
  return `${pe} (${date})`;
});

// ── 12. 투자 거물 포트폴리오 ── 12시간에 한 번 (13F는 분기마다, ARK는 하루 한 번 바뀐다)
// 기관 = ✅ 미국 증권거래위원회(SEC) 13F 공식 신고: 분기말 45일 안에 공개, 미국 상장 주식·옵션의 롱 포지션만
// 캐시 우드 = ✅ ARK가 매일 공개하는 ARKK 보유 종목 파일
// SEC는 요청에 연락처를 밝히라고 요구한다 (안 밝히면 403으로 거절)
const SEC = { headers: { 'User-Agent': 'mammoth1230-market-dashboard mammoth1230@gmail.com' } };
const GURUS = [   // [열쇠, 이름, 소개, SEC 회사 번호(CIK)]
  ['buffett', '워런 버핏', '버크셔 해서웨이 회장', 1067983],
  ['ackman', '빌 애크먼', '퍼싱 스퀘어 CEO', 1336528],
  ['burry', '마이클 버리', "사이언 · '빅쇼트'", 1649339],
  ['druckenmiller', '스탠리 드러켄밀러', '듀케인 패밀리오피스', 1536411],
  ['dalio', '레이 달리오', '브리지워터 창업자', 1350694],
  ['tepper', '데이비드 테퍼', '아팔루사 창업자', 1656456],
];
const ARK = ['wood', '캐시 우드', 'ARK 인베스트 CEO · ARKK'];
const tidy = s => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());   // 'APPLE INC' → 'Apple Inc'

// 13F 보유 종목표(XML) → 회사별 금액 합계, 큰 순. 같은 회사도 운용 담당·주식 종류(알파벳 A·C주)별로 여러 줄이라
// 회사 이름으로 합친다 (풋·콜 옵션은 주식과 따로)
function parse13F(xml) {
  const byKey = {};
  for (const [, row] of xml.matchAll(/<(?:\w+:)?infoTable>([\s\S]*?)<\/(?:\w+:)?infoTable>/g)) {
    const tag = t => row.match(new RegExp(`<(?:\\w+:)?${t}>([^<]*)<`))?.[1].trim() || '';
    const name = tidy(tag('nameOfIssuer')), put = tag('putCall');   // put: '' = 주식, 'Put' / 'Call' = 옵션
    (byKey[name + put] ||= { name, put, value: 0 }).value += Number(tag('value'));
  }
  return Object.values(byKey).sort((a, b) => b.value - a.value);
}
// 보유 목록 → 화면용 요약: 종목 수, 위 15개의 비중(%)
function topHoldings(list) {
  const total = list.reduce((s, h) => s + h.value, 0);
  return { count: list.length, top: list.slice(0, 15).map(h => [h.name, Math.round(h.value / total * 1000) / 10, h.put]) };
}
// 큰따옴표 안의 쉼표는 나누지 않는 CSV 한 줄 나누기: 'a,"1,234",b' → ['a', '1,234', 'b']
function csvRow(line) {
  const out = [''];
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) out.push('');
    else out[out.length - 1] += ch;
  }
  return out;
}

if (await stale('data/portfolios.json', 720)) await section('포트폴리오', async () => {
  const old = Object.fromEntries(((await load('data/portfolios.json', {})).investors || []).map(p => [p.key, p]));
  const investors = [];
  for (const [key, name, role, cik] of GURUS) {
    try {
      const f = (await getJSON(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`, SEC)).filings.recent;
      const i = f.form.indexOf('13F-HR');   // 가장 최근 정기 신고 (정정 신고 13F-HR/A는 빼기)
      const dir = `https://www.sec.gov/Archives/edgar/data/${cik}/${f.accessionNumber[i].replaceAll('-', '')}`;
      await sleep(200);
      const file = (await getJSON(dir + '/index.json', SEC)).directory.item.map(x => x.name)
        .find(n => n.endsWith('.xml') && n !== 'primary_doc.xml');   // 보유 종목표 = 표지(primary_doc) 말고 다른 XML
      await sleep(200);
      investors.push({ key, name, role, src: '✅ SEC 13F 공식 신고', filed: f.filingDate[i], asOf: f.reportDate[i], url: dir,
                       ...topHoldings(parse13F(await getText(`${dir}/${file}`, SEC))) });
    } catch (e) {
      console.error(`포트폴리오 ${name} 실패:`, e.message);
      if (old[key]) investors.push(old[key]);   // 실패하면 지난번 값 유지
    }
    await sleep(300);
  }
  try {
    // 한 줄 = date,fund,company,ticker,cusip,shares,"market value ($)","weight (%)" (맨 아래 안내 문구 줄은 빼기)
    const rows = (await getText('https://assets.ark-funds.com/fund-documents/funds-etf-csv/ARK_INNOVATION_ETF_ARKK_HOLDINGS.csv'))
      .trim().split('\n').slice(1).map(l => csvRow(l.trim())).filter(c => c[1] === 'ARKK' && c[2]);
    const list = rows.map(c => ({ name: tidy(c[2]), put: '', value: Number(c[6].replace(/[$,]/g, '')) })).sort((a, b) => b.value - a.value);
    investors.push({ key: ARK[0], name: ARK[1], role: ARK[2], src: '✅ ARK 매일 공개 보유 종목', asOf: mdy(rows[0][0]),
                     url: 'https://www.ark-funds.com/funds/arkk', ...topHoldings(list) });
  } catch (e) {
    console.error('포트폴리오 ARK 실패:', e.message);
    if (old[ARK[0]]) investors.push(old[ARK[0]]);
  }
  await save('data/portfolios.json', { updated: now(), investors });
  return investors.map(p => `${p.key} ${p.top[0]?.join(' ')}`).join(' / ');
});

// ── 13. 카드 아래 뉴스: Google 뉴스 검색 RSS(최근 2일)에서 제목만 ── 1시간에 한 번 (검색어가 30개쯤이라서)
// RSS = 사이트가 새 글 목록을 기계가 읽기 좋게 내놓는 XML 형식. [꼬리표, 검색어, 개수(기본 1)]
const NEWS = {
  sp500: [['현황', 'S&P500 뉴욕증시 마감'], ['전망', 'S&P500 전망']],
  nasdaq: [['현황', '나스닥 마감'], ['전망', '나스닥 전망']],
  kospi: [['현황', '코스피 마감'], ['전망', '코스피 전망']],
  kosdaq: [['현황', '코스닥 마감']],
  wti: [['현황', '국제유가 WTI'], ['중동', '호르무즈 중동 유가']],
  brent: [['현황', '브렌트유'], ['중동', '중동 정세 원유']],
  btc: [['현황', '비트코인 시세'], ['전망', '비트코인 전망']],
  eth: [['현황', '이더리움 시세'], ['전망', '이더리움 전망']],
  krw: [['현황', '원달러 환율 마감'], ['현황', '환율 원화'], ['전망', '환율 전망']],
  credit: [['', '신용융자 빚투'], ['', '투자자예탁금']],
  flows: [['', '외국인 순매수 코스피'], ['', '기관 순매수 코스피']],
  rates: [['한국', '한국은행 기준금리'], ['미국', '연준 금리'], ['유럽', 'ECB 금리'], ['일본', '일본은행 금리'],
          ['영국', '영란은행 금리'], ['호주', '호주 중앙은행 금리'], ['캐나다', '캐나다 중앙은행 금리']],
  fng: [['전망', '뉴욕증시 투자심리']],
};
for (const s of watch) NEWS['s_' + s.code] = [['', s.name + ' 주가', 3]];   // 관심 종목은 3개씩 (열쇠 = 's_' + 코드)
for (const [key, name] of [...GURUS, ARK]) NEWS['p_' + key] = [['', name, 2]];   // 포트폴리오 탭 (열쇠 = 'p_' + 이름)

const unescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
async function getNews(query, n) {
  const xml = await getText('https://news.google.com/rss/search?q=' + encodeURIComponent(query + ' when:2d') + '&hl=ko&gl=KR&ceid=KR:ko');
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, n).map(([, it]) => {
    const pick = tag => unescape((it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '');
    const source = pick('source');
    const title = pick('title').replace(new RegExp(' - ' + source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '');   // 끝의 " - 언론사" 떼기
    return { title, source, link: pick('link'), date: new Date(pick('pubDate')).toISOString() };
  });
}

if (await stale('data/news.json', 50)) await section('뉴스', async () => {
  const news = { updated: now(), events: {} };
  const seen = new Set();   // 같은 기사가 여러 카드에 겹치지 않게
  const take = async (q, n) => {
    try {
      const fresh = (await getNews(q, n + 3)).filter(a => !seen.has(a.title)).slice(0, n);
      fresh.forEach(a => seen.add(a.title));
      return fresh;
    } catch (e) {
      console.error(e.message);   // 검색어 하나가 실패해도 나머지 뉴스는 계속
      return [];
    } finally {
      await sleep(300);
    }
  };
  // 다가오는 일정 2개(휴장 제외)의 관련 뉴스: 일정 제목으로 검색해서 { 제목: [기사] } 로 저장
  const events = (await load('data/events.json', []))
    .filter(e => new Date(e.date) > new Date() && e.kind !== 'HOLIDAY')
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  for (const e of events.slice(0, 2))
    news.events[e.title] = await take(e.title.replace(/\(.*?\)/g, '').replace(/[—+]/g, ' ').trim(), 3);   // 괄호 설명·기호 빼고 검색
  for (const [key, list] of Object.entries(NEWS)) {
    news[key] = [];
    for (const [tag, q, n = 1] of list) for (const a of await take(q, n)) news[key].push({ tag, ...a });
  }
  await save('data/news.json', news);
  return Object.keys(NEWS).length + '묶음';
});
