require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const express   = require("express");
const cors      = require("cors");
const axios     = require("axios");
const NodeCache = require("node-cache");

const app   = express();
const cache = new NodeCache({ stdTTL: 300 });
const PORT  = process.env.PORT || 3001;
const KEY   = process.env.TWELVE_DATA_API_KEY;
const AKEY  = process.env.ANTHROPIC_API_KEY;
const FFKEY = process.env.FINANCEFLOW_API_KEY;
const FF_BASE = "https://financeflowapi.com/api/v1";
const BASE  = "https://api.twelvedata.com";

// ── IG MARKETS (forex/CFD execution) ──────────────────────────────────────────
const IG_API_KEY    = process.env.IG_API_KEY;
const IG_IDENTIFIER = process.env.IG_IDENTIFIER;
const IG_PASSWORD   = process.env.IG_PASSWORD;
const IG_DEMO       = (process.env.IG_DEMO || "true") === "true"; // default to demo for safety
const IG_BASE = IG_DEMO ? "https://demo-api.ig.com/gateway/deal" : "https://api.ig.com/gateway/deal";

// EPIC mapping — IG's internal instrument codes for forex CFDs
const IG_EPICS = {
  "EUR/USD":"CS.D.EURUSD.CFD.IP", "GBP/USD":"CS.D.GBPUSD.CFD.IP",
  "USD/JPY":"CS.D.USDJPY.CFD.IP", "USD/CHF":"CS.D.USDCHF.CFD.IP",
  "AUD/USD":"CS.D.AUDUSD.CFD.IP", "USD/CAD":"CS.D.USDCAD.CFD.IP",
  "EUR/GBP":"CS.D.EURGBP.CFD.IP", "EUR/JPY":"CS.D.EURJPY.CFD.IP",
  "BTC/USD":"CS.D.BITCOIN.CFD.IP", "ETH/USD":"CS.D.ETHUSD.CFD.IP",
  "SOL/USD":"CS.D.SOLUSD.CFD.IP",
};

// Session cache — IG tokens last up to 72h while in use, but we refresh defensively every 5h
let igSession = { cst:null, securityToken:null, fetchedAt:0 };
const IG_SESSION_TTL = 5 * 60 * 60 * 1000;

async function igLogin() {
  if (!IG_API_KEY || !IG_IDENTIFIER || !IG_PASSWORD) {
    throw new Error("Credenciais IG não configuradas no .env (IG_API_KEY, IG_IDENTIFIER, IG_PASSWORD)");
  }
  const now = Date.now();
  if (igSession.cst && now - igSession.fetchedAt < IG_SESSION_TTL) return igSession;

  const { data, headers } = await axios.post(`${IG_BASE}/session`,
    { identifier: IG_IDENTIFIER, password: IG_PASSWORD },
    { headers: { "X-IG-API-KEY": IG_API_KEY, "Content-Type":"application/json", "Accept":"application/json; charset=UTF-8", "Version":"2" }, timeout: 15000 }
  );
  igSession = { cst: headers["cst"], securityToken: headers["x-security-token"], fetchedAt: now, accountId: data.currentAccountId };
  console.log(`[ig] Login OK — ${IG_DEMO?"DEMO":"⚠️ LIVE"} account ${data.currentAccountId}`);
  return igSession;
}

function igHeaders(session) {
  return {
    "X-IG-API-KEY": IG_API_KEY,
    "CST": session.cst,
    "X-SECURITY-TOKEN": session.securityToken,
    "Content-Type": "application/json; charset=UTF-8",
    "Accept": "application/json; charset=UTF-8",
  };
}

// Place a market order with attached stop-loss and take-profit (absolute price levels)
async function igPlaceOrder({ symbol, direction, size, stopLevel, limitLevel }) {
  const epic = IG_EPICS[symbol];
  if (!epic) throw new Error(`Par ${symbol} não mapeado para EPIC IG`);
  const session = await igLogin();

  const body = {
    epic, expiry: "-", direction, // "BUY" or "SELL"
    size: String(size),
    orderType: "MARKET",
    level: null, quoteId: null,
    guaranteedStop: false,
    stopLevel: stopLevel ?? null,
    stopDistance: null,
    limitLevel: limitLevel ?? null,
    limitDistance: null,
    trailingStop: false,
    forceOpen: true,
    currencyCode: "USD",
    timeInForce: "EXECUTE_AND_ELIMINATE",
  };

  const { data } = await axios.post(`${IG_BASE}/positions/otc`, body,
    { headers: { ...igHeaders(session), "Version":"2" }, timeout: 15000 }
  );
  const dealReference = data.dealReference;

  // Confirm the deal — IG orders are async, the actual fill status comes from /confirms
  await new Promise(r => setTimeout(r, 1500)); // brief wait before confirming
  const { data: confirm } = await axios.get(`${IG_BASE}/confirms/${dealReference}`,
    { headers: igHeaders(session), timeout: 15000 }
  );
  return { dealReference, confirm };
}

async function igGetPositions() {
  const session = await igLogin();
  const { data } = await axios.get(`${IG_BASE}/positions`,
    { headers: { ...igHeaders(session), "Version":"2" }, timeout: 15000 }
  );
  return data.positions || [];
}

// Closes an existing position. IG's REST API closes positions via a POST to the
// same /positions/otc endpoint with a "_method: DELETE" header override (their own
// documented workaround for clients/proxies that strip DELETE bodies), sending the
// OPPOSITE direction + same size + the position's dealId AND epic/expiry — confirmed
// against IG's reference Python client (ig-markets-rest-api-python-library), which
// includes epic/expiry/level/orderType/quoteId/size alongside dealId, not dealId alone.
async function igClosePosition({ dealId, direction, size, epic }) {
  const session = await igLogin();
  const closeDirection = direction === "BUY" ? "SELL" : "BUY"; // must invert to close
  const body = {
    dealId,
    epic: epic || null,
    expiry: "-",
    direction: closeDirection,
    size: String(size),
    orderType: "MARKET",
    level: null,
    quoteId: null,
    timeInForce: "EXECUTE_AND_ELIMINATE",
  };
  const { data } = await axios.post(`${IG_BASE}/positions/otc`, body,
    { headers: { ...igHeaders(session), "Version":"1", "_method":"DELETE" }, timeout: 15000 }
  );
  const dealReference = data.dealReference;
  await new Promise(r => setTimeout(r, 1500));
  const { data: confirm } = await axios.get(`${IG_BASE}/confirms/${dealReference}`,
    { headers: igHeaders(session), timeout: 15000 }
  );
  return { dealReference, confirm };
}

async function igGetAccountBalance() {
  const session = await igLogin();
  const { data } = await axios.get(`${IG_BASE}/accounts`,
    { headers: igHeaders(session), timeout: 15000 }
  );
  const acc = data.accounts?.find(a => a.accountId === session.accountId) || data.accounts?.[0];
  return acc ? { balance: acc.balance.balance, available: acc.balance.available, currency: acc.currency, accountId: acc.accountId } : null;
}

app.use(cors({ origin: "*" }));
app.use(express.json());

process.on("unhandledRejection", (err) => {
  console.error("[server] Unhandled rejection:", err?.message || err);
});

// ── RATE LIMITER + DEDUP ──────────────────────────────────────────────────────
const inFlight = new Map();
let lastCallTime = 0;

async function td(endpoint, params) {
  const ck = endpoint + JSON.stringify(params);
  const hit = cache.get(ck);
  if (hit) return hit;
  if (inFlight.has(ck)) {
    console.log(`  [dedup] ${params.symbol||""}`);
    return inFlight.get(ck);
  }
  const promise = (async () => {
    const wait = Math.max(0, lastCallTime + 1000 - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCallTime = Date.now();
    console.log(`  [API] ${endpoint} ${params.symbol||""}`);
    try {
      const { data } = await axios.get(`${BASE}${endpoint}`, {
        params: { ...params, apikey: KEY }, timeout: 15000,
      });
      if (data.status === "error") throw new Error(data.message);
      cache.set(ck, data);
      return data;
    } catch (err) {
      if (err.response?.status === 429) {
        console.warn(`  [429] ${params.symbol||""} — waiting 61s...`);
        await new Promise(r => setTimeout(r, 61000));
        lastCallTime = Date.now();
        const { data } = await axios.get(`${BASE}${endpoint}`, {
          params: { ...params, apikey: KEY }, timeout: 15000,
        });
        if (data.status === "error") throw new Error(data.message);
        cache.set(ck, data);
        return data;
      }
      throw err;
    }
  })();
  inFlight.set(ck, promise);
  promise.finally(() => inFlight.delete(ck));
  return promise;
}

// ── MATH HELPERS ──────────────────────────────────────────────────────────────
function calcEMA(arr, period) {
  const n = Math.min(period, arr.length);
  const k = 2 / (n + 1);
  let v = arr.slice(0, n).reduce((s, x) => s + x, 0) / n;
  for (let i = n; i < arr.length; i++) v = arr[i] * k + v * (1 - k);
  return v;
}
function calcATR(closes, highs, lows, period = 14) {
  // BUGFIX: previously summed highs[1..n]/lows[1..n] — the OLDEST bars in the array,
  // not the most recent. ATR(14) must always be a sliding window ending at the
  // LATEST bar. This mattered most in the backtest, where `closes` grows every
  // iteration — the old code kept ATR pinned near the start of the whole history
  // instead of reacting to volatility around the simulated date.
  const n = Math.min(period, closes.length - 1);
  const start = closes.length - n; // first index of the trailing window
  let sum = 0;
  for (let i = start; i < closes.length; i++) {
    const prevClose = closes[i-1];
    sum += Math.max(highs[i]-lows[i], Math.abs(highs[i]-prevClose), Math.abs(lows[i]-prevClose));
  }
  return sum / n;
}
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i]-closes[i-1]; d>0?g+=d:l-=d; }
  let ag = g/period, al = l/period;
  for (let i = period+1; i < closes.length; i++) {
    const d = closes[i]-closes[i-1];
    ag = (ag*(period-1)+Math.max(d,0))/period;
    al = (al*(period-1)+Math.max(-d,0))/period;
  }
  return al===0?100:100-100/(1+ag/al);
}
function calcMACD(closes) {
  if (closes.length < 26) return { macd:0, signal:0, hist:0 };
  const series = [];
  for (let i = 26; i <= closes.length; i++)
    series.push(calcEMA(closes.slice(0,i),12) - calcEMA(closes.slice(0,i),26));
  const macdLine = series[series.length-1];
  const sigLine  = series.length >= 9 ? calcEMA(series, 9) : macdLine;
  return { macd: macdLine, signal: sigLine, hist: macdLine - sigLine };
}
function parseCandles(values) {
  const rev = [...values].reverse();
  return {
    closes: rev.map(v => parseFloat(v.close)),
    highs:  rev.map(v => parseFloat(v.high)),
    lows:   rev.map(v => parseFloat(v.low)),
    raw:    rev,
  };
}

