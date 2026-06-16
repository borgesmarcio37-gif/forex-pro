require("dotenv").config();
const https = require("https");

const key = process.env.ANTHROPIC_API_KEY;

const models = [
  "claude-opus-4-5",
  "claude-sonnet-4-5", 
  "claude-haiku-4-5-20251001",
  "claude-3-haiku-20240307",
  "claude-3-sonnet-20240229",
];

async function testModel(model) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      model,
      max_tokens: 10,
      messages: [{ role: "user", content: "Say OK" }]
    });
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        const ok = res.statusCode === 200;
        console.log(`${ok ? "✅" : "❌"} ${model} — ${res.statusCode}`);
        resolve(ok);
      });
    });
    req.on("error", e => { console.log(`❌ ${model} — ${e.message}`); resolve(false); });
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log("A testar modelos...\n");
  for (const m of models) {
    await testModel(m);
    await new Promise(r => setTimeout(r, 500));
  }
})();
