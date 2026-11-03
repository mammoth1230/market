// GitHub Actions가 10분마다 실행하는 수집 스크립트
// 브라우저에서는 CORS 때문에 못 가져오는 Yahoo Finance 데이터를 대신 모아서
// data/latest.json(최신값)과 data/history.json(날짜별 기록)으로 저장한다.
// 금융투자협회 신용잔고·예탁금은 data/credit.json, 네이버 수급은 data/flows.json,
// 일본 국채는 history.json의 JGB10, Google 뉴스 제목은 data/news.json,
// 기준금리(BIS)는 data/rates.json, 칼시 확률은 data/kalshi.json, CNN 공포탐욕은 data/fng.json,
// S&P500 P/E·CAPE는 data/valuation.json, 미국 지표 발표치(BLS)는 data/bls.json으로 저장한다.

import { mkdir, readFile, writeFile } from 'node:fs/promises';

// 가져올 종목: [화면에 보일 이름, Yahoo 종목 코드]
const SYMBOLS = [
  ['S&P 500', '^GSPC'],
  ['나스닥', '^IXIC'],
  ['코스피', '^KS11'],
  ['코스닥', '^KQ11'],
  ['원/달러', 'KRW=X'],
  ['WTI', 'CL=F'],            // 미국 원유 선물
  ['브렌트유', 'BZ=F'],        // 유럽 원유 선물
  ['비트코인 (BTC)', 'BTC-KRW'],
  ['이더리움 (ETH)', 'ETH-KRW'],
  ['VIX 공포지수', '^VIX'],
  ['미국 국채 10년물', '^TNX'],
  ['달러/엔', 'JPY=X'],        // 1달러 = 몇 엔
  ['달러/유로', 'EUR=X'],      // 1달러 = 몇 유로 (통화 상대강도용)
  ['달러/파운드', 'GBP=X'],
  ['달러/위안', 'CNY=X'],
];

const MAX_DAYS = 400; // 종목마다 최근 400거래일(약 1년 반)만 보관

// 10분마다 돌지만, 천천히 바뀌는 자료는 가끔만 받는다 (상대 서버 배려 + 하루 요청 한도)
// 파일 안의 updated 시각이 minutes분보다 오래됐거나 파일이 없으면 true
async function stale(file, minutes) {
  try {
    const { updated } = JSON.parse(await readFile(file, 'utf8'));
    return !updated || Date.now() - new Date(updated) > minutes * 60e3;
  } catch {
    return true;
  }
}

// 날짜 숫자(초)를 '2026-11-02' 같은 글자로 바꾸기
function toDate(sec) {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

async function getQuote(name, symbol) {
  // 최근 1년치 일별 종가를 한 번에 받아온다
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'
    + encodeURIComponent(symbol) + '?range=1y&interval=1d';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const result = (await res.json()).chart.result[0];

  // [날짜, 종가] 목록 만들기 (값이 빈 날은 제외)
  // gmtoffset = 거래소 현지 시차(초). 한국 장은 한국 날짜로 붙여야 하루가 밀리지 않는다
  const offset = result.meta.gmtoffset || 0;
  const closes = result.indicators.quote[0].close;
  const series = result.timestamp
    .map((t, i) => [toDate(t + offset), closes[i]])
    .filter(([, v]) => v != null);

  const m = result.meta;
  const price = m.regularMarketPrice;
  const today = toDate(m.regularMarketTime + offset);
  // 전일 종가 = 오늘(가격 날짜)보다 앞선 마지막 종가.
  // '끝에서 두 번째'로 고르면 Yahoo 일별 목록에 오늘 줄이 늦게 들어올 때 이틀 전 값을 잘못 집는다
  const prev = series.filter(([d]) => d < today).at(-1)[1];
  const now = Date.now() / 1000;
  const reg = m.currentTradingPeriod?.regular;  // 오늘 정규장 시작·끝 시각

  return {
    quote: {
      name,
      symbol,
      price,
      changePct: (price / prev - 1) * 100,
      time: new Date(m.regularMarketTime * 1000).toISOString(),
      high52: m.fiftyTwoWeekHigh,  // 52주 최고
      low52: m.fiftyTwoWeekLow,
      // 지금 장이 열려 있고, 가격도 오늘 장중 값인가 (장 시작 직후엔 Yahoo가 아직 어제 종가를 줄 때가 있다)
      open: reg ? now >= reg.start && now < reg.end && m.regularMarketTime >= reg.start : null,
    },
    series,
    today,
  };
}

// 예전에 저장한 기록 읽기 (처음이면 빈 기록)
let history = {};
try {
  history = JSON.parse(await readFile('data/history.json', 'utf8'));
} catch {
  console.log('history.json이 없어서 새로 만듭니다.');
}

const quotes = [];
for (const [name, symbol] of SYMBOLS) {
  try {
    const { quote, series, today } = await getQuote(name, symbol);
    quotes.push(quote);

    // 기록 합치기: 날짜를 열쇠로 써서 같은 날은 새 값으로 덮어쓰고, 새 날은 추가
    const byDate = Object.fromEntries(history[symbol] || []);
    for (const [d, v] of series) byDate[d] = v;
    byDate[today] = quote.price; // 장중이면 오늘 값은 최신 가격으로
    history[symbol] = Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-MAX_DAYS)
      .map(([d, v]) => [d, Number(v.toPrecision(6))]); // 유효숫자 6자리 (0.8915 같은 환율도 살리기)

    // 전일대비는 우리 기록으로 다시 계산: Yahoo 일별 목록엔 어제 줄이 하루 넘게 빠져 있을 때가 있지만,
    // 우리 기록엔 어제 마지막으로 받은 값이 남아 있다
    const prevRow = history[symbol].filter(([d]) => d < today).at(-1);
    if (prevRow) quote.changePct = (quote.price / prevRow[1] - 1) * 100;
  } catch (e) {
    console.error('실패:', e.message); // 하나가 실패해도 나머지는 계속
  }
}

