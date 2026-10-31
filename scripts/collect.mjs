// GitHub Actions가 30분마다 실행하는 수집 스크립트
// 브라우저에서는 CORS 때문에 못 가져오는 Yahoo Finance 데이터를 대신 모아서
// data/latest.json 파일로 저장한다.

import { mkdir, writeFile } from 'node:fs/promises';

// 가져올 종목: [화면에 보일 이름, Yahoo 종목 코드]
const SYMBOLS = [
  ['S&P 500', '^GSPC'],
  ['나스닥', '^IXIC'],
  ['코스피', '^KS11'],
  ['코스닥', '^KQ11'],
  ['원/달러 (실시간)', 'KRW=X'],
];

async function getQuote(name, symbol) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'
    + encodeURIComponent(symbol) + '?range=5d&interval=1d';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const result = (await res.json()).chart.result[0];

  // 최근 5일 종가 중 비어 있지 않은 값만 골라, 끝에서 두 번째를 '전일 종가'로 사용
  const closes = result.indicators.quote[0].close.filter(v => v != null);
  const price = result.meta.regularMarketPrice;
  const prev = closes[closes.length - 2];

  return {
    name,
    symbol,
    price,
    changePct: (price / prev - 1) * 100,
    time: new Date(result.meta.regularMarketTime * 1000).toISOString(),
  };
}

const quotes = [];
for (const [name, symbol] of SYMBOLS) {
  try {
    quotes.push(await getQuote(name, symbol));
  } catch (e) {
    console.error('실패:', e.message); // 하나가 실패해도 나머지는 계속
  }
}

const data = { updated: new Date().toISOString(), quotes };
await mkdir('data', { recursive: true });
await writeFile('data/latest.json', JSON.stringify(data, null, 2) + '\n');
console.log(JSON.stringify(data, null, 2));
