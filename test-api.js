// Coloca este ficheiro na pasta forex-pro e executa: node test-api.js
require("dotenv").config();
const https = require("https");

const key = process.env.ANTHROPIC_API_KEY;
console.log("API Key:", key ? key.slice(0,20) + "..." : "NAO ENCONTRADA");

const body = JSON.stringify({
  model: "claude-3-5-sonnet-20241022",
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
  res.on("data", chunk => data += chunk);
  res.on("end", () => {
    console.log("Status:", res.statusCode);
    console.log("Response:", data);
  });
});

req.on("error", e => console.error("Error:", e.message));
req.write(body);
req.end();