// ── CANDLESTICK PATTERN DETECTION ──────────────────────────────────────────────
// Detects the most widely-recognised reversal/continuation patterns on the most
// recent candle(s). This is ADDITIONAL CONTEXT for the AI report and the Guide —
// it deliberately does NOT factor into the existing 3/3 confluence count or the
// ⭐ qualification system, both of which are already calibrated against real
// backtest data (2026-06-29, 11 pairs). Mixing a more subjective signal into that
// rigid count would invalidate the calibration without new data to justify it.
// Revisit this decision after running a backtest that includes candlestick patterns.
function detectCandlePatterns(bars) {
  // bars: array of {open, high, low, close}, OLDEST FIRST, needs at least 3 entries
  if (!bars || bars.length < 3) return [];
  const patterns = [];
  const c0 = bars[bars.length-1]; // most recent (today/last close)
  const c1 = bars[bars.length-2]; // previous
  const c2 = bars[bars.length-3]; // two back (for 3-candle patterns)

  const body  = c => Math.abs(c.close - c.open);
  const range = c => c.high - c.low;
  const upperWick = c => c.high - Math.max(c.open, c.close);
  const lowerWick = c => Math.min(c.open, c.close) - c.low;
  const isBull = c => c.close > c.open;
  const isBear = c => c.close < c.open;

  // Avoid division by zero on flat/illiquid bars
  const r0 = range(c0) || 0.0001;
  const b0 = body(c0);

  // 1. Bullish Engulfing — bearish candle followed by a larger bullish candle
  //    that fully engulfs its body. Classic reversal signal at the bottom of a move.
  if (isBear(c1) && isBull(c0) && c0.close > c1.open && c0.open < c1.close) {
    patterns.push({ name:"Bullish Engulfing", bias:"bullish", strength:"forte",
      desc:"Vela bearish seguida por uma vela bullish maior que a engole completamente — reversão de fundo." });
  }
  // 2. Bearish Engulfing — mirror of the above, at the top of a move
  if (isBull(c1) && isBear(c0) && c0.open > c1.close && c0.close < c1.open) {
    patterns.push({ name:"Bearish Engulfing", bias:"bearish", strength:"forte",
      desc:"Vela bullish seguida por uma vela bearish maior que a engole completamente — reversão de topo." });
  }
  // 3. Hammer — small body near the top of the range, long lower wick (≥2x body),
  //    minimal upper wick. Signals rejection of lower prices — bullish at support.
  //    Wick threshold is range-relative (not body-relative) — a tiny body shouldn't
  //    make an otherwise-clear small upper wick disqualify the pattern.
  if (b0 > 0 && lowerWick(c0) >= b0 * 2 && upperWick(c0) <= r0 * 0.15 && b0 / r0 < 0.35) {
    patterns.push({ name:"Hammer (Martelo)", bias:"bullish", strength:"moderada",
      desc:"Pavio inferior longo (≥2× corpo) com pouco pavio superior — rejeição de preços mais baixos." });
  }
  // 4. Shooting Star — mirror of Hammer, long upper wick, small body near the bottom.
  //    Signals rejection of higher prices — bearish at resistance.
  if (b0 > 0 && upperWick(c0) >= b0 * 2 && lowerWick(c0) <= r0 * 0.15 && b0 / r0 < 0.35) {
    patterns.push({ name:"Shooting Star (Estrela Cadente)", bias:"bearish", strength:"moderada",
      desc:"Pavio superior longo (≥2× corpo) com pouco pavio inferior — rejeição de preços mais altos." });
  }
  // 5. Doji — open and close almost identical, signals indecision. Direction depends
  //    on what preceded it: after a strong trend, often precedes a reversal.
  //    Excludes candles already classified as Hammer/Shooting Star (those are more
  //    specific, directional patterns and should take priority over generic Doji).
  const alreadyDirectional = patterns.some(p => p.name.startsWith("Hammer") || p.name.startsWith("Shooting Star"));
  if (b0 / r0 < 0.1 && !alreadyDirectional) {
    const precedingBull = isBull(c1);
    patterns.push({ name:"Doji", bias: precedingBull ? "bearish (potencial)" : "bullish (potencial)", strength:"fraca",
      desc:"Abertura e fecho quase idênticos — indecisão do mercado, possível pausa ou reversão após tendência." });
  }
  // 6. Morning Star — 3-candle bottom reversal: big bearish, small-body indecision
  //    candle gapping down, then a big bullish candle closing well into candle 1's body.
  if (isBear(c2) && body(c2) > range(c2)*0.5 &&
      body(c1) < range(c2)*0.3 &&
      isBull(c0) && c0.close > (c2.open + c2.close)/2) {
    patterns.push({ name:"Morning Star (Estrela da Manhã)", bias:"bullish", strength:"forte",
      desc:"3 velas: forte queda, indecisão, depois forte recuperação — reversão de fundo clássica." });
  }
  // 7. Evening Star — mirror of Morning Star, top reversal
  if (isBull(c2) && body(c2) > range(c2)*0.5 &&
      body(c1) < range(c2)*0.3 &&
      isBear(c0) && c0.close < (c2.open + c2.close)/2) {
    patterns.push({ name:"Evening Star (Estrela da Noite)", bias:"bearish", strength:"forte",
      desc:"3 velas: forte subida, indecisão, depois forte queda — reversão de topo clássica." });
  }

  return patterns;
}

// Scans the last N bars (default 15) and detects patterns on EACH bar individually
// (not just the most recent), returning the full OHLC sequence plus where patterns
// occurred — this powers the visual mini-chart and a short trend narrative, giving
// context beyond "today's single pattern" so the user can see the recent "shape"
// of price action, not just an isolated signal.
function analyzeCandleHistory(bars, count = 15) {
  if (!bars || bars.length < count + 3) return { candles: [], patternHits: [], trendSummary: "" };

  const recent = bars.slice(-count);
  const candles = recent.map((b, i) => {
    // detectCandlePatterns needs 3 trailing bars ending at the candle being evaluated —
    // reuse the full `bars` array (not just `recent`) so the first few candles in the
    // window still have correct prior-bar context instead of being artificially truncated.
    const absoluteIdx = bars.length - count + i;
    const windowEnd = absoluteIdx + 1;
    const window = bars.slice(Math.max(0, windowEnd - 10), windowEnd); // up to 10 bars of context
    const patternsHere = window.length >= 3 ? detectCandlePatterns(window) : [];
    return { ...b, patterns: patternsHere };
  });

  const patternHits = candles
    .map((c, i) => ({ index: i, date: c.date, patterns: c.patterns }))
    .filter(c => c.patterns.length > 0);

  // Simple trend narrative: count up/down closes, net change, and how many
  // bullish vs bearish patterns occurred in the window.
  let upDays = 0, downDays = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close > recent[i-1].close) upDays++;
    else if (recent[i].close < recent[i-1].close) downDays++;
  }
  const netChangePct = ((recent[recent.length-1].close - recent[0].close) / recent[0].close) * 100;
  const bullishPatternCount = patternHits.reduce((s,h) => s + h.patterns.filter(p=>p.bias.startsWith("bullish")).length, 0);
  const bearishPatternCount = patternHits.reduce((s,h) => s + h.patterns.filter(p=>p.bias.startsWith("bearish")).length, 0);

  let trendSummary;
  if (Math.abs(netChangePct) < 0.3) {
    trendSummary = `Últimas ${count} velas em range lateral (${netChangePct>=0?"+":""}${netChangePct.toFixed(2)}%) — ${upDays} dias de alta, ${downDays} de baixa.`;
  } else if (netChangePct > 0) {
    trendSummary = `Tendência de alta nas últimas ${count} velas (${netChangePct>=0?"+":""}${netChangePct.toFixed(2)}%) — ${upDays} dias de alta vs ${downDays} de baixa.`;
  } else {
    trendSummary = `Tendência de baixa nas últimas ${count} velas (${netChangePct.toFixed(2)}%) — ${downDays} dias de baixa vs ${upDays} de alta.`;
  }
  if (bullishPatternCount > bearishPatternCount) {
    trendSummary += ` ${bullishPatternCount} padrão(ões) bullish detectado(s) na janela vs ${bearishPatternCount} bearish.`;
  } else if (bearishPatternCount > bullishPatternCount) {
    trendSummary += ` ${bearishPatternCount} padrão(ões) bearish detectado(s) na janela vs ${bullishPatternCount} bullish.`;
  }

  return { candles, patternHits, trendSummary, netChangePct: Math.round(netChangePct*100)/100, upDays, downDays };
}

// ── SESSIONS ──────────────────────────────────────────────────────────────────
const SESSIONS = {
  "EUR/USD": { best:["Londres 07h–10h","NY AM 13h30–16h"],   avoid:"Asiática (00h–07h)",  notes:"Máxima liquidez na sobreposição Londres/NY" },
  "GBP/USD": { best:["Londres 07h–10h","NY AM 13h30–16h"],   avoid:"Asiática (00h–07h)",  notes:"Spreads mais baixos na abertura de Londres" },
  "USD/JPY": { best:["Asiática 00h–07h","Londres 08h–10h"],  avoid:"NY tarde (18h–22h)",  notes:"Maior volatilidade na sessão de Tokyo (01h Lisboa)" },
  "USD/CHF": { best:["Londres 08h–11h","NY AM 13h30–16h"],   avoid:"Asiática (00h–06h)",  notes:"Activo na sobreposição europeia" },
  "AUD/USD": { best:["Asiática 00h–07h","Sydney 23h–01h"],   avoid:"NY tarde (18h–22h)",  notes:"Par asiático — activo quando Tokyo e Sydney abrem" },
  "USD/CAD": { best:["NY AM 13h30–17h"],                     avoid:"Asiática e madrugada", notes:"Par norte-americano — máxima liquidez em NY" },
  "EUR/GBP": { best:["Londres 07h–11h"],                     avoid:"Fora da Europa (18h–07h)", notes:"Exclusivamente europeu — inactivo fora de Londres" },
  "EUR/JPY": { best:["Sobreposição 07h–09h","Asiática 02h–06h"], avoid:"NY tarde", notes:"Activo na sobreposição Europa/Ásia" },
  // Crypto — 24/7, but high-volume windows exist
  "BTC/USD": { best:["Londres 07h–10h","NY AM 13h30–16h","Qualquer hora"], avoid:"Fins de semana à noite (liquidez baixa)", notes:"Cripto 24/7 — maior volume nos horários de sobreposição forex" },
  "ETH/USD": { best:["Londres 07h–10h","NY AM 13h30–16h","Qualquer hora"], avoid:"Fins de semana à noite (liquidez baixa)", notes:"Cripto 24/7 — segue o padrão do BTC em termos de liquidez" },
  "SOL/USD": { best:["NY AM 13h30–16h","Qualquer hora"], avoid:"Fins de semana à noite (liquidez baixa)", notes:"Cripto 24/7 — maior volatilidade durante horário americano" },
};

