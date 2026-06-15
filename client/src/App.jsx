import { useState, useEffect, useCallback, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, BarChart, Bar, Cell, ReferenceLine } from "recharts";

// ── CONFIG ────────────────────────────────────────────────────────────────────
// In Electron production build, server runs on 3001. In dev, same.
const BASE   = "http://localhost:3001/api";
const PAIRS  = ["EUR/USD","GBP/USD","USD/JPY","USD/CHF","AUD/USD","USD/CAD","EUR/GBP","EUR/JPY","BTC/USD","ETH/USD","SOL/USD"];
const TIER1  = ["EUR/USD","GBP/USD","USD/JPY","USD/CHF"];
const CRYPTO = ["BTC/USD","ETH/USD","SOL/USD"];
const PIPS   = [50,100,150,200,250,300,350,400,450,500];

// ── HELPERS ───────────────────────────────────────────────────────────────────
const fmt  = (n,d=4) => typeof n==="number"?n.toFixed(d):"—";
const fmtP = (n) => `${n>0?"+":""}${fmt(n,2)}%`;
const pCol = (v) => v>0?"#22c55e":v<0?"#ef4444":"#6a9ab8";
// sleep removed — rate limiting handled server-side
const get  = async (p) => { const r=await fetch(`${BASE}${p}`); if(!r.ok) throw new Error(`${r.status}`); return r.json(); };

function pipColor(p){ return p>=80?"#22c55e":p>=60?"#4da6ff":p>=40?"#f59e0b":p>=20?"#f97316":"#ef4444"; }
function pipLabel(p){ return p>=80?"Quase certo":p>=60?"Alta prob.":p>=40?"Moderada":p>=20?"Baixa":"Improvável"; }

function computeLadder(atrPips, rsi, bull, macdBull, isCrypto=false){
  const momentum=(bull?1:0)+(macdBull?1:0)+((rsi>50&&bull)||(rsi<50&&!bull)?1:0);
  const boost=momentum*4;
  // For crypto: use ATR-scaled levels. For forex: use fixed pip levels.
  const levels = isCrypto
    ? [0.2,0.5,0.8,1.0,1.5,2.0,3.0,4.0,5.0,7.0].map(m=>Math.max(1,Math.round(atrPips*m)))
    : PIPS;
  return levels.map(pips=>({ pips, prob:Math.min(97,Math.max(3,Math.round(100*Math.exp(-0.55*pips/Math.max(atrPips,1)))+boost)) }));
}

// ── ATOMS ─────────────────────────────────────────────────────────────────────
const C = ({children,style={},glow=false}) => <div style={{background:"rgba(4,10,22,0.96)",border:`1px solid ${glow?"rgba(13,148,136,0.5)":"rgba(18,42,78,0.7)"}`,borderRadius:12,padding:"16px 18px",boxShadow:glow?"0 0 20px rgba(13,148,136,0.1)":"none",...style}}>{children}</div>;
const L = ({t,color="#253a5e",mb=10}) => <div style={{fontSize:10,color,textTransform:"uppercase",letterSpacing:"1.2px",fontWeight:700,marginBottom:mb}}>{t}</div>;
const Tag=({t,color="#4da6ff"})=><span style={{fontSize:10,color,background:color+"18",border:`1px solid ${color}33`,borderRadius:4,padding:"2px 8px",whiteSpace:"nowrap"}}>{t}</span>;
const Spin=()=><span style={{display:"inline-block",animation:"spin 1s linear infinite",marginRight:5}}>⟳</span>;
const Dot=({on})=><span style={{display:"inline-block",width:7,height:7,borderRadius:"50%",background:on?"#22c55e":"#ef4444",boxShadow:on?"0 0 0 0 rgba(34,197,94,0.6)":undefined,animation:on?"pulse 1.4s infinite":undefined,marginRight:5,verticalAlign:"middle"}}/>;

function TabBtn({active,onClick,children}){
  return <button onClick={onClick} style={{padding:"7px 13px",borderRadius:6,border:"none",background:active?"linear-gradient(135deg,#0a2a5e,#1a5fd4)":"transparent",color:active?"#fff":"#2a5080",fontSize:11,cursor:"pointer",fontFamily:"inherit",fontWeight:active?700:400,transition:"all 0.2s"}}>{children}</button>;
}

