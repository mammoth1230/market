// GitHub Actions가 30분마다 실행하는 수집 스크립트
// 브라우저에서는 CORS 때문에 못 가져오는 Yahoo Finance 데이터를 대신 모아서
// data/latest.json(최신값)과 data/history.json(날짜별 기록)으로 저장한다.
// 금융투자협회 신용잔고·예탁금은 data/credit.json, 네이버 수급은 data/flows.json,
// 일본 국채는 history.json의 JGB10, Google 뉴스 제목은 data/news.json으로 저장한다.

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
  const prev = series[series.length - 2][1]; // 끝에서 두 번째 = 전일 종가
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
      open: reg ? now >= reg.start && now < reg.end : null, // 지금 장이 열려 있나
    },
    series,
    today: toDate(result.meta.regularMarketTime + offset),
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

try {
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
