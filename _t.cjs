const fs = require("fs");
const path = require("path");
const env = fs.readFileSync(path.join(__dirname, "..", "telegram-bots", ".env"), "utf8").split(/\r?\n/);
for (const line of env) { const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); }
const { handleMessage } = require("./bot-incoming.cjs");
const formats = [
  "24.11\n🔳20:00\nЗина 2 чел\n25 стол❗️",
  "24.11\n🔳20:00\nЗина 2 чел\n25 стол❗️\n",
];
(async () => {
  for (const t of formats) {
    try {
      const reply = await handleMessage(t, -5521775733);
      console.log("=== формат ===\n" + JSON.stringify(t) + "\n   => " + reply);
    } catch (e) { console.log("ERR:", e.message); }
  }
})();