// ── 일본 국채 10년물: 일본 재무성(MOF)이 매일 올리는 이번 달 금리표(CSV) ──
// 한 줄 예: R8.10.30,1.659,...  (R8 = 레이와 8년 = 2026년, 11번째 칸이 10년물)
try {
  const res = await fetch('https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = (await res.text()).split('\n')
    .map(l => l.split(','))
    .filter(c => /^R\d+\.\d+\.\d+$/.test(c[0]) && c[10])
    .map(c => {
      const [y, mo, d] = c[0].slice(1).split('.').map(Number);
      return [`${2018 + y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, Number(c[10])];
    });
  const byDate = Object.fromEntries(history.JGB10 || []);
  for (const [d, v] of rows) byDate[d] = v;
  const all = Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).slice(-MAX_DAYS);
  history.JGB10 = all;
  const [lastD, last] = all[all.length - 1];
  const prev = all.length > 1 ? all[all.length - 2][1] : last;
  quotes.push({ name: '일본 국채 10년물', symbol: 'JGB10', price: last, changePct: (last / prev - 1) * 100,
                time: lastD + 'T15:00:00+09:00' });
} catch (e) {
  console.error('일본 국채 실패:', e.message);
}

const data = { updated: new Date().toISOString(), quotes };
await mkdir('data', { recursive: true });
await writeFile('data/latest.json', JSON.stringify(data, null, 2) + '\n');
await writeFile('data/history.json', JSON.stringify(history) + '\n');
console.log(JSON.stringify(data, null, 2));
for (const s in history) console.log(s, history[s].length + '일치 기록');

// ── 신용융자잔고 · 투자자예탁금: 금융투자협회 통계(FreeSIS) ──
// 금투협 통계 사이트가 표를 채울 때 쓰는 주소에 '어떤 표, 어느 기간'을 보내면 JSON으로 돌려준다
async function getKofia(table, from, to) {
  const res = await fetch('https://freesis.kofia.or.kr/meta/getMetaDataList.do', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ dmSearch: { tmpV40: '1000000', tmpV41: '1', tmpV1: 'D', tmpV45: from, tmpV46: to, OBJ_NM: table } }),
  });
  if (!res.ok) throw new Error(`금투협 ${table}: HTTP ${res.status}`);
  return (await res.json()).ds1; // [{ TMPV1: '20261029', TMPV2: ..., ... }, ...] 최신 날짜가 앞
}

try {
  const ymd = d => d.toISOString().slice(0, 10).replaceAll('-', '');
  const to = ymd(new Date());
  const from = ymd(new Date(Date.now() - 400 * 24 * 3600 * 1000));
  const funds = await getKofia('STATSCU0100000060BO', from, to);  // 증시자금: TMPV2 = 투자자예탁금
  const credit = await getKofia('STATSCU0100000070BO', from, to); // 신용공여: TMPV3 = 코스피, TMPV4 = 코스닥
  const deposit = Object.fromEntries(funds.map(r => [r.TMPV1, r.TMPV2]));

  // 날짜별 [날짜, 코스피 신용, 코스닥 신용, 예탁금] (단위: 조원, 소수 둘째 자리)
  const jo = v => Math.round(v / 1e4) / 100; // 백만원 → 조원
  const rows = credit
    .map(r => [r.TMPV1.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'), jo(r.TMPV3), jo(r.TMPV4), jo(deposit[r.TMPV1] ?? NaN)])
    .sort(([a], [b]) => a.localeCompare(b));
  await writeFile('data/credit.json', JSON.stringify({ updated: new Date().toISOString(), rows }) + '\n');
  console.log('신용잔고', rows.length + '일치, 최근:', rows[rows.length - 1]);
} catch (e) {
  console.error('신용잔고 실패:', e.message); // 실패해도 지수 데이터는 그대로 저장된다
}

// ── 투자자별 순매수(억원): 네이버 증권 모바일 내부 주소 (비공식, 언제든 바뀔 수 있음) ──
// 과거를 한 번에 주지 않으므로 날짜별로 하나씩 물어보고, 우리 쪽 data/flows.json에 직접 쌓는다
try {
  let flows = {};
  try { flows = JSON.parse(await readFile('data/flows.json', 'utf8')); } catch {}
  const num = s => Number(String(s).replace(/[,+]/g, '')); // '+6,028' → 6028

  for (const market of ['KOSPI', 'KOSDAQ']) {
    const byDate = Object.fromEntries((flows[market] || []).map(r => [r[0], r.slice(1)]));
    const back = Object.keys(byDate).length < 20 ? 45 : 7;  // 처음엔 45일치 채우고, 그 뒤로는 최근 1주만
    for (let i = 0; i < back; i++) {
      const d = new Date(Date.now() + 9 * 3600 * 1000 - i * 24 * 3600 * 1000); // 한국 날짜 기준
      const ymd = d.toISOString().slice(0, 10).replaceAll('-', '');
      const res = await fetch(`https://m.stock.naver.com/api/index/${market}/trend?bizdate=${ymd}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`네이버 ${market} ${ymd}: HTTP ${res.status}`);
      const t = await res.json();
      const vals = [num(t.personalValue), num(t.foreignValue), num(t.institutionalValue)];
      if (t.bizdate === ymd && vals.some(v => v !== 0)) {   // 휴장일(전부 0)은 건너뛰기
        byDate[ymd.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')] = vals;
      }
      await new Promise(r => setTimeout(r, 200)); // 상대 서버에 부담 주지 않게 잠깐 쉬기
    }
    flows[market] = Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-MAX_DAYS)
      .map(([d, v]) => [d, ...v]);
  }
  await writeFile('data/flows.json', JSON.stringify(flows) + '\n');
  console.log('수급', flows.KOSPI.length + '일치, 최근 코스피:', flows.KOSPI[flows.KOSPI.length - 1]);
} catch (e) {
  console.error('수급 실패:', e.message);
}

// ── 주요국 기준금리: 국제결제은행(BIS) 정책금리 통계 (키 없이 CSV로 공개) ──
// 나라 코드: KR 한국, US 미국, XM 유로존, JP 일본, AU 호주, GB 영국, CA 캐나다, CN 중국
const BANKS = ['KR', 'US', 'XM', 'JP', 'AU', 'GB', 'CA', 'CN'];
// 3시간에 한 번 (예전 형식이라 '바뀐 날 목록'이 없으면 바로)
if (await stale('data/rates.json', 180) || !(await readFile('data/rates.json', 'utf8').catch(() => '')).includes('"changes"')) try {
  const bis = async (freq, start) => {
    const res = await fetch(`https://stats.bis.org/api/v1/data/WS_CBPOL/${freq}.${BANKS.join('+')}`
      + `?startPeriod=${start}&format=csv&detail=dataonly`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`BIS ${freq}: HTTP ${res.status}`);
    // 한 줄 = FREQ,나라,날짜,값
    return (await res.text()).trim().split('\n').slice(1)
      .map(l => l.trim().split(',')).filter(c => c[3] !== '' && !isNaN(Number(c[3])))
      .map(([, area, t, v]) => [area, t, Number(v)]);
  };
  const monthly = await bis('M', `${new Date().getUTCFullYear() - 5}-01`);   // 5년 그래프용 월별
  const daily = await bis('D', new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10)); // 최근값·결정 결과용
  const rates = {};
  for (const b of BANKS) {
    const d = daily.filter(r => r[0] === b);
    const last = d.at(-1);
    const m = monthly.filter(r => r[0] === b).map(r => [r[1], r[2]]);
    // 금리가 바뀐 날만 남기기: [[날짜, 금리], ...] → 일정표의 '결과: 인상 3.50→3.75%'에 쓴다
    const changes = d.filter((r, i) => i === 0 || r[2] !== d[i - 1][2]).map(r => [r[1], r[2]]);
    rates[b] = { rate: last ? last[2] : m.at(-1)?.[1], asOf: last ? last[1] : m.at(-1)?.[0], src: 'BIS', changes, monthly: m };
  }
  // BIS에 아직 안 들어간 최근 결정은 data/rates-manual.json에 적어 두면 덮어쓴다
  const manual = JSON.parse(await readFile('data/rates-manual.json', 'utf8'));
  for (const [b, o] of Object.entries(manual.override || {})) {
    if (rates[b] && o.since > (rates[b].asOf || '')) {
      Object.assign(rates[b], { rate: o.rate, asOf: o.since, src: o.src });
      rates[b].changes.push([o.since, o.rate]);
    }
  }
  await writeFile('data/rates.json', JSON.stringify({ updated: new Date().toISOString(), rates }) + '\n');
  console.log('기준금리', BANKS.map(b => `${b} ${rates[b].rate}(${rates[b].asOf})`).join(' '));
} catch (e) {
  console.error('기준금리 실패:', e.message);
}

// ── 칼시(Kalshi) 예측시장: 다음 금리 결정에 사람들이 돈을 건 확률 ──
// 가격 0.71달러 = '그 결과가 나올 확률 71%'로 읽는다
const KALSHI = {
  US: 'KXFEDDECISION', KR: 'KXCBDECISIONKOREA', XM: 'KXCBDECISIONEU', JP: 'KXCBDECISIONJAPAN',
  AU: 'KXCBDECISIONAUSTRALIA', GB: 'KXCBDECISIONENGLAND', CA: 'KXCBDECISIONCANADA',
};
function kLabel(s) {   // 'Hike 25bps' → '인상', 'Hike >25bps' → '인상 0.25%p 초과'
  const big = />|more than/i.test(s) ? ' 0.25%p 초과' : '';
  return /cut/i.test(s) ? '인하' + big : /hike/i.test(s) ? '인상' + big : '동결';
}
try {
  const kalshi = {};
  for (const [b, series] of Object.entries(KALSHI)) {
    try {
      const res = await fetch(`https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=${series}`
        + '&status=open&limit=10&with_nested_markets=true', { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const meetings = (await res.json()).events.map(e => {
        const options = e.markets.map(m => {
          const last = Number(m.last_price_dollars), bid = Number(m.yes_bid_dollars), ask = Number(m.yes_ask_dollars);
          return { label: kLabel(m.yes_sub_title || ''), prob: Math.round((last || (bid + ask) / 2) * 100), volume: Number(m.volume_fp || 0) };
        });
        const volume = options.reduce((s, o) => s + o.volume, 0);
        const top = [...options].sort((a, c) => c.prob - a.prob)[0];
        return { ticker: e.event_ticker, close: e.markets[0].close_time, label: top.label, prob: top.prob,
                 thin: volume < 5000, options: options.map(({ label, prob }) => ({ label, prob })) };
      }).filter(m => m.options.some(o => o.prob > 0) && new Date(m.close) > new Date())  // 거래가 있고 아직 안 끝난 회의만
        .sort((a, c) => new Date(a.close) - new Date(c.close));
      kalshi[b] = { series, meetings: meetings.slice(0, 2) };
    } catch (e) {
      console.error(`칼시 ${b} 실패:`, e.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  // 올해 연준 인상·인하 횟수 시장: '정확히 N번' 칸들의 확률로 '추가 인상'과 '인하 0번' 확률을 만든다
  const year = {};
  for (const [key, series] of [['hikes', 'KXRATEHIKE'], ['cuts', 'KXRATECUTCOUNT']]) {
    try {
      const res = await fetch(`https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=${series}`
        + '&status=open&limit=3&with_nested_markets=true', { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ev = (await res.json()).events.find(e => e.event_ticker.includes(String(new Date().getUTCFullYear()).slice(2)));
      if (!ev) continue;
      // 'Exactly 2' → 2, 'At least 4' → 4. 이미 결과가 끝난(마감된) 칸은 빼고, 남은 칸 중 가장 작은 수 = 지금까지 횟수
      const rows = ev.markets.filter(m => m.status === 'active' || new Date(m.close_time) > new Date())
        .map(m => ({ n: Number((m.yes_sub_title.match(/\d+/) || [0])[0]), p: Number(m.last_price_dollars) }));
      const done = Math.min(...rows.map(r => r.n));
      year[key] = { title: ev.title, done, more: Math.round(rows.filter(r => r.n > done).reduce((s, r) => s + r.p, 0) * 100),
                    none: Math.round((rows.find(r => r.n === done)?.p || 0) * 100) };
    } catch (e) {
      console.error(`칼시 ${key} 실패:`, e.message);
    }
  }
  await writeFile('data/kalshi.json', JSON.stringify({ updated: new Date().toISOString(), kalshi, year }) + '\n');
  console.log('칼시', Object.entries(kalshi).map(([b, k]) => `${b} ${k.meetings[0]?.label} ${k.meetings[0]?.prob}%`).join(' '));
} catch (e) {
  console.error('칼시 실패:', e.message);
}

// ── CNN 공포·탐욕 지수: CNN 웹페이지가 그래프를 그릴 때 쓰는 주소 (비공식) ──
// 로봇처럼 보이면 거절(418)하므로 보통 브라우저처럼 머리말을 붙인다
try {
  const res = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*', 'Referer': 'https://edition.cnn.com/', 'Origin': 'https://edition.cnn.com',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const f = j.fear_and_greed, r1 = v => Math.round(v * 10) / 10;
  await writeFile('data/fng.json', JSON.stringify({
    updated: new Date().toISOString(), time: f.timestamp, score: r1(f.score), rating: f.rating,
    prev: r1(f.previous_close), week: r1(f.previous_1_week), month: r1(f.previous_1_month), year: r1(f.previous_1_year),
    history: j.fear_and_greed_historical.data.map(p => [new Date(p.x).toISOString().slice(0, 10), r1(p.y)]),
  }) + '\n');
  console.log('공포탐욕', r1(f.score), f.rating);
} catch (e) {
  console.error('공포탐욕 실패:', e.message);
}

// ── S&P500 밸류에이션: multpl.com 월별 표 (P/E, 경기조정 P/E = CAPE) ──
async function multpl(path) {
  const res = await fetch('https://www.multpl.com/' + path + '/table/by-month', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`multpl ${path}: HTTP ${res.status}`);
  // 표 한 줄 = <td>Oct 30, 2026</td><td> 40.13 </td>  (값 칸의 꾸밈 글자는 지우고 숫자만)
  return [...(await res.text()).matchAll(/<tr[^>]*>\s*<td>([^<]+)<\/td>\s*<td>([\s\S]*?)<\/td>/g)]
    .map(([, d, v]) => [new Date(d + ' UTC').toISOString().slice(0, 10), Number(v.replace(/<[^>]+>|&#?\w+;|[^\d.]/g, ''))])
    .filter(([, v]) => v > 0);   // 최신이 앞
}
if (await stale('data/valuation.json', 360)) try {   // 월별 표라 6시간에 한 번이면 충분
  const stat = rows => {
    const [date, value] = rows[0];
    const last25 = rows.slice(0, 300).map(r => r[1]);   // 최근 25년(300개월)
    return { value, date, pct25: Math.round(last25.filter(v => v < value).length / last25.length * 100),
             mean: Math.round(rows.reduce((s, r) => s + r[1], 0) / rows.length * 10) / 10 };
  };
  const pe = stat(await multpl('s-p-500-pe-ratio'));
  const cape = stat(await multpl('shiller-pe'));
  await writeFile('data/valuation.json', JSON.stringify({ updated: new Date().toISOString(), pe, cape }) + '\n');
  console.log('밸류에이션 P/E', pe.value, 'CAPE', cape.value);
} catch (e) {
  console.error('밸류에이션 실패:', e.message);
}

// ── 미국 지표 실제 발표치: 미국 노동통계국(BLS) 공개 API (키 없이 하루 25번까지) ──
// CPI(전체·근원), PPI(최종수요), 비농업 고용자 수, 실업률 → 일정표의 '결과'에 쓴다
const BLS = { cpi: 'CUUR0000SA0', core: 'CUUR0000SA0L1E', ppi: 'WPUFD4', payrolls: 'CES0000000001', unemp: 'LNS14000000' };
if (await stale('data/bls.json', 360)) try {   // 6시간에 한 번
  const y = new Date().getUTCFullYear();
  const res = await fetch('https://api.bls.gov/publicAPI/v1/timeseries/data/', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ seriesid: Object.values(BLS), startyear: String(y - 1), endyear: String(y) }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.status !== 'REQUEST_SUCCEEDED') throw new Error(j.message?.join(' ') || j.status);
  const bls = { updated: new Date().toISOString() };
  for (const [key, id] of Object.entries(BLS)) {
    const s = j.Results.series.find(x => x.seriesID === id);
    // 'M09' 같은 월만 (M13 = 연평균은 빼기) → [['2026-09', 336.94], ...] 오래된 순
    // 발표가 없던 달은 값이 '-'로 와서 빼기
    bls[key] = (s?.data || []).filter(d => /^M(0[1-9]|1[0-2])$/.test(d.period) && !isNaN(Number(d.value)))
      .map(d => [`${d.year}-${d.period.slice(1)}`, Number(d.value)]).reverse();
  }
  await writeFile('data/bls.json', JSON.stringify(bls) + '\n');
  console.log('BLS', Object.keys(BLS).map(k => `${k} ${bls[k].at(-1)?.join('=')}`).join(' '));
} catch (e) {
  console.error('BLS 실패:', e.message);
}

// ── 카드 아래 뉴스: Google 뉴스 검색 RSS(최근 2일)에서 제목만 가져오기 ──
// RSS = 사이트가 새 글 목록을 기계가 읽기 좋게 내놓는 XML 형식
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

const unescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

async function getNews(query, n) {
  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query + ' when:2d')
    + '&hl=ko&gl=KR&ceid=KR:ko';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`뉴스 "${query}": HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, n).map(([, it]) => {
    const pick = tag => unescape((it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '');
    const source = pick('source');
    // 제목 끝에 붙은 " - 언론사" 떼기
    const title = pick('title').replace(new RegExp(' - ' + source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '');
    return { title, source, link: pick('link'), date: new Date(pick('pubDate')).toISOString() };
  });
}

if (await stale('data/news.json', 50)) try {   // 뉴스 검색은 1시간에 한 번 (검색어가 25개라서)
  const news = {};
  const seen = new Set(); // 같은 기사가 여러 카드에 겹치지 않게
  const take = async (q, n) => {
    try {
      const fresh = (await getNews(q, n + 3)).filter(a => !seen.has(a.title)).slice(0, n);
      fresh.forEach(a => seen.add(a.title));
      return fresh;
    } catch (e) {
      console.error(e.message); // 검색어 하나가 실패해도 나머지 뉴스는 계속
      return [];
    }
  };

  // 다가오는 일정 2개(휴장 제외)의 관련 뉴스: 일정 제목으로 검색해서 { 제목: [기사] } 로 저장
  const events = JSON.parse(await readFile('data/events.json', 'utf8'))
    .filter(e => new Date(e.date) > new Date() && e.kind !== 'HOLIDAY')
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  news.events = {};
  for (const e of events.slice(0, 2)) {
    const q = e.title.replace(/\(.*?\)/g, '').replace(/[—+]/g, ' ').trim();  // 괄호 설명·기호는 빼고 검색
    news.events[e.title] = await take(q, 3);
  }

  for (const [key, list] of Object.entries(NEWS)) {
    news[key] = [];
    for (const [tag, q] of list) {
      for (const a of await take(q, 1)) news[key].push({ tag, ...a });
      await new Promise(r => setTimeout(r, 300));
    }
  }
  await writeFile('data/news.json', JSON.stringify({ updated: new Date().toISOString(), ...news }, null, 1) + '\n');
  console.log('뉴스', Object.entries(news).map(([k, v]) => k + ':' + Object.keys(v).length).join(' '));
} catch (e) {
  console.error('뉴스 실패:', e.message);
}
