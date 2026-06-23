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
  let sum = 0, n = Math.min(period, closes.length - 1);
  for (let i = 1; i <= n; i++)
    sum += Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
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
      results.push({symbol,price,change_pct:((price-prev)/prev)*100,
        high:parseFloat(today.high),low:parseFloat(today.low),
        atr_pips:atrPips,atr_raw:atrVal,rsi:rsiVal,macd:macdVal,
        ema50:ema50v,ema200:ema200v,trend:price>ema200v?"bull":"bear",
        tier:TIER1.includes(symbol)?1:isCrypto?"crypto":2,
        is_crypto:isCrypto,
        ideal_session:ideal});
      console.log(`  ✓ ${symbol.padEnd(7)} ${price.toFixed(isJpy?2:4).padEnd(10)} ATR=${isCrypto?"$":""}${String(atrPips).padEnd(4)}${isCrypto?"":"p"} RSI=${rsiVal.toFixed(1)} ${ideal?"✅":"⏳"}`);
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
  const {symbol,price,change_pct,high,low,atr_pips,rsi,macd,ema50,ema200,trend} = req.body;
  const bull=trend==="bull", mb=(macd?.hist||0)>0;

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
      {model:"claude-sonnet-4-5",max_tokens:2000,
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
    // Sanitise risk_reward — extract only "1:X.X" pattern
    if(result.risk_reward) {
      const m = String(result.risk_reward).match(/1:[\d.]+/);
      result.risk_reward = m ? m[0] : null;
    }
    // Ensure stop_loss.price and take_profit prices are strings, not numbers
    if(result.stop_loss?.price) result.stop_loss.price = String(result.stop_loss.price);
    if(result.take_profits) result.take_profits = result.take_profits.map(tp=>({...tp, price:String(tp.price||"—")}));
    // Remove any numeric top-level fields that could render as stray text
    // (sometimes AI returns extra fields not in the schema)
    const ALLOWED = ["recommendation","direction","action","confidence","verdict","summary",
      "session_analysis","volume_analysis","institutional","entry","stop_loss",
      "take_profits","risks","checklist","risk_reward","pip_ladder","macro_warning"];
    Object.keys(result).forEach(k => { if(!ALLOWED.includes(k)) { console.log(`[report] Removing extra field: ${k} =`, result[k]); delete result[k]; } });
    console.log("[report] risk_reward:", result.risk_reward);
    // Attach raw real macro events (for UI display, independent of AI's text summary)
    result.macro_events = macroEvents.map(e => ({
      country: e.country, report_name: e.report_name, economicImpact: e.economicImpact,
      datetime: e.datetime, previous: e.previous, consensus: e.consensus, actual: e.actual,
    }));
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
app.get("/api/backtest", async (req, res) => {
  const { symbol="EUR/USD" } = req.query;
  try {
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

      // Simulate trade outcome using next bar's H/L
      function simTrade(dir) {
        if (i + 1 >= bars.length) return null;
        const nextBar = bars[i+1];
        const sl  = dir === "LONG" ? entry - slDist  : entry + slDist;
        const tp1 = dir === "LONG" ? entry + tp1Dist : entry - tp1Dist;
        const tp2 = dir === "LONG" ? entry + tp2Dist : entry - tp2Dist;

        // Check if SL or TP hit on next bar
        let result = "open";
        if (dir === "LONG") {
          if (nextBar.low  <= sl)  result = "SL";
          if (nextBar.high >= tp1) result = result === "SL" ? "SL" : "TP1";
          if (nextBar.high >= tp2) result = result === "SL" ? "SL" : "TP2";
        } else {
          if (nextBar.high >= sl)  result = "SL";
          if (nextBar.low  <= tp1) result = result === "SL" ? "SL" : "TP1";
          if (nextBar.low  <= tp2) result = result === "SL" ? "SL" : "TP2";
        }
        if (result === "open") result = "TP1"; // close at end of bar

        const pnl = result === "SL"  ? -atrPips * 1.2 :
                    result === "TP2" ?  atrPips * 3.0  :
                                        atrPips * 1.8;
        return { date:dateStr, dir, entry, sl, tp1, tp2, result,
                 pnl_pips: Math.round(dir==="LONG" ? pnl : pnl),
                 rsi: Math.round(rsi*10)/10, atr_pips: Math.round(atrPips) };
      }

      // Strategy 1: Full confluence (3/3)
      if (confluence >= 3) {
        const dir = bull ? "LONG" : "SHORT";
        const t = simTrade(dir);
        if (t) trades.confluence.push(t);
      }

      // Strategy 2: RSI extreme
      if (rsiLong || rsiShort) {
        const dir = rsiLong ? "LONG" : "SHORT";
        const t = simTrade(dir);
        if (t) trades.rsi_extreme.push(t);
      }

      // Strategy 3: Confluence + session
      if (confluence >= 3 && inSession) {
        const dir = bull ? "LONG" : "SHORT";
        const t = simTrade(dir);
        if (t) trades.session.push(t);
      }

      // Strategy 4: Any 2 signals
      if (confluence >= 2) {
        const dir = bull ? "LONG" : "SHORT";
        const t = simTrade(dir);
        if (t) trades.all_signals.push(t);
      }

      // Pip Ladder accuracy tracking
      if (confluence >= 3 && i + 5 < bars.length) {
        const dir = bull ? 1 : -1;
        const LEVELS = [0.5, 1.0, 1.5, 2.0, 3.0];
        LEVELS.forEach(mult => {
          const target = entry + dir * atr * mult;
          const key = Math.round(mult * 10);
          if (!ladderHits[key]) ladderHits[key] = { target_mult:mult, hits:0, total:0 };
          ladderHits[key].total++;
          // Check next 5 bars
          for (let j = i+1; j <= Math.min(i+5, bars.length-1); j++) {
            const b = bars[j];
            const reached = dir === 1 ? b.high >= target : b.low <= target;
            if (reached) { ladderHits[key].hits++; break; }
          }
        });
      }
    }

    // Compute stats
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
        // equity curve (cumulative pnl)
        equity: tradeList.reduce((acc, t) => {
          acc.push((acc[acc.length-1]||0) + t.pnl_pips);
          return acc;
        }, []),
        recent: tradeList.slice(-20), // last 20 trades
      };
    }

    // Ladder accuracy
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

    res.json({
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
    });
  } catch(e) {
    console.error("[backtest]", symbol, e.message);
    res.status(500).json({ error: e.message });
  }
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


app.listen(PORT, () => {
  console.log(`\n🏦 Forex Master Pro v7 — Master Prompt v6 Edition`);
  console.log(`   Servidor   : http://localhost:${PORT}`);
  console.log(`   Twelve Data: ${KEY?"✅ configurada":"❌ FALTA no .env"}`);
  console.log(`   Anthropic  : ${AKEY?"✅ configurada":"⚠️  não configurada"}`);
  console.log(`   Prompt     : Master Prompt v6 (COT·OB·FVG·Killzones·Ladder)`);
  console.log(`   Alertas    : ✅ activos (RSI extremo·confluência·janela ideal)`);
  console.log(`   Rate limit : 1s · cache 5min · dedup activo · crash guard\n`);
});