function getSessionInfo(symbol) {
  const sess = SESSIONS[symbol] || SESSIONS["EUR/USD"];
  const now  = new Date();
  const h    = now.getUTCHours() + (now.getUTCMonth()>=3&&now.getUTCMonth()<=9?1:0);
  const cur  = h>=0&&h<7?"Asiática":h>=7&&h<10?"Killzone Londres":h>=10&&h<13?"Londres tarde":h>=13&&h<16?"Killzone NY AM":h>=16&&h<18?"NY tarde":"Fora de sessão principal";
  const ideal= sess.best.some(s=>s.toLowerCase().includes(h<7?"asiática":h<10?"londres":h<16?"ny":"fora"));
  const next = ideal?`Agora (${cur})`:h<7?`Hoje às 07h00 Lisboa (Killzone Londres)`:h<13?`Hoje às 13h30 Lisboa (Killzone NY AM)`:`Amanhã às 07h00 Lisboa (Killzone Londres)`;
  return { sess, cur, ideal, next, h };
}

// ── MACRO ECONOMIC CALENDAR (FinanceFlowAPI) ──────────────────────────────────
let macroCache = { data: null, fetchedAt: 0 };
const MACRO_TTL = 6 * 60 * 60 * 1000; // 6h cache — events change rarely within a day
const MACRO_COUNTRIES = ["United States","Euro Area","United Kingdom","Japan","Canada","Switzerland","Australia"];

// Currency -> country mapping for relevance filtering
const CCY_COUNTRY = {
  USD:"United States", EUR:"Euro Area", GBP:"United Kingdom",
  JPY:"Japan", CAD:"Canada", CHF:"Switzerland", AUD:"Australia",
};

async function fetchMacroEvents() {
  if (!FFKEY) return [];
  const now = Date.now();
  if (macroCache.data && now - macroCache.fetchedAt < MACRO_TTL) return macroCache.data;

  const dateFrom = new Date().toISOString().slice(0,10);
  const to = new Date(Date.now() + 6*24*60*60*1000); // 6 days ahead (safe under 60-day limit)
  const dateTo = to.toISOString().slice(0,10);

  const allEvents = [];
  for (const country of MACRO_COUNTRIES) {
    try {
      const { data } = await axios.get(`${FF_BASE}/financial-calendar`, {
        params: { api_key: FFKEY, country, date_from: dateFrom, date_to: dateTo },
        timeout: 10000,
      });
      if (data?.data) allEvents.push(...data.data.map(e => ({ ...e, country })));
    } catch (e) {
      console.error(`[macro] ${country}:`, e.response?.data?.message || e.message);
    }
  }

  macroCache = { data: allEvents, fetchedAt: now };
  console.log(`[macro] Cached ${allEvents.length} events across ${MACRO_COUNTRIES.length} countries`);
  return allEvents;
}

// Get events relevant to a symbol (e.g. EUR/USD -> Euro Area + United States events)
// within the next `hoursAhead` hours, filtered to Moderate/Major impact only
function getRelevantMacroEvents(symbol, events, hoursAhead = 24) {
  const ccys = symbol.replace(/[^A-Z/]/g,"").split("/");
  const countries = ccys.map(c => CCY_COUNTRY[c]).filter(Boolean);
  if (countries.length === 0) return [];

  const now = Date.now();
  const cutoff = now + hoursAhead * 60 * 60 * 1000;

  return events
    .filter(e => countries.includes(e.country))
    .filter(e => e.economicImpact === "Major" || e.economicImpact === "Moderate")
    .map(e => ({ ...e, ts: new Date(e.datetime.replace(" ","T")+"Z").getTime() }))
    .filter(e => e.ts >= now && e.ts <= cutoff)
    .sort((a,b) => a.ts - b.ts);
}

