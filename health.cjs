// Мини-HTTP-сервер для Render: отвечает на запросы и показывает, доступен ли api.telegram.org.
// Render ожидает, что Web Service слушает PORT. Этот сервер даёт страницу-проверку.
const http = require("http");
const PORT = process.env.PORT || 10000;
const TOKEN = process.env.BOT_INCOMING_TOKEN || "";
const VER = "v2026.11.21-e"; // маркер версии: передеплой после фикса sameSlot в одиночной ветке

async function checkTelegram() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch("https://api.telegram.org/bot" + TOKEN + "/getMe", { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    return { ok: r.ok, status: r.status, body: j };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url === "/ping" || req.url === "/") {
    const t = await checkTelegram();
    const parts = [];
    parts.push("<h1>Боты календаря ресторана</h1>");
    parts.push("<p>Версия: " + VER + "</p>");
    parts.push("<p>Время сервера: " + new Date().toISOString() + "</p>");
    if (t.ok) {
      parts.push("<p style='color:green'>✅ api.telegram.org доступен</p>");
      parts.push("<pre>" + JSON.stringify(t.body, null, 2) + "</pre>");
    } else {
      parts.push("<p style='color:red'>❌ api.telegram.org НЕ доступен</p>");
      parts.push("<pre>" + JSON.stringify(t, null, 2) + "</pre>");
    }
    parts.push("<p>⌛ Обновить: <a href='/'>обновить</a></p>");
    res.end(parts.join("\n"));
  } else {
    res.statusCode = 404;
    res.end("not found");
  }
});

server.listen(PORT, () => console.log("health server on port " + PORT));