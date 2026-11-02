// GitHub Actions가 30분마다 실행하는 수집 스크립트
// 브라우저에서는 CORS 때문에 못 가져오는 Yahoo Finance 데이터를 대신 모아서
// data/latest.json(최신값)과 data/history.json(날짜별 기록)으로 저장한다.

import { mkdir, readFile, writeFile } from 'node:fs/promises';

// 가져올 종목: [화면에 보일 이름, Yahoo 종목 코드]
const SYMBOLS = [
  ['S&P 500', '^GSPC'],
  ['나스닥', '^IXIC'],
  ['코스피', '^KS11'],
  ['코스닥', '^KQ11'],
  ['원/달러 (실시간)', 'KRW=X'],
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

  const price = result.meta.regularMarketPrice;
  const prev = series[series.length - 2][1]; // 끝에서 두 번째 = 전일 종가

  return {
    quote: {
      name,
      symbol,
      price,
      changePct: (price / prev - 1) * 100,
      time: new Date(result.meta.regularMarketTime * 1000).toISOString(),
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
      .map(([d, v]) => [d, Math.round(v * 100) / 100]);
  } catch (e) {
    console.error('실패:', e.message); // 하나가 실패해도 나머지는 계속
  }
}

const data = { updated: new Date().toISOString(), quotes };
await mkdir('data', { recursive: true });
await writeFile('data/latest.json', JSON.stringify(data, null, 2) + '\n');
await writeFile('data/history.json', JSON.stringify(history) + '\n');
console.log(JSON.stringify(data, null, 2));
for (const s in history) console.log(s, history[s].length + '일치 기록');