app.get("/api/macro-events", async (req, res) => {
  try {
    const { symbol } = req.query;
    const events = await fetchMacroEvents();
    if (symbol) {
      const relevant = getRelevantMacroEvents(symbol, events, 48);
      return res.json({ symbol, events: relevant, count: relevant.length });
    }
    res.json({ events, count: events.length, cached_at: new Date(macroCache.fetchedAt).toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) =>
  res.json({ status:"ok", key_set:!!KEY, ai_key:!!AKEY,
    cache_keys:cache.keys().length, time:new Date().toISOString() })
);
app.get("/api/test", async (_req, res) => {
  try { const d = await td("/quote",{symbol:"EUR/USD"}); res.json({ok:true,eur_usd:d.close}); }
  catch(e) { res.status(500).json({ok:false,error:e.message}); }
});
app.get("/api/indicators", async (req, res) => {
  const { symbol="EUR/USD", interval="1day" } = req.query;
  try {
    const d = await td("/time_series",{symbol,interval,outputsize:500});
    const {closes,highs,lows,raw} = parseCandles(d.values);
    const isJpy = symbol.includes("JPY");
    const atr   = calcATR(closes,highs,lows);
    res.json({ symbol,interval,rsi:calcRSI(closes),macd:calcMACD(closes),atr,
      ema50:calcEMA(closes,50),ema200:calcEMA(closes,200),
      price:closes[closes.length-1],change_pct:((closes[closes.length-1]-closes[closes.length-2])/closes[closes.length-2])*100,
      high:parseFloat(raw[raw.length-1].high),low:parseFloat(raw[raw.length-1].low) });
  } catch(e) { console.error(`[indicators] ${symbol}:`,e.message); res.status(500).json({error:e.message}); }
});
app.get("/api/candles", async (req, res) => {
  const {symbol="EUR/USD",interval="1day",outputsize=60} = req.query;
  try {
    const d = await td("/time_series",{symbol,interval,outputsize});
    const {raw} = parseCandles(d.values);
    res.json({symbol,interval,candles:raw.map(v=>({datetime:v.datetime,open:parseFloat(v.open),high:parseFloat(v.high),low:parseFloat(v.low),close:parseFloat(v.close)}))});
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.get("/api/quote", async (req, res) => {
  const {symbol="EUR/USD"} = req.query;
  try {
    const d = await td("/time_series",{symbol,interval:"1day",outputsize:500});
    const {closes,raw} = parseCandles(d.values);
    const price=closes[closes.length-1],prev=closes[closes.length-2];
    res.json({symbol,price,open:parseFloat(raw[0].open),high:parseFloat(raw[raw.length-1].high),low:parseFloat(raw[raw.length-1].low),change:price-prev,change_pct:((price-prev)/prev)*100});
  } catch(e) { res.status(500).json({error:e.message}); }
});
let scanPromise = null;
let lastScanResult = null;
let lastScanTime = 0;
app.get("/api/scan", async (req, res) => {
  // If scan already running, wait for it
  if (scanPromise) {
    try {
      const result = await scanPromise;
      return res.json(result);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }
  // If last scan was < 30s ago, return cached result
  if (lastScanResult && Date.now() - lastScanTime < 30000) {
    return res.json(lastScanResult);
  }
  const PAIRS=["EUR/USD","GBP/USD","USD/JPY","USD/CHF","AUD/USD","USD/CAD","EUR/GBP","EUR/JPY","BTC/USD","ETH/USD","SOL/USD"];
  const TIER1=["EUR/USD","GBP/USD","USD/JPY","USD/CHF"];
  const CRYPTO=["BTC/USD","ETH/USD","SOL/USD"];
  const results=[];
  // Wrap in a promise so concurrent requests can await it
  let resolvePromise, rejectPromise;
  scanPromise = new Promise((res, rej) => { resolvePromise = res; rejectPromise = rej; });
  console.log(`\n[scan] Starting ${PAIRS.length} pairs`);
  for (const symbol of PAIRS) {
    try {
      const d = await td("/time_series",{symbol,interval:"1day",outputsize:500});
      const {closes,highs,lows,raw} = parseCandles(d.values);
      const isJpy=symbol.includes("JPY");
      const isCrypto=["BTC/USD","ETH/USD","SOL/USD"].includes(symbol);
      const atrVal=calcATR(closes,highs,lows);
      // Crypto: show ATR in USD (not pips), Forex: pips
      const atrPips=isCrypto?Math.round(atrVal):Math.round(atrVal*(isJpy?100:10000));
      const ema50v=calcEMA(closes,50),ema200v=calcEMA(closes,200);
      const price=closes[closes.length-1],prev=closes[closes.length-2],today=raw[raw.length-1];
      const rsiVal=calcRSI(closes),macdVal=calcMACD(closes);
      const {ideal,cur} = getSessionInfo(symbol);
      // Candlestick patterns — additional context only, not part of the 3/3 confluence
      const candleBars = raw.slice(-5).map(v => ({
        open: parseFloat(v.open), high: parseFloat(v.high), low: parseFloat(v.low), close: parseFloat(v.close),
      }));
      const candlePatterns = detectCandlePatterns(candleBars);
      results.push({symbol,price,change_pct:((price-prev)/prev)*100,
        high:parseFloat(today.high),low:parseFloat(today.low),
        atr_pips:atrPips,atr_raw:atrVal,rsi:rsiVal,macd:macdVal,
        ema50:ema50v,ema200:ema200v,trend:price>ema200v?"bull":"bear",
        tier:TIER1.includes(symbol)?1:isCrypto?"crypto":2,
        is_crypto:isCrypto,
        ideal_session:ideal,
        candle_patterns:candlePatterns});
      console.log(`  ✓ ${symbol.padEnd(7)} ${price.toFixed(isJpy?2:4).padEnd(10)} ATR=${isCrypto?"$":""}${String(atrPips).padEnd(4)}${isCrypto?"":"p"} RSI=${rsiVal.toFixed(1)} ${ideal?"✅":"⏳"}${candlePatterns.length?` 🕯️${candlePatterns.map(p=>p.name).join(",")}`:""}`);
    } catch(e) { console.error(`  ✗ ${symbol}:`,e.message); }
  }
  scanInProgress = false;
  const output = {pairs:results.sort((a,b)=>b.atr_pips-a.atr_pips),scanned_at:new Date().toISOString()};
  console.log(`[scan] Done: ${results.length}/${PAIRS.length}\n`);
  lastScanResult = output;
  lastScanTime = Date.now();
  if(resolvePromise) resolvePromise(output);
  scanPromise = null;
  res.json(output);
  // Check technical + macro alerts in background (after responding to client)
  checkAlerts(results);
  checkMacroAlerts(results).catch(()=>{});
});

// ── ALERTS ENGINE ─────────────────────────────────────────────────────────────
// Stores active alerts and their triggered state
const alertsStore = {
  rules: [], // user-defined alert rules
  triggered: [], // alerts that fired
};

// Check alerts against current scan data
function checkAlerts(pairs) {
  const now = new Date().toISOString();
  pairs.forEach(p => {
    const {symbol,rsi,atr_pips,trend,macd,ideal_session} = p;
    const bull = trend === "bull";
    const macdBull = (macd?.hist||0) > 0;
    const confluence = (bull?1:0) + (macdBull?1:0) + ((rsi>50&&bull)||(rsi<50&&!bull)?1:0);

    // Auto-alert conditions
    const conditions = [
      { id:`${symbol}_oversold`,    label:`${symbol} sobrevendido`, msg:`RSI ${rsi.toFixed(1)} — possível reversão LONG`,  active: rsi < 32 },
      { id:`${symbol}_overbought`,  label:`${symbol} sobrecomprado`,msg:`RSI ${rsi.toFixed(1)} — possível reversão SHORT`, active: rsi > 68 },
      { id:`${symbol}_confluence`,  label:`${symbol} confluência ✅`,msg:`${confluence}/3 sinais · ATR ${atr_pips}p · ${trend==="bull"?"Bullish":"Bearish"}`, active: confluence >= 3 },
      { id:`${symbol}_ideal_window`,label:`${symbol} janela ideal 🕐`,msg:`Sessão ideal activa agora — ${trend==="bull"?"Bullish":"Bearish"}`, active: ideal_session && confluence >= 2 },
    ];

    conditions.forEach(c => {
      if (c.active) {
        const existing = alertsStore.triggered.find(t => t.id === c.id);
        if (!existing) {
          const alert = { id:c.id, symbol, label:c.label, msg:c.msg, time:now, read:false };
          alertsStore.triggered.unshift(alert);
          if (alertsStore.triggered.length > 50) alertsStore.triggered.pop();
          console.log(`  🔔 ALERTA: ${c.label} — ${c.msg}`);
        }
      } else {
        // Reset so it can fire again if condition re-activates
        alertsStore.triggered = alertsStore.triggered.filter(t => t.id !== c.id);
      }
    });
  });
}

app.get("/api/alerts", (_req, res) => {
  res.json({ alerts: alertsStore.triggered, count: alertsStore.triggered.filter(a=>!a.read).length });
});
app.post("/api/alerts/read", (req, res) => {
  const { id } = req.body;
  if (id === "all") alertsStore.triggered.forEach(a => a.read = true);
  else { const a = alertsStore.triggered.find(t=>t.id===id); if(a) a.read=true; }
  res.json({ ok: true });
});

// Check macro events against active pairs — fires alerts for imminent Major events
async function checkMacroAlerts(pairs) {
  if (!FFKEY) return;
  try {
    const allEvents = await fetchMacroEvents();
    const now = new Date().toISOString();
    pairs.forEach(p => {
      const relevant = getRelevantMacroEvents(p.symbol, allEvents, 4); // next 4h only
      relevant.forEach(e => {
        if (e.economicImpact !== "Major") return;
        const id = `macro_${p.symbol}_${e.report_name}_${e.datetime}`.replace(/\s+/g,"_");
        const existing = alertsStore.triggered.find(t => t.id === id);
        if (!existing) {
          const hoursAway = Math.round((e.ts - Date.now())/3600000*10)/10;
          const alert = { id, symbol:p.symbol, label:`${p.symbol} evento macro 🚨`,
            msg:`${e.country} — ${e.report_name} em ${hoursAway}h (impacto ALTO)`, time:now, read:false };
          alertsStore.triggered.unshift(alert);
          if (alertsStore.triggered.length > 50) alertsStore.triggered.pop();
          console.log(`  🚨 MACRO: ${alert.label} — ${alert.msg}`);
        }
      });
    });
  } catch(e) { console.error("[macro-alerts]", e.message); }
}

// ── MASTER PROMPT v6 REPORT ───────────────────────────────────────────────────
app.post("/api/report", async (req, res) => {
  if (!AKEY) return res.status(400).json({error:"ANTHROPIC_API_KEY não configurada no .env"});
  const {symbol,price,change_pct,high,low,atr_pips,rsi,macd,ema50,ema200,trend,candle_patterns} = req.body;
  const bull=trend==="bull", mb=(macd?.hist||0)>0;
  const patterns = candle_patterns || []; // reuse what /api/scan already computed — avoids a redundant API call

  // Ajuste 1 (2026-06-30): a strong candlestick pattern (Engulfing or Morning/Evening
  // Star — the two "forte" tier patterns) whose bias directly opposes the technical
  // trend direction now DETERMINISTICALLY forces AGUARDAR, the same way an imminent
  // Major macro event already does. This was motivated by a real GBP/USD SHORT entry
  // on 2026-06-29 that hit SL — reconstructing the report afterwards showed a Hammer
  // contradicting the entry, but candlestick wasn't built yet so it had no gating
  // power, only descriptive text. Relying on the AI to *read* the contradiction in the
  // prompt and choose AGUARDAR isn't reliable enough on its own — this makes it a hard
  // rule, not a suggestion, exactly like the macro-event gate below.
  const oppositeBias = bull ? "bearish" : "bullish";
  const hasStrongContraryPattern = patterns.some(p => p.strength === "forte" && p.bias.startsWith(oppositeBias));

  // Ajuste 2 (2026-06-30): the 11-pair backtest run on 2026-06-29 showed Confluência
  // 3/3 LOSES consistently and with large samples on these two pairs specifically —
  // GBP/USD (PF 0.74, -11.4%, 63 trades) and EUR/JPY (PF 0.59, -18.0%, 75 trades).
  // The ⭐ qualification system already excludes them entirely (see
  // QUALIFY_EXCLUDED_PAIRS in App.jsx), but until now the AI report itself had no
  // awareness of this — it could (and did, on 2026-06-29) recommend a confident
  // COMPRAR/VENDER on GBP/USD with only 3/3 confluence, the exact setup that loses
  // historically. This raises the bar specifically for these two pairs: require the
  // SAME 3/3 confluence as elsewhere PLUS an additional explicit caution layer in the
  // prompt, and deterministically cap confidence so a "RECOMENDADO" here can never
  // read as equally trustworthy as a recommendation on a pair the backtest supports.
  const BACKTEST_CAUTION_PAIRS = {
    "GBP/USD": "Backtest (2026-06-29, 63 trades): Confluência 3/3 perde -11.4% historicamente neste par (profit factor 0.74).",
    "EUR/JPY": "Backtest (2026-06-29, 75 trades): Confluência 3/3 perde -18.0% historicamente neste par (profit factor 0.59, o pior de todos os 11 pares testados).",
  };
  const backtestCaution = BACKTEST_CAUTION_PAIRS[symbol] || null;

  // Ajuste 3 (2026-06-30): the same backtest showed Confluência 3/3 LOSES on all
  // three crypto pairs (BTC -12.3%/PF0.30, ETH -20.6%/PF0.00, SOL -13.5%/PF0.11),
  // while RSI Extremo (RSI≤30 or ≥70) WINS on all three (PF 1.38-1.47 — remarkably
  // consistent). The ⭐ qualification system already uses RSI Extremo as the crypto
  // path instead of confluence (see isQualified() in App.jsx), but the AI report
  // itself was still treating crypto identically to forex — same 3/3-confluence
  // framing throughout the prompt. This adds a crypto-specific instruction so the
  // report's own reasoning matches what we already know works for these three pairs,
  // rather than chasing a confluence signal that has a proven negative edge here.
  const cryptoGuidance = ["BTC/USD","ETH/USD","SOL/USD"].includes(symbol)
    ? `Para pares CRYPTO (confirmado por backtest 2026-06-29): Confluência 3/3 PERDE consistentemente em BTC/USD (-12.3%, PF 0.30), ETH/USD (-20.6%, PF 0.00) e SOL/USD (-13.5%, PF 0.11). RSI Extremo (RSI≤30 ou RSI≥70) GANHA consistentemente nos três (PF 1.38-1.47). Para este par, prioriza RSI extremo como critério principal de entrada — só recomenda COMPRAR/VENDER se RSI estiver em zona extrema (≤30 ou ≥70) na direcção coerente com a entrada, mesmo que a confluência técnica das EMAs/MACD pareça forte. Se RSI estiver em zona neutra (35-65), trata isso como motivo para AGUARDAR independentemente de outros sinais.`
    : null;

  // Fetch the last ~20 candles (with pattern detection per-candle) for the visual
  // mini-chart + trend narrative. Reuses td()'s cache, so this is usually a free
  // cache hit right after a scan rather than a fresh API call.
  let candleHistory = { candles: [], patternHits: [], trendSummary: "" };
  try {
    const d = await td("/time_series", { symbol, interval:"1day", outputsize:500 });
    const raw = [...d.values].reverse();
    const bars = raw.map(v => ({
      date: v.datetime, open: parseFloat(v.open), high: parseFloat(v.high),
      low: parseFloat(v.low), close: parseFloat(v.close),
    }));
    candleHistory = analyzeCandleHistory(bars, 15);
  } catch(e) { console.error("[report] candle history fetch failed:", e.message); }

  // Fetch real macro events for this pair's currencies (next 48h)
  let macroEvents = [];
  try {
    const allEvents = await fetchMacroEvents();
    macroEvents = getRelevantMacroEvents(symbol, allEvents, 48);
  } catch(e) { console.error("[report] macro fetch failed:", e.message); }
  const f4=n=>(typeof n==="number"?n.toFixed(4):"—");
  const f2=n=>(typeof n==="number"?n.toFixed(2):"—");
  const isJpy=symbol.includes("JPY");
  const isCrypto=["BTC/USD","ETH/USD","SOL/USD"].includes(symbol);
  const atrUnit=isCrypto?"USD":"pips";
  // For crypto: use USD levels scaled to ATR. For forex: use pip levels.
  const PIPS = isCrypto
    ? [Math.round(atr_pips*0.2), Math.round(atr_pips*0.5), Math.round(atr_pips*0.8),
       Math.round(atr_pips*1.0), Math.round(atr_pips*1.5), Math.round(atr_pips*2.0),
       Math.round(atr_pips*3.0), Math.round(atr_pips*4.0), Math.round(atr_pips*5.0), Math.round(atr_pips*7.0)]
    : [50,100,150,200,250,300,350,400,450,500];
  const confluence=(bull?1:0)+(mb?1:0)+((rsi>50&&bull)||(rsi<50&&!bull)?1:0);
  const m=confluence;
  const ladder=PIPS.map(p=>({pips:p,prob:Math.min(97,Math.max(3,Math.round(100*Math.exp(-0.55*p/Math.max(atr_pips,1)))+m*4))}));
  const {sess,cur,ideal,next} = getSessionInfo(symbol);

  // Price levels for S/R estimation
  const slPips = Math.round(atr_pips * 1.2);
  const slPrice = bull ? (price - slPips*(isJpy?0.01:0.0001)).toFixed(isJpy?2:4) : (price + slPips*(isJpy?0.01:0.0001)).toFixed(isJpy?2:4);
  const tp1Pips = Math.round(atr_pips * 0.8);
  const tp2Pips = Math.round(atr_pips * 1.8);
  const tp3Pips = Math.round(atr_pips * 3.0);
  const dir = bull ? 1 : -1;
  const pip = isJpy ? 0.01 : 0.0001;
  const tp1 = (price + dir*tp1Pips*pip).toFixed(isJpy?2:4);
  const tp2 = (price + dir*tp2Pips*pip).toFixed(isJpy?2:4);
  const tp3 = (price + dir*tp3Pips*pip).toFixed(isJpy?2:4);

  // Format real macro events for the prompt (or note their absence)
  const macroText = macroEvents.length > 0
    ? macroEvents.map(e => {
        const eventTime = new Date(e.ts);
        const hoursAway = Math.round((e.ts - Date.now()) / 3600000 * 10) / 10;
        return `[${e.economicImpact==="Major"?"🔴 ALTO":"🟡 MÉDIO"}] ${e.country} — ${e.report_name} — ${eventTime.toLocaleString("pt-PT",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})} (em ${hoursAway}h) | Previous: ${e.previous||"—"} | Consensus: ${e.consensus||"—"}`;
      }).join("\n")
    : "Sem eventos de impacto Moderado/Major identificados nas próximas 48h para as moedas deste par.";
  const hasImminentMajor = macroEvents.some(e => e.economicImpact === "Major" && e.ts - Date.now() < 4*3600000);
  const hasImminentModerate = macroEvents.some(e => (e.economicImpact === "Major"||e.economicImpact === "Moderate") && e.ts - Date.now() < 4*3600000);

  const prompt = `És um analista de forex profissional sénior. Analisa ${symbol} com dados reais e devolve APENAS JSON válido.

═══════════════════════════════════════════════════════
DADOS DE MERCADO REAIS (${new Date().toLocaleString("pt-PT")})
═══════════════════════════════════════════════════════
Par: ${symbol} | Preço: ${f4(price)} | Variação: ${f2(change_pct)}%
High/Low: ${f4(high)} / ${f4(low)} | ATR(14): ${atr_pips} pips
RSI(14): ${rsi?.toFixed(1)} ${rsi>70?"⚠️ SOBRECOMPRADO":rsi<30?"⚠️ SOBREVENDIDO":""}
MACD histograma: ${(macd?.hist||0).toFixed(5)} (${mb?"Bullish ✓":"Bearish ✗"})
EMA50: ${f4(ema50)} | EMA200: ${f4(ema200)}
Preço vs EMA50:  ${bull&&price>ema50?"ACIMA ✓":"ABAIXO ✗"}
Preço vs EMA200: ${bull&&price>ema200?"ACIMA ✓":"ABAIXO ✗"} → Tendência ${bull?"BULLISH":"BEARISH"}
Confluência técnica: ${confluence}/3 sinais alinhados

═══════════════════════════════════════════════════════
CALENDÁRIO ECONÓMICO REAL — Próximas 48h (fonte: FinanceFlowAPI)
═══════════════════════════════════════════════════════
${macroText}
${hasImminentMajor ? "\n⚠️⚠️ ALERTA: Evento de ALTO impacto nas próximas 4h — recomenda fortemente AGUARDAR ou reduzir confiança." : hasImminentModerate ? "\n⚠️ Aviso: Evento de impacto Moderado/Major nas próximas 4h — considera isso na confiança." : ""}

═══════════════════════════════════════════════════════
ANÁLISE DE SESSÃO
═══════════════════════════════════════════════════════
Sessão actual: ${cur} ${ideal?"✅ JANELA IDEAL":"⚠️ FORA DA JANELA"}
Melhores janelas para ${symbol}: ${sess.best.join(" | ")}
Evitar: ${sess.avoid}
Nota: ${sess.notes}
Próxima janela ideal: ${next}

═══════════════════════════════════════════════════════
PADRÕES DE CANDLESTICK (vela mais recente, contexto adicional — NÃO faz parte da contagem de confluência 3/3)
═══════════════════════════════════════════════════════
${patterns.length > 0
  ? patterns.map(p => `[${p.strength.toUpperCase()}] ${p.name} — viés ${p.bias} — ${p.desc}`).join("\n")
  : "Nenhum padrão de candlestick relevante identificado na vela mais recente."}
${patterns.some(p=>p.bias.includes(bull?"bearish":"bullish")) ? "\n⚠️ Atenção: padrão de candlestick detectado aponta na direcção OPOSTA à tendência técnica — menciona esta divergência explicitamente na análise." : ""}
${hasStrongContraryPattern ? `\n⚠️⚠️ REGRA OBRIGATÓRIA: Padrão de candlestick FORTE (Engulfing ou Star) com viés ${oppositeBias} contradiz directamente a direcção ${bull?"LONG":"SHORT"} sugerida pela tendência. Isto FORÇA "action":"AGUARDAR" e "confidence"≤40, independentemente de quantas confluências técnicas estejam alinhadas. Caso real que motivou esta regra: entrada SHORT em GBP/USD a 29/06 ignorou um Hammer contrário e fechou em SL.` : ""}
${candleHistory.trendSummary ? `\nContexto das últimas 15 velas: ${candleHistory.trendSummary}` : ""}
${candleHistory.patternHits?.length>1 ? `Padrões adicionais detectados na janela recente (não só hoje): ${candleHistory.patternHits.map(h=>h.patterns.map(p=>p.name).join("+")).join(", ")} — considera isto como reforço ou contradição da narrativa actual.` : ""}

${backtestCaution ? `═══════════════════════════════════════════════════════
⚠️ AVISO DE BACKTEST — PAR DE RISCO ELEVADO COMPROVADO
═══════════════════════════════════════════════════════
${backtestCaution}
REGRA OBRIGATÓRIA: Neste par específico, RECOMENDADO exige ≥3 confluências SEM excepção (não aceitar 2/3 mesmo com outros factores fortes), e "confidence" nunca pode exceder 55 mesmo num cenário perfeito — a evidência histórica deste par já demonstrou que confluência técnica forte não é suficiente para garantir sucesso aqui. Menciona este aviso de backtest explicitamente no "verdict" e nos "risks".
` : ""}
${cryptoGuidance ? `═══════════════════════════════════════════════════════
₿ ORIENTAÇÃO ESPECÍFICA PARA CRYPTO — RSI EXTREMO PRIORITÁRIO
═══════════════════════════════════════════════════════
${cryptoGuidance}
` : ""}

═══════════════════════════════════════════════════════
ANÁLISE INSTITUCIONAL (inferida dos dados técnicos)
═══════════════════════════════════════════════════════
COT inferido: ${bull&&rsi<60?"Large Speculators provavelmente LONG":!bull&&rsi>40?"Large Speculators provavelmente SHORT":"Posicionamento neutro/indefinido"}
Order Block estimado: ${bull?`Zona de suporte ${f4(ema50)} (EMA50) — possível OB bullish`:`Zona de resistência ${f4(ema50)} (EMA50) — possível OB bearish`}
Fair Value Gap: ${Math.abs(price-parseFloat(ema50||0))>atr_pips*0.0001?`Desequilíbrio entre preço e EMA50 — zona de FVG potencial`:"Preço próximo das médias — sem FVG evidente"}
Liquidez: Máximos recentes ${f4(high)} e mínimos ${f4(low)} são alvos de liquidez institucionais
Stop Hunt risk: ${rsi>65||rsi<35?"⚠️ ELEVADO — RSI extremo atrai stops":"Baixo — RSI em zona neutra"}
Killzone activa: ${ideal?"✅ SIM — melhor momento para executar":"❌ NÃO — aguardar próxima janela"}

═══════════════════════════════════════════════════════
PIP PROBABILITY LADDER (50–500 pips)
═══════════════════════════════════════════════════════
${ladder.map(l=>`+${l.pips}p: ${l.prob}% ${l.prob>=80?"🟢 Quase certo":l.prob>=60?"🟢 Alta":l.prob>=40?"🟡 Moderada":l.prob>=20?"🟠 Baixa":"🔴 Improvável"}`).join("\n")}

═══════════════════════════════════════════════════════
REFERÊNCIA DE NÍVEIS (usa como base, ajusta à estrutura técnica)
═══════════════════════════════════════════════════════
Direcção sugerida: ${bull?"LONG 📈":"SHORT 📉"}
ATR(14): ${atr_pips} ${isCrypto?"USD":"pips"} — usa para calibrar SL e TPs
SL sugerido: ${bull?"abaixo":"acima"} do último swing ${bull?"low":"high"} / Order Block

INSTRUÇÃO: Com base em TODOS os dados acima, devolve este JSON exacto:
{
  "recommendation": "RECOMENDADO" ou "NAO_RECOMENDADO",
  "direction": "LONG" ou "SHORT" ou null,
  "confidence": número 0-100,
  "action": "COMPRAR" ou "VENDER" ou "AGUARDAR" — instrução directa e literal do que fazer,
  "verdict": "1-2 frases directas — mencionar confluência e sessão",
  "summary": "3-4 frases análise técnica completa com EMAs, RSI, MACD e momentum",
  "session_analysis": {
    "current_session": "${cur}",
    "is_ideal": ${ideal},
    "best_windows": ${JSON.stringify(sess.best)},
    "avoid": "${sess.avoid}",
    "notes": "${sess.notes}",
    "recommendation": "instrução clara: quando e como entrar com hora Lisboa",
    "next_ideal_window": "${next}"
  },
  "candlestick_analysis": "${patterns.length>0?"comenta o(s) padrão(ões) listado(s) acima — se confirma ou contradiz a tendência técnica, e como isso afecta a tua confiança":"Sem padrão de candlestick relevante na vela mais recente — diz isso claramente em 1 frase"}",
  "institutional": {
    "available": false,
    "bias": "Bullish" ou "Bearish" ou "Neutro",
    "cot_inference": "o que o posicionamento dos grandes players provavelmente indica",
    "order_block": "zona de OB identificada e relevância",
    "fvg": "Fair Value Gap — existe ou não, e onde",
    "stop_hunt_risk": "probabilidade de stop hunt antes da entrada",
    "notes": "síntese do posicionamento institucional inferido"
  },
  "volume_analysis": {
    "relative": "Alto" ou "Médio" ou "Baixo",
    "trend": "texto",
    "notes": "nota sobre volume e liquidez nesta sessão"
  },
  "entry": {
    "zone": "preço ou zona exacta de entrada",
    "type": "LIMIT" ou "MARKET",
    "condition": "condição técnica para entrar — ex: aguardar pullback para EMA50",
    "notes": "entrar APENAS na Killzone ${sess.best[0]}"
  },
  "stop_loss": { "price": "calcula baseado em estrutura técnica", "pips": 0, "logic": "justificação do SL" },
  "take_profits": [
    {"level": 1, "price": "calcula", "pips": 0, "close_pct": 50, "target": "TP conservador"},
    {"level": 2, "price": "calcula", "pips": 0, "close_pct": 30, "target": "TP principal"},
    {"level": 3, "price": "calcula", "pips": 0, "close_pct": 20, "target": "TP estendido"}
  ],
  "risk_reward": "R/B calculado para TP2",
  "macro_warning": "baseado nos eventos reais listados acima — se houver evento Major/Moderate nas próximas 4-12h, menciona-o explicitamente com nome e hora; se não houver nada relevante, diz isso claramente",
  "risks": [
    "risco técnico principal",
    "risco de sessão/liquidez",
    "risco macro ou evento externo — verificar calendário económico manualmente"
  ],
  "checklist": [
    "✅ ou ❌ Confluência ≥3 sinais",
    "✅ ou ❌ Sessão ideal activa",
    "✅ ou ❌ RSI não em extremo contrário",
    "✅ ou ❌ SL além de estrutura lógica",
    "✅ ou ❌ Sem evento macro ≤4h"
  ],
  "pip_ladder": ${JSON.stringify(ladder)}
}
Regras: RECOMENDADO apenas se ≥3 confluências E sem evento Major nas próximas 4h. Se houver evento Major iminente (<4h), força "action":"AGUARDAR" independentemente da confluência técnica e reduz a "confidence" para ≤40. O campo "action" deve ser literal e directo: "COMPRAR" significa abrir posição LONG, "VENDER" significa abrir posição SHORT, "AGUARDAR" significa não entrar agora. Português europeu. Zero texto fora do JSON.`;

  try {
    const {data} = await axios.post("https://api.anthropic.com/v1/messages",
      {model:"claude-sonnet-4-5",max_tokens:3000,
       system:"Analista forex sénior com Master Prompt v6. Responde APENAS JSON válido, sem markdown.",
       messages:[{role:"user",content:prompt}]},
      {headers:{"x-api-key":AKEY,"anthropic-version":"2023-06-01","Content-Type":"application/json"},timeout:60000}
    );
    const raw=data.content?.find(b=>b.type==="text")?.text||"{}";
    const cleaned = raw.replace(/```json|```/g,"").trim();
    // Extract only the first complete JSON object — ignore any trailing text/numbers
    let jsonStr = null;
    let depth = 0, start = cleaned.indexOf('{');
    if (start >= 0) {
      for (let i = start; i < cleaned.length; i++) {
        if (cleaned[i]==='{') depth++;
        else if (cleaned[i]==='}') { depth--; if(depth===0){ jsonStr=cleaned.slice(start,i+1); break; } }
      }
    }
    if(!jsonStr) {
      console.error("[report] Raw AI response:", raw.slice(0,500));
      throw new Error("JSON inválido na resposta IA");
    }
    const result = JSON.parse(jsonStr);
    // DETERMINISTIC ENFORCEMENT — the prompt instructs the AI to force AGUARDAR for
    // imminent Major macro events and strong contrary candlestick patterns, but an
    // LLM instruction is a strong suggestion, not a guarantee. Enforce both rules here
    // in code so they can NEVER be silently skipped, regardless of what the model returns.
    if (hasImminentMajor || hasStrongContraryPattern) {
      const reasons = [];
      if (hasImminentMajor) reasons.push("evento macro Major nas próximas 4h");
      if (hasStrongContraryPattern) reasons.push(`padrão de candlestick forte (${patterns.find(p=>p.strength==="forte")?.name}) contrário à tendência`);
      if (result.action !== "AGUARDAR") {
        console.log(`[report] FORCED AGUARDAR — was "${result.action}", reasons: ${reasons.join(", ")}`);
      }
      result.action = "AGUARDAR";
      result.recommendation = "NAO_RECOMENDADO";
      result.confidence = Math.min(result.confidence ?? 40, 40);
    }
    // Ajuste 2 enforcement: on backtest-flagged pairs, confidence can NEVER exceed 55
    // regardless of what the AI returns — this is a hard ceiling, not a suggestion,
    // because the backtest already proved 3/3-confluence setups lose money here on
    // large samples. A confident-sounding 80%+ recommendation on GBP/USD or EUR/JPY
    // would contradict evidence we already have, so it's capped before the user ever sees it.
    if (backtestCaution && typeof result.confidence === "number" && result.confidence > 55) {
      console.log(`[report] CAPPED confidence on ${symbol} — was ${result.confidence}, capped to 55 (backtest caution pair)`);
      result.confidence = 55;
    }
    // Ajuste 3 enforcement: on crypto pairs, force AGUARDAR when RSI sits in the
    // neutral zone (35-65) — the backtest proved RSI Extremo is the ONLY profitable
    // signal for BTC/ETH/SOL (Confluência 3/3 loses on all three), so a recommendation
    // built on confluence alone, without RSI confirming an extreme, is exactly the
    // setup that historically failed. This is deterministic, not advisory, matching
    // the same enforcement pattern as Ajuste 1 (candlestick) and the macro-event gate.
    const cryptoRsiNeutral = isCrypto && typeof rsi === "number" && rsi > 35 && rsi < 65;
    if (cryptoRsiNeutral && result.action !== "AGUARDAR") {
      console.log(`[report] FORCED AGUARDAR — crypto pair ${symbol} with RSI=${rsi} in neutral zone, was "${result.action}"`);
      result.action = "AGUARDAR";
      result.recommendation = "NAO_RECOMENDADO";
      result.confidence = Math.min(result.confidence ?? 35, 35);
    }
    // Sanitise risk_reward — extract only "1:X.X" pattern. BUGFIX: `if(result.risk_reward)`
    // alone misses the numeric 0 case (0 is falsy, so the block was skipped entirely and
    // a literal 0 passed straight through to the frontend, where `0 && <JSX>` short-circuits
    // to the number 0 itself instead of rendering nothing — React then prints it as a stray
    // text node, invisible until the user selects the whole page). Now explicitly normalise
    // anything that isn't a valid "1:X.X" string to null, regardless of falsy/truthy type.
    {
      const m = String(result.risk_reward ?? "").match(/1:[\d.]+/);
      result.risk_reward = m ? m[0] : null;
    }
    // Ensure stop_loss.price and take_profit prices are strings, not numbers
    if(result.stop_loss?.price) result.stop_loss.price = String(result.stop_loss.price);
    if(result.take_profits) result.take_profits = result.take_profits.map(tp=>({...tp, price:String(tp.price||"—")}));
    // Remove any numeric top-level fields that could render as stray text
    // (sometimes AI returns extra fields not in the schema)
    const ALLOWED = ["recommendation","direction","action","confidence","verdict","summary",
      "session_analysis","volume_analysis","institutional","entry","stop_loss",
      "take_profits","risks","checklist","risk_reward","pip_ladder","macro_warning","candlestick_analysis"];
    Object.keys(result).forEach(k => { if(!ALLOWED.includes(k)) { console.log(`[report] Removing extra field: ${k} =`, result[k]); delete result[k]; } });
    console.log("[report] risk_reward:", result.risk_reward);
    // Attach raw real macro events (for UI display, independent of AI's text summary)
    result.macro_events = macroEvents.map(e => ({
      country: e.country, report_name: e.report_name, economicImpact: e.economicImpact,
      datetime: e.datetime, previous: e.previous, consensus: e.consensus, actual: e.actual,
    }));
    // Attach raw candle patterns too (for UI display, independent of AI's text summary)
    result.candle_patterns = patterns;
    // Expose whether AGUARDAR was code-enforced (not the AI's own choice) and why,
    // so the frontend can show a clear, unmissable badge instead of this only
    // existing as buried prose in the verdict/risks text.
    if (hasImminentMajor || hasStrongContraryPattern) {
      result.forced_wait_reasons = [
        hasImminentMajor ? "Evento macro de Alto impacto nas próximas 4h" : null,
        hasStrongContraryPattern ? `Padrão de candlestick forte (${patterns.find(p=>p.strength==="forte")?.name}) contrário à tendência` : null,
      ].filter(Boolean);
    }
    // Ajuste 2: expose the backtest caution so the frontend can show a persistent
    // badge on GBP/USD and EUR/JPY reports, even when the recommendation IS positive —
    // unlike forced_wait_reasons (which only fires when AGUARDAR is forced), this is
    // informational on every report for these two pairs, since the confidence cap
    // applies regardless of the final action.
    if (backtestCaution) {
      result.backtest_caution = backtestCaution;
    }
    // Ajuste 3: expose crypto RSI guidance so the frontend can show a persistent
    // badge on BTC/ETH/SOL reports explaining the RSI-Extremo-priority rule, plus
    // whether this specific report's RSI is in the neutral zone that triggers the
    // forced AGUARDAR (cryptoRsiNeutral).
    if (cryptoGuidance) {
      result.crypto_rsi_guidance = {
        message: "Backtest (2026-06-29): para crypto, RSI Extremo (≤30 ou ≥70) é o único sinal historicamente lucrativo — Confluência 3/3 perde nos 3 pares (BTC -12.3%, ETH -20.6%, SOL -13.5%).",
        rsi_neutral: cryptoRsiNeutral,
      };
    }
    // Attach the 15-candle history for the visual mini-chart and trend narrative
    result.candle_history = {
      candles: candleHistory.candles,
      pattern_hits: candleHistory.patternHits,
      trend_summary: candleHistory.trendSummary,
      net_change_pct: candleHistory.netChangePct,
      up_days: candleHistory.upDays,
      down_days: candleHistory.downDays,
    };
    // Check alerts after report
    if (req.body.scanPairs) checkAlerts(req.body.scanPairs);
    res.json(result);
  } catch(e) { console.error("[report]",e.message); res.status(500).json({error:e.message}); }
});

// Auto-check alerts every 10 min using cached scan data (avoid double scans)
setInterval(async () => {
  try {
    const PAIRS=["EUR/USD","GBP/USD","USD/JPY","USD/CHF","AUD/USD","USD/CAD","EUR/GBP","EUR/JPY"];
    const pairs = [];
    for (const symbol of PAIRS) {
      const ck = "/time_series" + JSON.stringify({symbol,interval:"1day",outputsize:500});
      const cached = cache.get(ck);
      if (cached) {
        const {closes,highs,lows} = parseCandles(cached.values);
        const atrVal=calcATR(closes,highs,lows);
        const isJpy=symbol.includes("JPY");
        const ema200v=calcEMA(closes,200);
        const price=closes[closes.length-1];
        const {ideal}=getSessionInfo(symbol);
        pairs.push({symbol,price,rsi:calcRSI(closes),macd:calcMACD(closes),
          atr_pips:Math.round(atrVal*(isJpy?100:10000)),
          trend:price>ema200v?"bull":"bear",ideal_session:ideal});
      }
    }
    if (pairs.length > 0) checkAlerts(pairs);
  } catch(e) { /* silent */ }
}, 5 * 60 * 1000);

// ── BACKTEST ENGINE ───────────────────────────────────────────────────────────
// Extracted from the original /api/backtest route so the same logic can run for one
// pair (existing endpoint) or for all pairs in sequence (new /api/backtest-all route)
// without duplicating ~200 lines of simulation code.
async function runBacktest(symbol) {
  const d = await td("/time_series", { symbol, interval:"1day", outputsize:500 });
  const raw = [...d.values].reverse(); // oldest first
  const isJpy = symbol.includes("JPY");
  const isCrypto = ["BTC/USD","ETH/USD","SOL/USD"].includes(symbol);

  // Build OHLCV array
  const bars = raw.map(v => ({
    date: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low:  parseFloat(v.low),
    close: parseFloat(v.close),
  }));

  // Session hours (UTC) for each symbol
  const SESSION_HOURS = {
    "EUR/USD": [7,16], "GBP/USD": [7,16], "USD/CHF": [7,16],
    "EUR/GBP": [7,11], "AUD/USD": [0,7],  "USD/CAD": [13,17],
    "USD/JPY": [0,9],  "EUR/JPY": [7,9],
    "BTC/USD": [0,24], "ETH/USD": [0,24], "SOL/USD": [0,24],
  };
  const [sessStart, sessEnd] = SESSION_HOURS[symbol] || [7,16];

  const trades = {
    confluence: [],   // RSI+MACD+EMA200 all aligned
    rsi_extreme: [],  // RSI<30 LONG or RSI>70 SHORT
    session: [],      // same as confluence but only in session hours
    all_signals: [],  // any 2+ signals
  };

  const ladderHits = { total:0, hits:{} };
  const PIP_MULT = isCrypto ? 1 : (isJpy ? 100 : 10000);

  // Simulate from bar 200 onwards (need history for indicators)
  for (let i = 200; i < bars.length - 1; i++) {
    const slice   = bars.slice(0, i+1);
    const closes  = slice.map(b => b.close);
    const highs   = slice.map(b => b.high);
    const lows    = slice.map(b => b.low);

    // Calculate indicators
    const rsi    = calcRSI(closes);
    const macd   = calcMACD(closes);
    const ema50  = calcEMA(closes, 50);
    const ema200 = calcEMA(closes, 200);
    const atr    = calcATR(closes, highs, lows);
    const price  = closes[closes.length-1];
    const bull   = price > ema200;
    const macdB  = macd.hist > 0;

    // Signal conditions
    const trendOk    = bull;
    const macdOk     = macdB;
    const rsiOk      = (bull && rsi < 60 && rsi > 40) || (!bull && rsi > 40 && rsi < 60);
    const confluence = (trendOk ? 1:0) + (macdOk ? 1:0) + (rsiOk ? 1:0);

    const rsiLong  = rsi < 30;
    const rsiShort = rsi > 70;

    const dateStr  = bars[i].date;
    const dayOfWk  = new Date(dateStr).getUTCDay();
    const inSession = dayOfWk >= 1 && dayOfWk <= 5; // weekday = session for daily bars

    // Entry price = next bar open
    const entry   = bars[i+1].open;
    const atrPips = atr * PIP_MULT;
    const slDist  = atr * 1.2;
    const tp1Dist = atr * 1.8;
    const tp2Dist = atr * 3.0;

    // Simulate trade outcome by scanning forward up to MAX_HOLD_BARS for SL/TP1/TP2.
    const MAX_HOLD_BARS = 20; // ~4 trading weeks — reasonable swing-trade horizon
    function simTrade(dir) {
      if (i + 1 >= bars.length) return null;
      const sl  = dir === "LONG" ? entry - slDist  : entry + slDist;
      const tp1 = dir === "LONG" ? entry + tp1Dist : entry - tp1Dist;
      const tp2 = dir === "LONG" ? entry + tp2Dist : entry - tp2Dist;

      let result = null;
      let exitBarIdx = null;
      const lastBar = Math.min(i + MAX_HOLD_BARS, bars.length - 1);
      for (let j = i + 1; j <= lastBar; j++) {
        const b = bars[j];
        if (dir === "LONG") {
          const hitSL  = b.low  <= sl;
          const hitTP2 = b.high >= tp2;
          const hitTP1 = b.high >= tp1;
          if (hitSL) { result = "SL"; exitBarIdx = j; break; }
          if (hitTP2) { result = "TP2"; exitBarIdx = j; break; }
          if (hitTP1) { result = "TP1"; exitBarIdx = j; break; }
        } else {
          const hitSL  = b.high >= sl;
          const hitTP2 = b.low  <= tp2;
          const hitTP1 = b.low  <= tp1;
          if (hitSL) { result = "SL"; exitBarIdx = j; break; }
          if (hitTP2) { result = "TP2"; exitBarIdx = j; break; }
          if (hitTP1) { result = "TP1"; exitBarIdx = j; break; }
        }
      }

      let pnl;
      if (result === "SL")       pnl = -atrPips * 1.2;
      else if (result === "TP2") pnl =  atrPips * 3.0;
      else if (result === "TP1") pnl =  atrPips * 1.8;
      else {
        result = "TIME";
        const exitPrice = bars[lastBar].close;
        const priceDelta = dir === "LONG" ? (exitPrice - entry) : (entry - exitPrice);
        pnl = priceDelta * PIP_MULT;
        exitBarIdx = lastBar;
      }

      return { date:dateStr, dir, entry, sl, tp1, tp2, result,
               pnl_pips: Math.round(pnl),
               rsi: Math.round(rsi*10)/10, atr_pips: Math.round(atrPips) };
    }

    if (confluence >= 3) {
      const dir = bull ? "LONG" : "SHORT";
      const t = simTrade(dir);
      if (t) trades.confluence.push(t);
    }
    if (rsiLong || rsiShort) {
      const dir = rsiLong ? "LONG" : "SHORT";
      const t = simTrade(dir);
      if (t) trades.rsi_extreme.push(t);
    }
    if (confluence >= 3 && inSession) {
      const dir = bull ? "LONG" : "SHORT";
      const t = simTrade(dir);
      if (t) trades.session.push(t);
    }
    if (confluence >= 2) {
      const dir = bull ? "LONG" : "SHORT";
      const t = simTrade(dir);
      if (t) trades.all_signals.push(t);
    }

    if (confluence >= 3 && i + 5 < bars.length) {
      const dir = bull ? 1 : -1;
      const LEVELS = [0.5, 1.0, 1.5, 2.0, 3.0];
      LEVELS.forEach(mult => {
        const target = entry + dir * atr * mult;
        const key = Math.round(mult * 10);
        if (!ladderHits[key]) ladderHits[key] = { target_mult:mult, hits:0, total:0 };
        ladderHits[key].total++;
        for (let j = i+1; j <= Math.min(i+5, bars.length-1); j++) {
          const b = bars[j];
          const reached = dir === 1 ? b.high >= target : b.low <= target;
          if (reached) { ladderHits[key].hits++; break; }
        }
      });
    }
  }

  function stats(tradeList) {
    if (!tradeList.length) return { trades:0, win_rate:0, avg_pnl:0, total_pnl:0, best:0, worst:0, profit_factor:0 };
    const wins   = tradeList.filter(t => t.pnl_pips > 0);
    const losses = tradeList.filter(t => t.pnl_pips < 0);
    const totalPnl = tradeList.reduce((s,t) => s + t.pnl_pips, 0);
    const grossW = wins.reduce((s,t) => s + t.pnl_pips, 0);
    const grossL = Math.abs(losses.reduce((s,t) => s + t.pnl_pips, 0));
    return {
      trades:    tradeList.length,
      wins:      wins.length,
      losses:    losses.length,
      win_rate:  Math.round(wins.length / tradeList.length * 100),
      avg_pnl:   Math.round(totalPnl / tradeList.length),
      total_pnl: Math.round(totalPnl),
      best:      Math.round(Math.max(...tradeList.map(t=>t.pnl_pips))),
      worst:     Math.round(Math.min(...tradeList.map(t=>t.pnl_pips))),
      profit_factor: grossL > 0 ? Math.round(grossW/grossL*100)/100 : 999,
      equity: tradeList.reduce((acc, t) => {
        acc.push((acc[acc.length-1]||0) + t.pnl_pips);
        return acc;
      }, []),
      recent: tradeList.slice(-20),
      pnl_sequence: tradeList.map(t => [t.pnl_pips, t.atr_pips]),
    };
  }

  const ladderAccuracy = Object.entries(ladderHits)
    .filter(([k]) => k !== "total" && k !== "hits")
    .map(([k, v]) => ({
      mult:  v.target_mult,
      label: `${Math.round(v.target_mult * 100)}% ATR`,
      hits:  v.hits,
      total: v.total,
      accuracy: v.total > 0 ? Math.round(v.hits/v.total*100) : 0,
    }))
    .sort((a,b) => a.mult - b.mult);

  return {
    symbol,
    period: `${bars[200].date} → ${bars[bars.length-2].date}`,
    bars_used: bars.length - 200,
    stats: {
      confluence:  stats(trades.confluence),
      rsi_extreme: stats(trades.rsi_extreme),
      session:     stats(trades.session),
      all_signals: stats(trades.all_signals),
    },
    ladder_accuracy: ladderAccuracy,
  };
}

app.get("/api/backtest", async (req, res) => {
  const { symbol="EUR/USD" } = req.query;
  try {
    const result = await runBacktest(symbol);
    res.json(result);
  } catch(e) {
    console.error("[backtest]", symbol, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Runs the backtest for ALL 11 pairs sequentially (respecting the existing td()
// rate limiter/cache) and returns a compact comparison table — avoids the user
// having to click through each pair manually in the UI.
app.get("/api/backtest-all", async (req, res) => {
  const ALL_PAIRS = ["EUR/USD","GBP/USD","USD/JPY","USD/CHF","AUD/USD","USD/CAD",
                      "EUR/GBP","EUR/JPY","BTC/USD","ETH/USD","SOL/USD"];
  const results = [];
  console.log(`\n[backtest-all] Starting ${ALL_PAIRS.length} pairs`);
  for (const symbol of ALL_PAIRS) {
    try {
      const r = await runBacktest(symbol);
      results.push(r);
      console.log(`  ✓ ${symbol.padEnd(8)} confluence=${r.stats.confluence.trades}t/${r.stats.confluence.total_pnl}p session=${r.stats.session.trades}t/${r.stats.session.total_pnl}p`);
    } catch(e) {
      console.error(`  ✗ ${symbol}:`, e.message);
      results.push({ symbol, error: e.message });
    }
  }
  console.log(`[backtest-all] Done: ${results.filter(r=>!r.error).length}/${ALL_PAIRS.length}\n`);
  res.json({ results, generated_at: new Date().toISOString() });
});

// ── API KEY TEST ──────────────────────────────────────────────────────────────
app.get("/api/test-ai", async (req, res) => {
  if (!AKEY) return res.json({ok:false, error:"ANTHROPIC_API_KEY not set"});
  try {
    const {data} = await axios.post("https://api.anthropic.com/v1/messages",
      {model:"claude-sonnet-4-5", max_tokens:10,
       messages:[{role:"user", content:"Say OK"}]},
      {headers:{"x-api-key":AKEY,"anthropic-version":"2023-06-01","Content-Type":"application/json"},timeout:10000}
    );
    res.json({ok:true, model:"claude-sonnet-4-5", response:data.content?.[0]?.text});
  } catch(e) {
    res.json({ok:false, status:e.response?.status, error:JSON.stringify(e.response?.data||e.message)});
  }
});

// ── IG EXECUTION ENDPOINTS ─────────────────────────────────────────────────────
// Every endpoint here is explicit-call-only. Nothing in this file auto-fires an order;
// the React UI must always require a user click to reach these.

app.get("/api/ig/status", (_req, res) => {
  const configured = !!(IG_API_KEY && IG_IDENTIFIER && IG_PASSWORD);
  res.json({ configured, mode: IG_DEMO ? "DEMO" : "LIVE", connected: !!igSession.cst });
});

// Diagnostic endpoint: searches IG's own market catalog for a term (e.g. "USDCHF") so we
// can verify the real EPIC code instead of guessing — the hardcoded IG_EPICS map above
// was never confirmed against the live account and is the most likely cause of REJECTED
// orders with vague reasons like "UNKNOWN".
app.get("/api/ig/markets-search", async (req, res) => {
  try {
    const { term = "USDCHF" } = req.query;
    const session = await igLogin();
    const { data } = await axios.get(`${IG_BASE}/markets?searchTerm=${encodeURIComponent(term)}`,
      { headers: { ...igHeaders(session), "Version":"1" }, timeout: 15000 }
    );
    res.json({ ok:true, markets: (data.markets||[]).map(m => ({
      epic: m.epic, instrumentName: m.instrumentName, instrumentType: m.instrumentType,
      expiry: m.expiry, marketStatus: m.marketStatus,
      minDealSize: m.lotSize, // sanity check for our size calculation
    })) });
  } catch(e) {
    res.status(500).json({ ok:false, error: e.response?.data?.errorCode || e.message });
  }
});

// Diagnostic endpoint: fetches full instrument + dealing-rule details for a specific EPIC
// (min/max deal size, currencies, margin factor) — lets us validate our position-sizing
// math against the IG account's actual rules before placing real orders.
app.get("/api/ig/market-details", async (req, res) => {
  try {
    const { epic } = req.query;
    if (!epic) return res.status(400).json({ ok:false, error:"epic query param required" });
    const session = await igLogin();
    const { data } = await axios.get(`${IG_BASE}/markets/${encodeURIComponent(epic)}`,
      { headers: { ...igHeaders(session), "Version":"3" }, timeout: 15000 }
    );
    res.json({ ok:true,
      instrument: data.instrument,
      dealingRules: data.dealingRules,
      snapshot: data.snapshot,
    });
  } catch(e) {
    res.status(500).json({ ok:false, error: e.response?.data?.errorCode || e.message });
  }
});

app.get("/api/ig/account", async (_req, res) => {
  try {
    const account = await igGetAccountBalance();
    res.json({ ok: true, mode: IG_DEMO ? "DEMO" : "LIVE", account });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.response?.data?.errorCode || e.message });
  }
});

app.get("/api/ig/positions", async (_req, res) => {
  try {
    const positions = await igGetPositions();
    res.json({ ok: true, mode: IG_DEMO ? "DEMO" : "LIVE", positions });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.response?.data?.errorCode || e.message });
  }
});

// Place an order. Requires explicit body: { symbol, direction: "BUY"|"SELL", size, stopLevel, limitLevel }
// IMPORTANT: This endpoint executes a REAL order against whichever IG_DEMO setting is active.
// The frontend must show a confirmation dialog with mode (DEMO/LIVE) before ever calling this.
app.post("/api/ig/order", async (req, res) => {
  try {
    const { symbol, direction, size, stopLevel, limitLevel } = req.body;
    if (!symbol || !direction || !size) {
      return res.status(400).json({ ok:false, error:"symbol, direction e size são obrigatórios" });
    }
    if (!["BUY","SELL"].includes(direction)) {
      return res.status(400).json({ ok:false, error:'direction deve ser "BUY" ou "SELL"' });
    }
    console.log(`[ig] ${IG_DEMO?"DEMO":"⚠️ LIVE"} ORDER → ${direction} ${size} ${symbol} | SL:${stopLevel} TP:${limitLevel}`);
    const result = await igPlaceOrder({ symbol, direction, size, stopLevel, limitLevel });
    console.log(`[ig] Confirm:`, result.confirm.dealStatus, result.confirm.reason);
    res.json({ ok: true, mode: IG_DEMO ? "DEMO" : "LIVE", ...result });
  } catch (e) {
    const detail = e.response?.data?.errorCode || e.message;
    console.error("[ig] Order failed:", detail);
    res.status(500).json({ ok: false, error: detail });
  }
});

// Closes an open position early (before SL/TP triggers naturally). Requires the
// position's own dealId, direction, and size — all of which the frontend already
// has from /api/ig/positions, so no extra lookups are needed here.
app.post("/api/ig/close-position", async (req, res) => {
  try {
    const { dealId, direction, size, epic } = req.body;
    if (!dealId || !direction || !size) {
      return res.status(400).json({ ok:false, error:"dealId, direction e size são obrigatórios" });
    }
    console.log(`[ig] ${IG_DEMO?"DEMO":"⚠️ LIVE"} CLOSE → dealId:${dealId} epic:${epic} (era ${direction} ${size})`);
    const result = await igClosePosition({ dealId, direction, size, epic });
    console.log(`[ig] Close confirm:`, result.confirm.dealStatus, result.confirm.reason);
    res.json({ ok: true, mode: IG_DEMO ? "DEMO" : "LIVE", ...result });
  } catch (e) {
    const detail = e.response?.data?.errorCode || e.message;
    console.error("[ig] Close failed:", detail);
    res.status(500).json({ ok: false, error: detail });
  }
});


app.listen(PORT, () => {
  console.log(`\n🏦 Forex Master Pro v7 — Master Prompt v6 Edition`);
  console.log(`   Servidor   : http://localhost:${PORT}`);
  console.log(`   Twelve Data: ${KEY?"✅ configurada":"❌ FALTA no .env"}`);
  console.log(`   Anthropic  : ${AKEY?"✅ configurada":"⚠️  não configurada"}`);
  console.log(`   Prompt     : Master Prompt v6 (COT·OB·FVG·Killzones·Ladder)`);
  console.log(`   Alertas    : ✅ activos (RSI extremo·confluência·janela ideal)`);
  console.log(`   Rate limit : 1s · cache 5min · dedup activo · crash guard\n`);
});