// ── PIP LADDER ────────────────────────────────────────────────────────────────
function PipLadder({ladder,dir,isCrypto=false}){
  return(
    <div>
      <div style={{marginBottom:12,fontSize:11,color:"#253a5e"}}>{dir==="LONG"?"📈":"📉"} Probabilidade de atingir cada nível em {dir} {isCrypto?"(em USD)":"(em pips)"}</div>
      {ladder.map(({pips,prob})=>{
        const c=pipColor(prob);
        return(
          <div key={pips} style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
            <div style={{width:60,fontSize:11,fontWeight:700,color:c,textAlign:"right",flexShrink:0}}>{isCrypto?`+$${pips?.toLocaleString()}`:`+${pips}p`}</div>
            <div style={{flex:1,background:"rgba(18,42,78,0.3)",borderRadius:4,height:13,overflow:"hidden",position:"relative"}}>
              <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${prob}%`,background:c,opacity:0.75,borderRadius:4,transition:"width 0.6s"}}/>
            </div>
            <div style={{width:34,fontSize:11,fontWeight:700,color:c,textAlign:"right",flexShrink:0}}>{prob}%</div>
            <div style={{width:78,fontSize:10,color:"#253a5e",flexShrink:0}}>{pipLabel(prob)}</div>
          </div>
        );
      })}
      <div style={{marginTop:10,display:"flex",gap:10,flexWrap:"wrap"}}>
        {[["#22c55e","≥80%"],["#4da6ff","60–79%"],["#f59e0b","40–59%"],["#f97316","20–39%"],["#ef4444","<20%"]].map(([c,l])=>(
          <span key={l} style={{display:"flex",alignItems:"center",gap:4,fontSize:9,color:"#253a5e"}}>
            <span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:c}}/>{l}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── AI REPORT ─────────────────────────────────────────────────────────────────
function AiReport({report,loading,error,onRefresh,symbol}){
  if(loading) return(
    <C style={{textAlign:"center",padding:"28px 20px"}}>
      <Spin/><span style={{fontSize:13,color:"#253a5e"}}>A gerar análise IA para {symbol}...</span>
      <div style={{fontSize:11,color:"#1a3a5e",marginTop:8,lineHeight:1.7}}>Preço · Indicadores · Tendência · Posicionamento · Recomendação</div>
    </C>
  );
  if(error) return(
    <C style={{borderColor:"rgba(239,68,68,0.3)"}}>
      <div style={{fontSize:12,color:"#ef4444",marginBottom:6}}>⚠️ Erro na análise IA</div>
      <div style={{fontSize:11,color:"#7a3030",marginBottom:12,lineHeight:1.6}}>{error}</div>
      <div style={{fontSize:11,color:"#3a5a6a",lineHeight:1.8,padding:"10px 12px",background:"rgba(26,95,212,0.06)",borderRadius:8}}>
        <strong style={{color:"#4da6ff"}}>Como resolver:</strong><br/>
        Adiciona ao ficheiro <code style={{color:"#0d9488"}}>.env</code> na pasta forex-pro:<br/>
        <code style={{color:"#f59e0b"}}>ANTHROPIC_API_KEY=sk-ant-...</code><br/>
        Reinicia o servidor (Ctrl+C → <code style={{color:"#4da6ff"}}>npm run dev</code>)
      </div>
      <button onClick={onRefresh} style={{marginTop:12,padding:"6px 16px",borderRadius:6,border:"1px solid #1a5fd4",background:"rgba(26,95,212,0.15)",color:"#4da6ff",fontSize:11,cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>Tentar novamente</button>
    </C>
  );
  if(!report) return null;

  const {recommendation,direction,confidence,verdict,summary,session_analysis,volume_analysis,institutional,entry,stop_loss:sl_raw,take_profits,risks,checklist,risk_reward} = report;
  // Sanitise to prevent number leak as invisible text nodes
  const stop_loss = sl_raw ? {...sl_raw, price: String(sl_raw.price||"—"), pips: sl_raw.pips||0} : null;
  const isRec = recommendation==="RECOMENDADO";
  const rc = isRec?(direction==="LONG"?"#22c55e":"#ef4444"):"#6a9ab8";

  return(
    <div style={{display:"grid",gap:12}}>

      {/* Verdict */}
      <C style={{background:rc+"0d",borderColor:rc+"44",padding:"18px 20px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12}}>
          <div>
            <div style={{fontSize:18,fontWeight:800,color:rc,marginBottom:6}}>
              {isRec?(direction==="LONG"?"📈 LONG RECOMENDADO":"📉 SHORT RECOMENDADO"):"⛔ NÃO RECOMENDADO"}
            </div>
            <div style={{fontSize:12,color:"#8aaccc",lineHeight:1.75}}>{verdict}</div>
          </div>
          <div style={{textAlign:"right",flexShrink:0}}>
            <div style={{fontSize:10,color:"#253a5e"}}>Confiança</div>
            <div style={{fontSize:30,fontWeight:800,color:rc,lineHeight:1}}>{confidence}%</div>
          </div>
        </div>
      </C>

      {/* Session Analysis */}
      {session_analysis&&(
        <C style={{borderColor:session_analysis.is_ideal?"rgba(13,148,136,0.5)":"rgba(245,158,11,0.4)",background:session_analysis.is_ideal?"rgba(13,148,136,0.07)":"rgba(245,158,11,0.05)"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:8,marginBottom:12}}>
            <L t="🕐 Análise de Sessão & Janela Ideal" color={session_analysis.is_ideal?"#0d9488":"#f59e0b"} mb={0}/>
            <span style={{fontSize:11,fontWeight:700,color:session_analysis.is_ideal?"#0d9488":"#f59e0b",background:session_analysis.is_ideal?"rgba(13,148,136,0.15)":"rgba(245,158,11,0.15)",padding:"3px 10px",borderRadius:5}}>
              {session_analysis.is_ideal?"✅ Janela ideal activa":"⚠️ Fora da janela ideal"}
            </span>
          </div>
          <div style={{display:"grid",gap:7}}>
            <div style={{display:"flex",justifyContent:"space-between",padding:"8px 10px",background:"rgba(10,20,40,0.4)",borderRadius:7}}>
              <span style={{fontSize:11,color:"#253a5e"}}>Sessão actual</span>
              <span style={{fontSize:11,fontWeight:700,color:"#c8e0ff"}}>{session_analysis.current_session}</span>
            </div>
            <div style={{padding:"8px 10px",background:"rgba(10,20,40,0.4)",borderRadius:7}}>
              <div style={{fontSize:11,color:"#253a5e",marginBottom:5}}>Melhores janelas</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {(session_analysis.best_windows||[]).map((w,i)=>(
                  <span key={i} style={{fontSize:10,color:"#0d9488",background:"rgba(13,148,136,0.12)",border:"1px solid rgba(13,148,136,0.25)",borderRadius:4,padding:"2px 8px"}}>{w}</span>
                ))}
              </div>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",padding:"8px 10px",background:"rgba(239,68,68,0.06)",borderRadius:7,border:"1px solid rgba(239,68,68,0.15)"}}>
              <span style={{fontSize:11,color:"#253a5e"}}>Evitar</span>
              <span style={{fontSize:11,color:"#ef4444"}}>{session_analysis.avoid}</span>
            </div>
            <div style={{padding:"10px 12px",background:"rgba(26,95,212,0.08)",borderRadius:7,border:"1px solid rgba(26,95,212,0.2)"}}>
              <div style={{fontSize:11,color:"#253a5e",marginBottom:4}}>⏰ Próxima janela ideal</div>
              <div style={{fontSize:12,fontWeight:700,color:"#4da6ff"}}>{session_analysis.next_ideal_window}</div>
            </div>
            <div style={{fontSize:11,color:"#253a5e",lineHeight:1.7,padding:"8px 10px",background:"rgba(10,20,40,0.3)",borderRadius:7}}>
              {session_analysis.recommendation}
            </div>
          </div>
        </C>
      )}

      {/* Summary */}
      <C>
        <L t="📊 Análise do Par"/>
        <div style={{fontSize:12,color:"#8aaccc",lineHeight:1.85}}>{summary}</div>
      </C>

      {/* Volume + Institutional */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <C>
          <L t="📦 Volume"/>
          <div style={{display:"grid",gap:7}}>
            {[["Relativo",volume_analysis?.relative,volume_analysis?.relative==="Alto"?"#22c55e":volume_analysis?.relative==="Baixo"?"#ef4444":"#f59e0b"],["Tendência",volume_analysis?.trend,"#8aaccc"]].map(([k,v,c])=>(
              <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"7px 10px",background:"rgba(10,20,40,0.4)",borderRadius:6}}>
                <span style={{fontSize:11,color:"#253a5e"}}>{k}</span>
                <span style={{fontSize:11,fontWeight:700,color:c}}>{v||"—"}</span>
              </div>
            ))}
            {volume_analysis?.notes&&<div style={{fontSize:11,color:"#253a5e",marginTop:4,lineHeight:1.6}}>{volume_analysis.notes}</div>}
          </div>
        </C>
        <C>
          <L t="🏦 Grandes Players & Smart Money"/>
          <div style={{display:"grid",gap:7}}>
            <div style={{display:"flex",justifyContent:"space-between",padding:"8px 10px",background:"rgba(10,20,40,0.4)",borderRadius:7}}>
              <span style={{fontSize:11,color:"#253a5e"}}>COT inferido</span>
              <span style={{fontSize:11,fontWeight:700,color:institutional?.bias==="Bullish"?"#22c55e":institutional?.bias==="Bearish"?"#ef4444":"#f59e0b"}}>{institutional?.bias||"—"}</span>
            </div>
            {institutional?.order_block&&<div style={{padding:"7px 10px",background:"rgba(10,20,40,0.3)",borderRadius:7,fontSize:11,color:"#253a5e"}}><strong style={{color:"#4da6ff"}}>Order Block:</strong> {institutional.order_block}</div>}
            {institutional?.fvg&&<div style={{padding:"7px 10px",background:"rgba(10,20,40,0.3)",borderRadius:7,fontSize:11,color:"#253a5e"}}><strong style={{color:"#0d9488"}}>FVG:</strong> {institutional.fvg}</div>}
            {institutional?.stop_hunt_risk&&<div style={{padding:"7px 10px",background:"rgba(245,158,11,0.07)",borderRadius:7,border:"1px solid rgba(245,158,11,0.2)",fontSize:11,color:"#f59e0b"}}><strong>Stop Hunt:</strong> {institutional.stop_hunt_risk}</div>}
            {institutional?.cot_inference&&<div style={{fontSize:11,color:"#253a5e",lineHeight:1.7,marginTop:2}}>{institutional.cot_inference}</div>}
          </div>
        </C>
      </div>

      {/* Entry/Exit — only if recommended */}
      {isRec&&(
        <C glow>
          <L t="🎯 Entrada e Saída" color="#0d9488"/>
          <div style={{display:"grid",gap:7}}>
            <div style={{display:"grid",gridTemplateColumns:"110px 1fr",gap:6,padding:"9px 12px",background:"rgba(13,148,136,0.08)",borderRadius:8,border:"1px solid rgba(13,148,136,0.2)"}}>
              <span style={{fontSize:11,color:"#0d9488",fontWeight:700}}>Zona Entrada</span>
              <span style={{fontSize:12,color:"#c8e0ff",fontWeight:600}}>{entry?.zone||"—"}</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"110px 1fr",gap:6,padding:"9px 12px",background:"rgba(239,68,68,0.07)",borderRadius:8,border:"1px solid rgba(239,68,68,0.2)"}}>
              <span style={{fontSize:11,color:"#ef4444",fontWeight:700}}>Stop Loss</span>
              <span style={{fontSize:12,color:"#c8e0ff"}}>{stop_loss?.price||"—"} <span style={{color:"#ef4444",fontSize:10}}>(-{stop_loss?.pips||"—"}p)</span></span>
            </div>
            {(take_profits||[]).map((tp,i)=>(
              <div key={i} style={{display:"grid",gridTemplateColumns:"110px 1fr",gap:6,padding:"9px 12px",background:"rgba(34,197,94,0.06)",borderRadius:8,border:"1px solid rgba(34,197,94,0.15)"}}>
                <span style={{fontSize:11,color:"#22c55e",fontWeight:700}}>TP{i+1} ({tp.close_pct}%)</span>
                <span style={{fontSize:12,color:"#c8e0ff"}}>{tp.price||"—"} <span style={{color:"#22c55e",fontSize:10}}>(+{tp.pips||"—"}p)</span></span>
              </div>
            ))}
          </div>
          {entry?.notes&&<div style={{marginTop:10,fontSize:11,color:"#253a5e",lineHeight:1.7}}>{entry.notes}</div>}
        </C>
      )}

      {/* Risks */}
      {risks?.length>0&&(
        <C>
          <L t="⚠️ Riscos"/>
          {risks.map((r,i)=>(
            <div key={i} style={{display:"flex",gap:8,padding:"7px 10px",background:"rgba(245,158,11,0.06)",borderRadius:6,border:"1px solid rgba(245,158,11,0.12)",marginBottom:6}}>
              <span style={{color:"#f59e0b",flexShrink:0}}>⚠</span>
              <span style={{fontSize:11,color:"#8aaccc",lineHeight:1.6}}>{r}</span>
            </div>
          ))}
        </C>
      )}

      {/* Checklist */}
      {checklist?.length>0&&(
        <C>
          <L t="✅ Checklist de Entrada"/>
          {checklist.map((c,i)=>{
            const ok=c.startsWith("✅");
            return(
              <div key={i} style={{display:"flex",gap:8,padding:"6px 10px",background:ok?"rgba(34,197,94,0.05)":"rgba(239,68,68,0.05)",borderRadius:6,border:`1px solid ${ok?"rgba(34,197,94,0.15)":"rgba(239,68,68,0.15)"}`,marginBottom:5}}>
                <span style={{fontSize:13,flexShrink:0}}>{ok?"✅":"❌"}</span>
                <span style={{fontSize:11,color:"#8aaccc",lineHeight:1.6}}>{c.replace(/^[✅❌]\s*/,"")}</span>
              </div>
            );
          })}
          {risk_reward&&(()=>{
            const rb = String(risk_reward).replace(/[\n\r]/g," ").trim();
            const match = rb.match(/1:\d+(\.\d+)?/);
            const display = match ? match[0] : rb.split(" ")[0];
            return <div style={{marginTop:10,padding:"8px 12px",background:"rgba(26,95,212,0.1)",borderRadius:6,fontSize:12,color:"#4da6ff"}}>⚖️ R/B: <strong>{display}</strong></div>;
          })()}
        </C>
      )}
    </div>
  );
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
export default function App(){
  const [tab,setTab]           = useState("dashboard");
  const [activePair,setAP]     = useState("EUR/USD");
  const [scanData,setScan]     = useState([]);
  const [scanning,setScanning] = useState(false);
  const [quote,setQuote]       = useState(null);
  const [ind,setInd]           = useState(null);
  const [candles,setCandles]   = useState([]);
  const [health,setHealth]     = useState(null);
  const [updated,setUpdated]   = useState(null);
  const [loadPair,setLP]       = useState(false);
  const [report,setReport]     = useState(null);
  const [repLoad,setRL]        = useState(false);
  const [repErr,setRE]         = useState(null);
  const [error,setError]       = useState(null);
  const [autoR,setAutoR]       = useState(true);
  const [btData,setBT]         = useState(null);
  const [btLoad,setBTLoad]     = useState(false);
  const [btPair,setBTPair]     = useState("EUR/USD");
  const [alerts,setAlerts]     = useState([]);
  const [showAlerts,setShowAlerts] = useState(false);
  const [installPrompt,setInstallPrompt] = useState(null);
  const [installed,setInstalled] = useState(false);
  const timerRef               = useRef(null);

  // sequential scan
  const doScan = useCallback(async(silent=false)=>{
    if(!silent) setScanning(true);
    try{
      const data = await get("/scan");
      setScan(data.pairs || []);
      setUpdated(new Date());
      // Check alerts after scan
      try{ const al=await get("/alerts"); setAlerts(al.alerts||[]); }catch{}
    }catch(e){
      setError(e.message);
    }finally{
      if(!silent) setScanning(false);
    }
  },[]);

  // load single pair data
  const fetchPair = useCallback(async(sym)=>{
    setLP(true); setError(null);
    try{
      // Use scan data for quote if available (zero extra API calls)
      const sp = scanData.find(x => x.symbol === sym);
      if(sp){
        setQuote({ symbol:sym, price:sp.price, open:sp.price,
          high:sp.high, low:sp.low, change_pct:sp.change_pct, change:0 });
        setInd({ rsi:sp.rsi, macd:sp.macd, atr:sp.atr_raw,
          ema50:sp.ema50, ema200:sp.ema200 });
      }
      // Only fetch candles (1 API call, uses server cache)
      const c = await get(`/candles?symbol=${encodeURIComponent(sym)}&interval=1day&outputsize=30`);
      setCandles(c.candles.slice().reverse().map(v=>({date:v.datetime.slice(5,10),close:v.close,high:v.high,low:v.low})));
    }catch(e){setError(e.message);}
    finally{setLP(false);}
  },[scanData]);

  // generate AI report via server proxy
  const genReport = useCallback(async(pairData)=>{
    if(!pairData) return;
    setRL(true); setRE(null); setReport(null);
    try{
      const r=await fetch(`${BASE}/report`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(pairData)});
      if(!r.ok){ const e=await r.json(); throw new Error(e.error||`Erro ${r.status}`); }
      setReport(await r.json());
    }catch(e){setRE(e.message);}
    finally{setRL(false);}
  },[]);

  // fetch backtest
  const fetchBacktest = useCallback(async(sym) => {
    setBTLoad(true); setBT(null);
    try {
      const d = await get(`/backtest?symbol=${encodeURIComponent(sym)}`);
      setBT(d); setBTPair(sym);
    } catch(e) { setError(e.message); }
    finally { setBTLoad(false); }
  }, []);

  // init
  useEffect(()=>{
    get("/health").then(setHealth).catch(()=>{});
    doScan();
    // PWA install prompt
    window.addEventListener("beforeinstallprompt", e => {
      e.preventDefault();
      setInstallPrompt(e);
    });
    window.addEventListener("appinstalled", () => {
      setInstalled(true);
      setInstallPrompt(null);
    });
  },[]);// eslint-disable-line
  // Load pair detail ONLY when user explicitly clicks a pair
  // hasSwitched tracks if user has made at least one explicit pair switch
  const debounceRef = useRef(null);
  const lastLoadedPair = useRef(null);
  const hasSwitched = useRef(false); // only true after user clicks
  useEffect(()=>{
    if(!hasSwitched.current) return; // never auto-load on mount or scan completion
    if(lastLoadedPair.current === activePair) return;
    if(debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(()=>{
      lastLoadedPair.current = activePair;
      fetchPair(activePair);
    }, 300);
    return ()=>clearTimeout(debounceRef.current);
  },[activePair,fetchPair]);

  // auto-refresh 3 min
  useEffect(()=>{
    if(!autoR) return;
    timerRef.current=setInterval(()=>doScan(true),180000);
    return()=>clearInterval(timerRef.current);
  },[autoR,doScan]);

  // switch pair — user explicitly clicked
  const switchPair = (sym) => {
    if(sym === activePair) return;
    hasSwitched.current = true;   // mark that user has switched
    lastLoadedPair.current = null;
    setAP(sym);
    setInd(null); setQuote(null); setCandles([]);
    if(tab==="report"){
      const d=scanData.find(x=>x.symbol===sym);
      if(d){ setReport(null); genReport(d); }
    }
  };

  // when switching TO report tab, generate if needed
  const switchTab = (t) => {
    setTab(t);
    if(t==="report"&&!report&&!repLoad){
      const d=scanData.find(x=>x.symbol===activePair);
      if(d) genReport(d);
    }
  };

  // derived — scanPair MUST be first (used by atrPips fallback)
  const isJpy    = activePair.includes("JPY");
  const scanPair = scanData.find(x => x.symbol === activePair);
  const sp       = scanPair; // alias to avoid TDZ issues
  const isCryptoActive = CRYPTO.includes(activePair);
  // Crypto: atr_raw is already in USD — no pip conversion needed
  // Forex JPY: multiply by 100. Forex others: multiply by 10000.
  const atrPips  = ind
    ? Math.round(isCryptoActive ? ind.atr : ind.atr * (isJpy ? 100 : 10000))
    : (sp ? sp.atr_pips : null);
  const bull     = (ind && quote) ? (quote.price > ind.ema200) : (sp ? sp.trend === "bull" : false);
  const macdBull = ind ? ((ind.macd?.hist || 0) > 0) : (sp ? ((sp.macd?.hist || 0) > 0) : false);
  const rsiVal   = ind ? ind.rsi : (sp ? sp.rsi : 50);
  const ladder   = atrPips ? computeLadder(atrPips, rsiVal, bull, macdBull, isCryptoActive) : [];
  // For crypto ladder: server already scales the levels — frontend just displays

  const TABS=[["dashboard","📊 Dashboard"],["scanner","📡 Scanner"],["detail","🔍 Indicadores"],["report","🤖 Relatório IA"],["backtest","📈 Backtest"]];

  return(
    <div style={{minHeight:"100vh",background:"#03060e",color:"#8aaccc",fontFamily:"'Segoe UI',system-ui,sans-serif"}}>
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}} @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.6)}70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}} ::-webkit-scrollbar{width:4px;height:4px} ::-webkit-scrollbar-thumb{background:rgba(26,95,212,.4);border-radius:2px}`}</style>
      <div style={{position:"fixed",top:0,left:0,right:0,height:2,zIndex:20,background:"linear-gradient(90deg,transparent,#1a5fd4 30%,#0d9488 70%,transparent)"}}/>
      <div style={{position:"fixed",inset:0,zIndex:0,opacity:0.22,backgroundImage:"linear-gradient(rgba(26,95,212,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(26,95,212,.07) 1px,transparent 1px)",backgroundSize:"32px 32px",pointerEvents:"none"}}/>

      <div style={{position:"relative",zIndex:1,maxWidth:1100,margin:"0 auto",padding:"0 16px 60px"}}>

        {/* HEADER */}
        <div style={{padding:"18px 0 14px",borderBottom:"1px solid rgba(18,42,78,.8)",marginBottom:16,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:38,height:38,background:"linear-gradient(135deg,#0a2a5e,#1a5fd4)",borderRadius:9,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,boxShadow:"0 0 16px rgba(26,95,212,.4)"}}>🏦</div>
            <div>
              <div style={{fontSize:16,fontWeight:700,color:"#c8e0ff"}}>Forex Master Pro <span style={{color:"#0d9488"}}>v7</span></div>
              <div style={{fontSize:10,color:"#253a5e",display:"flex",alignItems:"center",gap:8,marginTop:1}}>
                <Dot on={health?.status==="ok"}/>
                {health?.status==="ok"?"API activa · Dados reais":"A aguardar servidor..."}
                {updated&&<span>· {updated.toLocaleTimeString("pt-PT")}</span>}
              </div>
            </div>
          </div>
          <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
            <button onClick={()=>setShowAlerts(p=>!p)} style={{padding:"5px 11px",borderRadius:6,border:`1px solid ${alerts.filter(a=>!a.read).length>0?"#f59e0b":"rgba(18,42,78,.7)"}`,background:alerts.filter(a=>!a.read).length>0?"rgba(245,158,11,.15)":"transparent",color:alerts.filter(a=>!a.read).length>0?"#f59e0b":"#253a5e",fontSize:11,cursor:"pointer",fontFamily:"inherit",position:"relative"}}>
              🔔{alerts.filter(a=>!a.read).length>0&&<span style={{position:"absolute",top:-4,right:-4,background:"#ef4444",color:"#fff",borderRadius:"50%",width:14,height:14,fontSize:9,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700}}>{alerts.filter(a=>!a.read).length}</span>}
            </button>
            {installPrompt&&!installed&&(
              <button onClick={()=>installPrompt.prompt()} style={{padding:"5px 11px",borderRadius:6,border:"1px solid #1a5fd4",background:"rgba(26,95,212,.2)",color:"#4da6ff",fontSize:10,cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>
                📲 Instalar App
              </button>
            )}
            <button onClick={()=>setAutoR(p=>!p)} style={{padding:"5px 11px",borderRadius:6,border:`1px solid ${autoR?"#0d9488":"#1e3a5f"}`,background:autoR?"rgba(13,148,136,.15)":"transparent",color:autoR?"#0d9488":"#253a5e",fontSize:10,cursor:"pointer",fontFamily:"inherit"}}>
              {autoR?"🔄 Auto ON":"🔄 Auto OFF"}
            </button>
            <div style={{display:"flex",gap:5,background:"rgba(3,6,18,.9)",borderRadius:8,padding:3,border:"1px solid rgba(18,42,78,.8)"}}>
              {TABS.map(([id,lbl])=><TabBtn key={id} active={tab===id} onClick={()=>switchTab(id)}>{lbl}</TabBtn>)}
            </div>
          </div>
        </div>

        {/* ALERTS PANEL */}
        {showAlerts&&(
          <div style={{marginBottom:16,background:"rgba(4,10,22,.97)",border:"1px solid rgba(245,158,11,.4)",borderRadius:12,padding:"14px 16px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div style={{fontSize:13,fontWeight:700,color:"#f59e0b"}}>🔔 Alertas Activos</div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>{fetch("http://localhost:3001/api/alerts/read",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:"all"})}).then(()=>setAlerts(p=>p.map(a=>({...a,read:true}))))}} style={{fontSize:10,color:"#253a5e",background:"transparent",border:"1px solid rgba(18,42,78,.7)",borderRadius:4,padding:"3px 8px",cursor:"pointer",fontFamily:"inherit"}}>Marcar todos lidos</button>
                <button onClick={()=>setShowAlerts(false)} style={{fontSize:14,color:"#253a5e",background:"none",border:"none",cursor:"pointer"}}>×</button>
              </div>
            </div>
            {alerts.length===0?(
              <div style={{fontSize:12,color:"#253a5e",textAlign:"center",padding:"12px 0"}}>Sem alertas activos. O sistema monitoriza automaticamente.</div>
            ):(
              <div style={{display:"grid",gap:8,maxHeight:280,overflowY:"auto"}}>
                {alerts.map((a,i)=>(
                  <div key={i} style={{display:"flex",gap:10,padding:"9px 12px",background:a.read?"rgba(10,20,40,.4)":"rgba(245,158,11,.08)",borderRadius:8,border:`1px solid ${a.read?"rgba(18,42,78,.5)":"rgba(245,158,11,.3)"}`}}>
                    <span style={{fontSize:16,flexShrink:0}}>🔔</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,fontWeight:700,color:a.read?"#253a5e":"#f59e0b"}}>{a.label}</div>
                      <div style={{fontSize:11,color:"#4a6a8a",marginTop:2}}>{a.msg}</div>
                      <div style={{fontSize:10,color:"#1a3a5e",marginTop:2}}>{new Date(a.time).toLocaleTimeString("pt-PT")}</div>
                    </div>
                    <button onClick={()=>{ setPair(a.symbol); setShowAlerts(false); }} style={{fontSize:10,color:"#4da6ff",background:"transparent",border:"1px solid rgba(26,95,212,.3)",borderRadius:4,padding:"3px 8px",cursor:"pointer",fontFamily:"inherit",flexShrink:0}}>Ver</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* PAIR SELECTOR */}
        <div style={{display:"flex",gap:6,marginBottom:16,flexWrap:"wrap"}}>
          {PAIRS.map(p=>{
            const s=scanData.find(x=>x.symbol===p);
            return(
              <button key={p} onClick={()=>switchPair(p)} style={{padding:"6px 12px",borderRadius:7,border:`1px solid ${activePair===p?"#1a5fd4":"rgba(18,42,78,.7)"}`,background:activePair===p?"rgba(26,95,212,.2)":"rgba(4,10,22,.6)",cursor:"pointer",fontFamily:"inherit",transition:"all .18s",textAlign:"left",minWidth:88}}>
                <div style={{display:"flex",alignItems:"center",gap:4}}>
  <span style={{fontSize:12,fontWeight:700,color:activePair===p?"#4da6ff":"#8aaccc"}}>{p}</span>
  {CRYPTO.includes(p)&&<span style={{fontSize:8,color:"#f59e0b",background:"rgba(245,158,11,.15)",borderRadius:3,padding:"1px 4px"}}>₿</span>}
</div>
                {s?<div style={{fontSize:9,color:pCol(s.change_pct),marginTop:1}}>{fmtP(s.change_pct)} · {CRYPTO.includes(p)?`$${s.atr_pips.toLocaleString()}`:s.atr_pips+"p"}</div>
                  :<div style={{fontSize:9,color:"#1a3a5e",marginTop:1}}>{scanning?"...":"—"}</div>}
              </button>
            );
          })}
          <button onClick={()=>doScan()} disabled={scanning} style={{padding:"6px 13px",borderRadius:7,border:"1px solid rgba(18,42,78,.7)",background:"transparent",color:scanning?"#1a3a5e":"#253a5e",fontSize:11,cursor:scanning?"not-allowed":"pointer",fontFamily:"inherit"}}>
            {scanning?<><Spin/>Scan</>:"🔄 Scan"}
          </button>
        </div>

        {error&&<div style={{background:"rgba(239,68,68,.1)",border:"1px solid rgba(239,68,68,.3)",borderRadius:8,padding:"9px 14px",marginBottom:12,fontSize:12,color:"#ef4444",display:"flex",justifyContent:"space-between"}}>⚠️ {error}<button onClick={()=>setError(null)} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer"}}>×</button></div>}

        {/* ── DASHBOARD ── */}
        {tab==="dashboard"&&(
          <div style={{display:"grid",gap:14}}>
            {quote?(
              <>
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10}}>
                  {[{l:"Preço",v:fmt(quote.price),c:"#c8e0ff"},{l:"Variação",v:fmtP(quote.change_pct),c:pCol(quote.change_pct)},{l:"Máximo",v:fmt(quote.high),c:"#22c55e"},{l:"Mínimo",v:fmt(quote.low),c:"#ef4444"},{l:"Abertura",v:fmt(quote.open),c:"#4da6ff"}].map(k=>(
                    <C key={k.l} style={{padding:"12px",textAlign:"center"}}>
                      <div style={{fontSize:15,fontWeight:700,color:k.c}}>{k.v}</div>
                      <div style={{fontSize:10,color:"#253a5e",marginTop:3}}>{k.l}</div>
                    </C>
                  ))}
                </div>
                {ind&&(
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                    {[
                      {l:"ATR (14)",v:CRYPTO.includes(activePair)?`$${atrPips?.toLocaleString()}`:(`${atrPips}p`),c:isCryptoActive?"#f59e0b":atrPips>=80?"#22c55e":atrPips>=50?"#f59e0b":"#ef4444",s:isCryptoActive?"Volatilidade USD":atrPips>=80?"Alta vol.":atrPips>=50?"Vol. média":"Baixa vol."},
                      {l:"RSI (14)",v:fmt(ind.rsi,1),c:ind.rsi>70?"#ef4444":ind.rsi<30?"#22c55e":"#f59e0b",s:ind.rsi>70?"Sobrecomprado":ind.rsi<30?"Sobrevendido":"Neutro"},
                      {l:"MACD",v:macdBull?"Bullish":"Bearish",c:macdBull?"#22c55e":"#ef4444",s:`Hist ${fmt(ind.macd?.hist,5)}`},
                      {l:"Tendência",v:bull?"📈 Bullish":"📉 Bearish",c:bull?"#22c55e":"#ef4444",s:`vs EMA200 (${fmt(ind.ema200)})`},
                    ].map(k=>(
                      <C key={k.l} style={{padding:"13px",textAlign:"center"}}>
                        <div style={{fontSize:15,fontWeight:700,color:k.c}}>{k.v}</div>
                        <div style={{fontSize:10,color:"#253a5e",marginTop:3}}>{k.l}</div>
                        <div style={{fontSize:9,color:k.c+"99",marginTop:2}}>{k.s}</div>
                      </C>
                    ))}
                  </div>
                )}
                {candles.length>0&&(
                  <C>
                    <L t={`${activePair} — Fecho últimos 30 dias`}/>
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={candles}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(26,95,212,.07)"/>
                        <XAxis dataKey="date" tick={{fill:"#253a5e",fontSize:10}} axisLine={false} tickLine={false} interval={4}/>
                        <YAxis domain={["auto","auto"]} tick={{fill:"#253a5e",fontSize:10}} axisLine={false} tickLine={false} width={58}/>
                        <Tooltip contentStyle={{background:"#04080f",border:"1px solid #1a5fd4",borderRadius:8,fontSize:12}} formatter={v=>[fmt(v),"Close"]}/>
                        <Line type="monotone" dataKey="close" stroke="#1a5fd4" strokeWidth={2} dot={false}/>
                      </LineChart>
                    </ResponsiveContainer>
                  </C>
                )}
                {ind&&(
                  <C>
                    <L t="Médias Móveis"/>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
                      {[{l:"EMA 50",v:fmt(ind.ema50),a:quote.price>ind.ema50},{l:"EMA 200",v:fmt(ind.ema200),a:quote.price>ind.ema200},{l:"Preço Actual",v:fmt(quote.price),a:null}].map(k=>(
                        <div key={k.l} style={{textAlign:"center",padding:"12px",background:"rgba(10,20,40,.5)",borderRadius:8,border:`1px solid ${k.a===null?"rgba(26,95,212,.3)":k.a?"rgba(34,197,94,.2)":"rgba(239,68,68,.2)"}`}}>
                          <div style={{fontSize:14,fontWeight:700,color:k.a===null?"#4da6ff":k.a?"#22c55e":"#ef4444"}}>{k.v}</div>
                          <div style={{fontSize:10,color:"#253a5e",marginTop:3}}>{k.l}</div>
                          {k.a!==null&&<div style={{fontSize:9,color:k.a?"#22c55e":"#ef4444",marginTop:3}}>{k.a?"Acima ✓":"Abaixo ✗"}</div>}
                        </div>
                      ))}
                    </div>
                  </C>
                )}
              </>
            ):(
              <C style={{textAlign:"center",padding:24,color:"#253a5e",fontSize:12}}>{loadPair?<><Spin/>A carregar {activePair}...</>:"Seleciona um par"}</C>
            )}
          </div>
        )}

        {/* ── SCANNER ── */}
        {tab==="scanner"&&(
          <div style={{display:"grid",gap:14}}>
            <C glow>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:10}}>
                <div>
                  <L t="📡 Scanner — 8 Pares com Dados Reais" color="#0d9488" mb={4}/>
                  <div style={{fontSize:11,color:"#1a5a4a"}}>{scanning?<><Spin/>A varrer pares...</>:updated?`Actualizado ${updated.toLocaleTimeString("pt-PT")}`:"—"}</div>
                </div>
                <button onClick={()=>doScan()} disabled={scanning} style={{padding:"7px 18px",borderRadius:7,border:"1px solid #0d9488",background:scanning?"rgba(13,148,136,.06)":"rgba(13,148,136,.18)",color:scanning?"#1a5040":"#0d9488",fontSize:11,cursor:scanning?"not-allowed":"pointer",fontFamily:"inherit",fontWeight:700}}>
                  {scanning?<><Spin/>...</>:"🔄 Novo Scan"}
                </button>
              </div>
              {scanData.length>0?(
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                    <thead>
                      <tr style={{borderBottom:"1px solid #0d2040"}}>
                        {["Par","Tier","Preço","Variação","ATR (pips)","RSI","Tendência","Volatilidade"].map(h=>(
                          <th key={h} style={{padding:"8px 10px",color:"#253a5e",fontWeight:600,textAlign:"left",fontSize:10}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {scanData.map((p,i)=>(
                        <tr key={p.symbol} onClick={()=>switchPair(p.symbol)} style={{borderBottom:"1px solid rgba(13,32,64,.5)",cursor:"pointer",background:i%2===0?"transparent":"rgba(18,42,78,.1)"}}>
                          <td style={{padding:"9px 10px"}}><span style={{fontWeight:700,color:"#c8e0ff"}}>{p.symbol}</span>{p.tier===1&&<Tag t="T1" color="#4da6ff"/>}</td>
                          <td style={{padding:"9px 10px",color:"#253a5e",fontSize:11}}>Tier {p.tier}</td>
                          <td style={{padding:"9px 10px",color:"#c8e0ff",fontWeight:600}}>{fmt(p.price)}</td>
                          <td style={{padding:"9px 10px",color:pCol(p.change_pct),fontWeight:600}}>{fmtP(p.change_pct)}</td>
                          <td style={{padding:"9px 10px",fontWeight:700,color:CRYPTO.includes(p.symbol)?"#f59e0b":p.atr_pips>=80?"#22c55e":p.atr_pips>=50?"#f59e0b":"#ef4444"}}>
                            {CRYPTO.includes(p.symbol)?`$${p.atr_pips.toLocaleString()}`:`${p.atr_pips}p`}
                          </td>
                          <td style={{padding:"9px 10px",color:p.rsi>70?"#ef4444":p.rsi<30?"#22c55e":"#f59e0b",fontWeight:600}}>{fmt(p.rsi,1)}</td>
                          <td style={{padding:"9px 10px",color:p.trend==="bull"?"#22c55e":"#ef4444",fontSize:13}}>{p.trend==="bull"?"📈":"📉"}</td>
                          <td style={{padding:"9px 10px"}}>
                            <div style={{display:"flex",alignItems:"center",gap:6}}>
                              <div style={{width:CRYPTO.includes(p.symbol)?Math.min(p.atr_pips*.03,70):Math.min(p.atr_pips*.35,70),height:5,borderRadius:3,background:CRYPTO.includes(p.symbol)?"#f59e0b":p.atr_pips>=80?"#22c55e":p.atr_pips>=50?"#f59e0b":"#ef4444",opacity:.75}}/>
                              <span style={{fontSize:10,color:"#253a5e"}}>{CRYPTO.includes(p.symbol)?(p.atr_pips>=500?"Alta":p.atr_pips>=100?"Média":"Baixa"):(p.atr_pips>=80?"Alta":p.atr_pips>=50?"Média":"Baixa")}</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ):(
                <div style={{textAlign:"center",color:"#253a5e",padding:28,fontSize:12}}>{scanning?<><Spin/>A varrer...</>:"Clica em Novo Scan"}</div>
              )}
            </C>
            {scanData.length>0&&(
              <C>
                <L t="ATR Comparativo — Volatilidade Diária"/>
                <ResponsiveContainer width="100%" height={175}>
                  <BarChart data={scanData} margin={{top:4,right:10,bottom:4,left:-10}}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(26,95,212,.07)"/>
                    <XAxis dataKey="symbol" tick={{fill:"#253a5e",fontSize:10}} axisLine={false} tickLine={false} tickFormatter={s=>s.replace("/","")}/>
                    <YAxis tick={{fill:"#253a5e",fontSize:10}} axisLine={false} tickLine={false}/>
                    <Tooltip contentStyle={{background:"#04080f",border:"1px solid #1a5fd4",borderRadius:8,fontSize:12}} formatter={v=>[`${v} pips`,"ATR"]}/>
                    <ReferenceLine y={80} stroke="#22c55e" strokeDasharray="4 4" strokeWidth={1}/>
                    <ReferenceLine y={50} stroke="#f59e0b" strokeDasharray="4 4" strokeWidth={1}/>
                    <Bar dataKey="atr_pips" radius={[4,4,0,0]}>
                      {scanData.map((p,i)=><Cell key={i} fill={CRYPTO.includes(p.symbol)?"#f59e0b":p.atr_pips>=80?"#22c55e":p.atr_pips>=50?"#f59e0b":"#ef4444"} opacity={p.symbol===activePair?1:.6}/>)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </C>
            )}
          </div>
        )}

        {/* ── INDICADORES ── */}
        {tab==="detail"&&(
          <div style={{display:"grid",gap:14}}>
            {loadPair&&<C style={{textAlign:"center",padding:24,color:"#253a5e",fontSize:12}}><Spin/>A carregar {activePair}...</C>}
            {ind&&quote&&!loadPair&&(
              <>
                <C glow>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12}}>
                    <div>
                      <div style={{fontSize:22,fontWeight:700,color:"#c8e0ff"}}>{activePair}</div>
                      <div style={{fontSize:28,fontWeight:700,color:"#4da6ff",marginTop:4}}>{fmt(quote.price)}</div>
                      <div style={{fontSize:13,color:pCol(quote.change_pct),marginTop:2}}>{fmtP(quote.change_pct)} hoje</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:11,color:"#253a5e"}}>Tendência vs EMA200</div>
                      <div style={{fontSize:14,fontWeight:700,color:bull?"#22c55e":"#ef4444",marginTop:4}}>{bull?"📈 Bullish":"📉 Bearish"}</div>
                      <div style={{fontSize:11,color:"#253a5e",marginTop:8}}>ATR Diário</div>
                      <div style={{fontSize:18,fontWeight:700,color:"#f59e0b"}}>{isCryptoActive?`$${atrPips?.toLocaleString()}`:atrPips} {isCryptoActive?"USD":"pips"}</div>
                    </div>
                  </div>
                </C>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                  <C>
                    <L t="RSI (14)"/>
                    <div style={{fontSize:32,fontWeight:700,color:ind.rsi>70?"#ef4444":ind.rsi<30?"#22c55e":"#f59e0b",marginBottom:10}}>{fmt(ind.rsi,1)}</div>
                    <div style={{background:"rgba(18,42,78,.4)",borderRadius:6,height:8,position:"relative",overflow:"hidden"}}>
                      <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${ind.rsi}%`,background:ind.rsi>70?"#ef4444":ind.rsi<30?"#22c55e":"#f59e0b",borderRadius:6}}/>
                      {[30,70].map(l=><div key={l} style={{position:"absolute",left:`${l}%`,top:0,bottom:0,width:1,background:"rgba(255,255,255,.2)"}}/>)}
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",marginTop:4,fontSize:9,color:"#1a3a5e"}}><span>0</span><span>30</span><span>70</span><span>100</span></div>
                  </C>
                  <C>
                    <L t="MACD"/>
                    <div style={{fontSize:18,fontWeight:700,color:macdBull?"#22c55e":"#ef4444",marginBottom:12}}>{macdBull?"📈 Bullish":"📉 Bearish"}</div>
                    {[["MACD Line",ind.macd?.macd,5],["Signal",ind.macd?.signal,5],["Histograma",ind.macd?.hist,5]].map(([l,v,d])=>(
                      <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"6px 10px",background:"rgba(10,20,40,.4)",borderRadius:6,marginBottom:5}}>
                        <span style={{fontSize:12,color:"#253a5e"}}>{l}</span>
                        <span style={{fontSize:12,fontWeight:700,color:v>0?"#22c55e":"#ef4444"}}>{fmt(v,d)}</span>
                      </div>
                    ))}
                  </C>
                </div>
                <C>
                  <L t="Médias Móveis"/>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
                    {[{l:"EMA 50",v:fmt(ind.ema50),a:quote.price>ind.ema50},{l:"EMA 200",v:fmt(ind.ema200),a:quote.price>ind.ema200},{l:"Preço",v:fmt(quote.price),a:null}].map(k=>(
                      <div key={k.l} style={{textAlign:"center",padding:"14px",background:"rgba(10,20,40,.5)",borderRadius:8,border:`1px solid ${k.a===null?"rgba(26,95,212,.3)":k.a?"rgba(34,197,94,.2)":"rgba(239,68,68,.2)"}`}}>
                        <div style={{fontSize:14,fontWeight:700,color:k.a===null?"#4da6ff":k.a?"#22c55e":"#ef4444"}}>{k.v}</div>
                        <div style={{fontSize:10,color:"#253a5e",marginTop:4}}>{k.l}</div>
                        {k.a!==null&&<div style={{fontSize:9,color:k.a?"#22c55e":"#ef4444",marginTop:3}}>{k.a?"Acima ✓":"Abaixo ✗"}</div>}
                      </div>
                    ))}
                  </div>
                </C>
                {candles.length>0&&(
                  <C>
                    <L t={`${activePair} — High / Close / Low — 30 dias`}/>
                    <ResponsiveContainer width="100%" height={220}>
                      <LineChart data={candles}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(26,95,212,.07)"/>
                        <XAxis dataKey="date" tick={{fill:"#253a5e",fontSize:10}} axisLine={false} tickLine={false} interval={4}/>
                        <YAxis domain={["auto","auto"]} tick={{fill:"#253a5e",fontSize:10}} axisLine={false} tickLine={false} width={58}/>
                        <Tooltip contentStyle={{background:"#04080f",border:"1px solid #1a5fd4",borderRadius:8,fontSize:12}} formatter={(v,n)=>[fmt(v),n]}/>
                        <Line type="monotone" dataKey="high"  stroke="rgba(34,197,94,.5)"  strokeWidth={1} dot={false} name="High"/>
                        <Line type="monotone" dataKey="close" stroke="#1a5fd4" strokeWidth={2} dot={false} name="Close"/>
                        <Line type="monotone" dataKey="low"   stroke="rgba(239,68,68,.5)"  strokeWidth={1} dot={false} name="Low"/>
                      </LineChart>
                    </ResponsiveContainer>
                  </C>
                )}
              </>
            )}
          </div>
        )}

        {/* ── RELATÓRIO IA ── */}
        {tab==="report"&&(
          <div style={{display:"grid",gap:14}}>
            {/* pair header */}
            {scanPair&&(
              <C style={{padding:"14px 18px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{fontSize:18,fontWeight:800,color:"#c8e0ff"}}>{activePair}</div>
                    <div style={{fontSize:22,fontWeight:800,color:"#4da6ff"}}>{fmt(scanPair.price)}</div>
                    <Tag t={fmtP(scanPair.change_pct)} color={pCol(scanPair.change_pct)}/>
                    <Tag t={scanPair.trend==="bull"?"📈 Bullish":"📉 Bearish"} color={scanPair.trend==="bull"?"#22c55e":"#ef4444"}/>
                    <Tag t={isCryptoActive?`ATR $${scanPair?.atr_pips?.toLocaleString()}`:`ATR ${scanPair?.atr_pips}p`} color="#f59e0b"/>
                  </div>
                  <button onClick={()=>genReport(scanPair)} disabled={repLoad} style={{padding:"6px 16px",borderRadius:7,border:"1px solid #1a5fd4",background:"rgba(26,95,212,.18)",color:repLoad?"#1a3a6e":"#4da6ff",fontSize:11,cursor:repLoad?"not-allowed":"pointer",fontFamily:"inherit",fontWeight:700}}>
                    {repLoad?<><Spin/>A analisar...</>:"🔄 Nova análise"}
                  </button>
                </div>
              </C>
            )}

            {/* Pip Ladder */}
            {ladder.length>0&&(
              <C>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                  <L t={isCryptoActive?`📊 Probability Ladder — $${Math.max(1,Math.round((atrPips||1)*0.2))} a $${Math.round((atrPips||1)*7)}`:"📊 Pip Probability Ladder — 50 a 500 pips"} mb={0}/>
                  <div style={{fontSize:10,color:"#253a5e"}}>Base: ATR {isCryptoActive?`$${atrPips?.toLocaleString()}`:`${atrPips}p`}/dia · {[bull?"Tendência ✓":"Tendência ✗",macdBull?"MACD ✓":"MACD ✗"].join(" · ")}</div>
                </div>
                <PipLadder ladder={ladder} dir={bull?"LONG":"SHORT"} isCrypto={isCryptoActive}/>
                <div style={{marginTop:12,padding:"9px 12px",background:"rgba(18,42,78,.2)",borderRadius:7,fontSize:11,color:"#253a5e",lineHeight:1.7}}>
                  <strong style={{color:"#4da6ff"}}>ATR vs Potencial:</strong> {isCryptoActive?`O ATR do ${activePair} é $${atrPips?.toLocaleString()} por dia. A ladder mostra níveis em USD ajustados à volatilidade real.`:`O ATR (${atrPips}p) é o movimento médio diário. Para atingir 300p precisas de ~${Math.ceil(300/Math.max(atrPips||1,1))} dias. Swing Trading é o horizonte ideal.`}
                </div>
              </C>
            )}

            {/* AI Report */}
            <AiReport report={report} loading={repLoad} error={repErr} onRefresh={()=>genReport(scanPair)} symbol={activePair}/>
          </div>
        )}


        {/* ── BACKTEST ── */}
        {tab==="backtest"&&(
          <div style={{display:"grid",gap:14}}>
            {/* Controls */}
            <C>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
                <div>
                  <L t="📈 Backtest — Simulação Histórica" color="#0d9488" mb={4}/>
                  <div style={{fontSize:11,color:"#1a5a4a"}}>SL = 1.2× ATR · TP1 = 1.8× ATR · TP2 = 3× ATR · {btData?btData.period:"500 dias de histórico"}</div>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                  <select value={btPair} onChange={e=>{setBTPair(e.target.value);}} style={{padding:"6px 10px",borderRadius:6,border:"1px solid rgba(18,42,78,.7)",background:"rgba(4,10,22,.9)",color:"#8aaccc",fontSize:11,fontFamily:"inherit"}}>
                    {PAIRS.map(p=><option key={p} value={p}>{p}</option>)}
                  </select>
                  <button onClick={()=>fetchBacktest(btPair)} disabled={btLoad} style={{padding:"7px 18px",borderRadius:7,border:"1px solid #0d9488",background:btLoad?"rgba(13,148,136,.06)":"rgba(13,148,136,.18)",color:btLoad?"#1a5040":"#0d9488",fontSize:11,cursor:btLoad?"not-allowed":"pointer",fontFamily:"inherit",fontWeight:700}}>
                    {btLoad?<><Spin/>A calcular...</>:"▶ Executar Backtest"}
                  </button>
                </div>
              </div>
            </C>

            {btLoad&&<C style={{textAlign:"center",padding:28}}><Spin/><span style={{color:"#253a5e",fontSize:13}}>A simular {btPair} em 500 dias...</span></C>}

            {btData&&(()=>{
              const strategies = [
                {key:"confluence",  label:"🎯 Confluência 3/3",     color:"#0d9488", desc:"RSI+MACD+EMA200 alinhados"},
                {key:"session",     label:"🕐 Confluência + Sessão", color:"#4da6ff", desc:"3/3 + dia de semana"},
                {key:"rsi_extreme", label:"📊 RSI Extremo",          color:"#f59e0b", desc:"RSI<30 LONG ou RSI>70 SHORT"},
                {key:"all_signals", label:"⚡ 2+ Sinais",            color:"#a78bfa", desc:"Qualquer 2 confluências"},
              ];

              return(
                <div style={{display:"grid",gap:14}}>

                  {/* Strategy comparison cards */}
                  <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10}}>
                    {strategies.map(s=>{
                      const st = btData.stats[s.key];
                      const isPos = st.total_pnl > 0;
                      return(
                        <C key={s.key} style={{borderColor:s.color+"44"}}>
                          <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
                            <div>
                              <div style={{fontSize:12,fontWeight:700,color:s.color}}>{s.label}</div>
                              <div style={{fontSize:10,color:"#1a3a5e",marginTop:2}}>{s.desc}</div>
                            </div>
                            <div style={{textAlign:"right"}}>
                              <div style={{fontSize:22,fontWeight:800,color:isPos?"#22c55e":"#ef4444"}}>{st.win_rate}%</div>
                              <div style={{fontSize:10,color:"#253a5e"}}>Win Rate</div>
                            </div>
                          </div>
                          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
                            {[
                              {l:"Trades",   v:st.trades,                          c:"#c8e0ff"},
                              {l:"P&L Total", v:`${st.total_pnl>0?"+":""}${st.total_pnl}p`, c:isPos?"#22c55e":"#ef4444"},
                              {l:"Profit Factor", v:st.profit_factor,             c:st.profit_factor>=1?"#22c55e":"#ef4444"},
                              {l:"Média/Trade",v:`${st.avg_pnl>0?"+":""}${st.avg_pnl}p`,    c:st.avg_pnl>0?"#22c55e":"#ef4444"},
                              {l:"Melhor",    v:`+${st.best}p`,                    c:"#22c55e"},
                              {l:"Pior",      v:`${st.worst}p`,                    c:"#ef4444"},
                            ].map(k=>(
                              <div key={k.l} style={{textAlign:"center",padding:"8px 4px",background:"rgba(10,20,40,.5)",borderRadius:6}}>
                                <div style={{fontSize:13,fontWeight:700,color:k.c}}>{k.v}</div>
                                <div style={{fontSize:9,color:"#253a5e",marginTop:2}}>{k.l}</div>
                              </div>
                            ))}
                          </div>
                          {/* Win rate bar */}
                          <div style={{marginTop:10,background:"rgba(18,42,78,.4)",borderRadius:4,height:6,overflow:"hidden"}}>
                            <div style={{width:`${st.win_rate}%`,height:"100%",background:s.color,borderRadius:4,transition:"width 1s"}}/>
                          </div>
                          {/* Equity curve mini */}
                          {st.equity?.length>1&&(()=>{
                            const eq=st.equity; const mn=Math.min(...eq); const mx=Math.max(...eq);
                            const range=mx-mn||1; const w=200; const h=40;
                            const pts=eq.map((v,i)=>`${Math.round(i/(eq.length-1)*w)},${Math.round((1-(v-mn)/range)*h)}`).join(" ");
                            const lineColor=eq[eq.length-1]>0?"#22c55e":"#ef4444";
                            return(
                              <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} style={{marginTop:8,display:"block"}}>
                                <polyline points={pts} fill="none" stroke={lineColor} strokeWidth="1.5" opacity=".8"/>
                                <line x1="0" y1={Math.round((1-(0-mn)/range)*h)} x2={w} y2={Math.round((1-(0-mn)/range)*h)} stroke="rgba(255,255,255,.1)" strokeDasharray="3 3"/>
                              </svg>
                            );
                          })()}
                        </C>
                      );
                    })}
                  </div>

                  {/* Pip Ladder Accuracy */}
                  {btData.ladder_accuracy?.length>0&&(
                    <C>
                      <L t="🎯 Precisão da Pip Ladder — Backtested" color="#4da6ff"/>
                      <div style={{fontSize:11,color:"#1a5a4a",marginBottom:12}}>Comparação entre probabilidades previstas e resultados reais nos {btData.bars_used} dias testados</div>
                      <div style={{display:"grid",gap:6}}>
                        {btData.ladder_accuracy.map((l,i)=>(
                          <div key={i} style={{display:"flex",alignItems:"center",gap:10}}>
                            <div style={{width:90,fontSize:11,color:"#253a5e",flexShrink:0}}>{l.label}</div>
                            <div style={{flex:1,position:"relative",height:20,background:"rgba(18,42,78,.3)",borderRadius:4,overflow:"hidden"}}>
                              <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${l.accuracy}%`,background:l.accuracy>=60?"#22c55e":l.accuracy>=40?"#f59e0b":"#ef4444",opacity:.7,borderRadius:4}}/>
                            </div>
                            <div style={{width:50,fontSize:11,fontWeight:700,color:l.accuracy>=60?"#22c55e":l.accuracy>=40?"#f59e0b":"#ef4444"}}>{l.accuracy}%</div>
                            <div style={{width:60,fontSize:10,color:"#253a5e"}}>{l.hits}/{l.total}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{marginTop:10,fontSize:10,color:"#1a3a5e",lineHeight:1.7}}>
                        * Testado com a estratégia de Confluência 3/3 · Horizonte: 5 barras após entrada
                      </div>
                    </C>
                  )}

                  {/* Recent trades table */}
                  <C>
                    <L t="📋 Últimos 20 Trades — Confluência 3/3"/>
                    <div style={{overflowX:"auto"}}>
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                        <thead>
                          <tr style={{borderBottom:"1px solid #0d2040"}}>
                            {["Data","Dir","Entrada","SL","TP1","RSI","ATR","Resultado","P&L"].map(h=>(
                              <th key={h} style={{padding:"6px 8px",color:"#253a5e",fontWeight:600,textAlign:"left",fontSize:10}}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {(btData.stats.confluence.recent||[]).map((t,i)=>(
                            <tr key={i} style={{borderBottom:"1px solid rgba(13,32,64,.5)",background:i%2===0?"transparent":"rgba(18,42,78,.1)"}}>
                              <td style={{padding:"6px 8px",color:"#4a6a8a"}}>{t.date?.slice(5)}</td>
                              <td style={{padding:"6px 8px",color:t.dir==="LONG"?"#22c55e":"#ef4444",fontWeight:700}}>{t.dir}</td>
                              <td style={{padding:"6px 8px",color:"#c8e0ff"}}>{t.entry?.toFixed(4)}</td>
                              <td style={{padding:"6px 8px",color:"#ef4444"}}>{t.sl?.toFixed(4)}</td>
                              <td style={{padding:"6px 8px",color:"#22c55e"}}>{t.tp1?.toFixed(4)}</td>
                              <td style={{padding:"6px 8px",color:t.rsi>70?"#ef4444":t.rsi<30?"#22c55e":"#f59e0b"}}>{t.rsi}</td>
                              <td style={{padding:"6px 8px",color:"#f59e0b"}}>{t.atr_pips}p</td>
                              <td style={{padding:"6px 8px",color:t.result==="SL"?"#ef4444":"#22c55e",fontWeight:700}}>{t.result}</td>
                              <td style={{padding:"6px 8px",fontWeight:700,color:t.pnl_pips>0?"#22c55e":"#ef4444"}}>{t.pnl_pips>0?"+":""}{t.pnl_pips}p</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </C>

                </div>
              );
            })()}
          </div>
        )}

      </div>
    </div>
  );
}
