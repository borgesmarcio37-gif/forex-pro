const BASE = process.env.REACT_APP_API_URL || "http://localhost:3001/api";
async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`Erro ${res.status}`);
  return res.json();
}
export const api = {
  health:     ()                              => get("/health"),
  quote:      (symbol)                        => get(`/quote?symbol=${encodeURIComponent(symbol)}`),
  candles:    (symbol, interval="1day", n=30) => get(`/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${n}`),
  indicators: (symbol, interval="1day")       => get(`/indicators?symbol=${encodeURIComponent(symbol)}&interval=${interval}`),
  scan:       ()                              => get("/scan"),
};
