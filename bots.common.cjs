// Общая часть для телеграм-ботов календаря.
// Подключение к Supabase (те же URL/ключ/пароль, что у сайта). Значения читаются из .env.
const fs = require("fs");
const path = require("path");

// Простейший загрузчик .env (без внешних зависимостей)
try {
  const envFile = path.join(__dirname, ".env");
  const txt = fs.readFileSync(envFile, "utf8");
  txt.split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  });
} catch (e) { /* нет .env — используем process.env / значения по умолчанию */ }

// ВАЖНО: значения SUPABASE_URL, ANON_KEY, APP_PASSWORD должны приходить из
// переменных окружения (в Render — через Environment). Секреты в коде не храним.
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const ANON_KEY = process.env.ANON_KEY || "";
const PASSWORD = process.env.APP_PASSWORD || "";

async function rpc(fn, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "apikey": ANON_KEY, "Authorization": "Bearer " + ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ p_password: PASSWORD, ...body })
  });
  const t = await r.text();
  if (!r.ok) throw new Error(fn + " -> " + r.status + " " + t.slice(0, 160));
  return t ? JSON.parse(t) : null;
}

async function getChangeLog(afterId) {
  return rpc("get_change_log", { p_after: afterId || 0 });
}

// Слот в строке ISO со смещением +03:00 (как сохраняет сайт).
function parseSlot(dateStr, timeStr) {
  const [dd, mm] = dateStr.split(".").map(Number);
  let y = 2026;
  if (mm === 1 || mm === 2) y = 2027;
  const [hh, mi] = timeStr.split(":").map(Number);
  return `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00+03:00`;
}

module.exports = { SUPABASE_URL, ANON_KEY, PASSWORD, rpc, getChangeLog, parseSlot };