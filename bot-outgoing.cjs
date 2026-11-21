// Бот-уведомлений: опрашивает change_log (source='site') и шлёт изменения в чаты.
//
// Маршрут по дате брони:
//   дата = текущий день (Москва) -> CHAT_CURRENT_ID  (чат «Общий», без даты в заголовке)
//   дата != текущий день          -> CHAT_FUTURE_ID   (чат «Брони», с датой в заголовке)
//
// Запуск:  node bot-outgoing.cjs
const { getChangeLog } = require("./bots.common.cjs");

const TOKEN = process.env.BOT_OUTGOING_TOKEN || "";
const API = "https://api.telegram.org/bot" + TOKEN;
const CHAT_CURRENT_ID = Number(process.env.CHAT_CURRENT_ID || 0);
const CHAT_FUTURE_ID = Number(process.env.CHAT_FUTURE_ID || 0);

async function tg(method, payload) {
  const r = await fetch(API + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  const j = await r.json();
  if (!j.ok) throw new Error("TG " + method + ": " + (j.description || "err"));
  return j.result;
}

function todayMsk() {
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  const p = n => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
}

function slotDate(slot) {
  // "2026-11-22T16:00:00+00:00" -> "2026-11-22"
  return (slot || "").slice(0, 10);
}

// Вспомогательное: короткое имя поля для человека.
const FIELD_MAP = {
  slot: "время", name: "имя", guests: "кол-во человек", phone: "телефон", comment: "комментарий",
  preorder: "предзаказ", total_sum: "общая сумма", deposit: "предоплата", deposit_sum: "сумма предоплаты",
  deposit_method: "способ оплаты", cake: "торт", chat_enabled: "чат", chat_messenger: "мессенджер",
  responsible: "ответственный", no_booking: "НЕ БРОНИРОВАТЬ"
};

// Конвертировать ISO-слот (UTC) в московское время → [дата, время]
function mskDate(slot) {
  const dt = new Date(slot);
  const d = new Date(dt.getTime() + 3 * 3600 * 1000);
  const p = n => String(n).padStart(2, "0");
  const date = d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
  const time = p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
  return { date, time };
}
function fmtTime(slot) { return mskDate(slot).time; }
function slotDate(slot) { return mskDate(slot).date; }

// Строки брони по вашим правилам. Пара филиалов: showDate (для чата «Брони»).
function bookingLines(rec, showDate) {
  const L = [];
  const { date, time } = mskDate(rec.slot);
  if (showDate) L.push(date);
  L.push("🔳 " + time);
  L.push((rec.guests || "?") + " человек " + (rec.name || ""));
  // Опциональные поля — строка только если есть значение/чекбокс (жирным — те, что вы указали)
  if (rec.phone) L.push("Телефон: " + esc(rec.phone));
  if (rec.comment) L.push("Комментарий: " + esc(rec.comment));
  if (rec.preorder) L.push("<b>✅ ПРЕДЗАКАЗ</b>");
  if (rec.total_sum != null) L.push("<b>✅ ОБЩАЯ СУММА " + esc(fmtMoney(rec.total_sum)) + "</b>");
  if (rec.deposit) L.push("<b>✅ ПРЕДОПЛАТА " + esc(fmtMoney(rec.deposit_sum)) + (rec.deposit_method ? " " + esc(rec.deposit_method) : "") + "</b>");
  if (rec.cake) L.push("<b>✅ ТОРТ " + esc(rec.cake) + "</b>");
  if (rec.chat_enabled) L.push("✅ ЧАТ");
  if (rec.responsible) L.push("Ответственный: " + esc(rec.responsible));
  return L;
}
function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function fmtMoney(v){ if(v==null||v===undefined||v==="") return ""; return Number(v).toLocaleString('ru-RU') + " ₽"; }

// Собрать текст сообщения для записи журнала.
function compose(rec) {
  const today = todayMsk();
  const isToday = slotDate(rec.slot) === today;
  const showDate = !isToday; // в чате «Брони» показываем дату
  const base = bookingLines(rec, showDate);

  if (rec.action === "create") return base.join("\n");
  if (rec.action === "delete") return base.concat("<b>❌ ОТМЕНА</b>").join("\n");
  if (rec.action === "update") {
    // диф атрибутов между payload_old и payload(новые значения)
    const changed = diffAttrs(rec.payload_old, rec.payload);
    const head = changed.length
      ? "<b>‼️ ИЗМЕНЕНИЕ: " + esc(changed.join(", ")) + "</b>"
      : "<b>‼️ ИЗМЕНЕНИЕ</b>";
    return head + "\n" + base.join("\n");
  }
  return base.join("\n");
}

// Сравнить старый снимок и присланные поля; вернуть русские имена изменённых полей.
function diffAttrs(oldP, newP) {
  if (!oldP || !newP) return [];
  const out = [];
  for (const k of Object.keys(FIELD_MAP)) {
    let o = oldP[k], n = newP[k];
    // для времени/slot старый хранит ISO, новый — переданную строку; сравниваем по дате/времени семантически
    if (k === "slot") {
      const os = (o||"").slice(0,16), ns = (n||"").slice(0,16);
      if (os && ns && os !== ns) out.push(FIELD_MAP[k]);
      continue;
    }
    // нормализуем числа/булевы
    if (n != null && (typeof n === "object" && n.value != null)) n = n.value;
    if (o != null && (typeof o === "object" && o.value != null)) o = o.value;
    if (n == null && o == null) continue;
    if (String(n ?? "") !== String(o ?? "")) out.push(FIELD_MAP[k]);
  }
  return out;
}

async function processNew(lastId) {
  const rows = await getChangeLog(lastId);
  let newest = lastId;
  for (const rec of rows) {
    newest = rec.id;
    // антицикл: шлём только изменения, внесённые на сайте
    if (rec.source && rec.source !== "site") continue;
    if (!rec.slot) continue;
    const isToday = slotDate(rec.slot) === todayMsk();
    const chatId = isToday ? CHAT_CURRENT_ID : CHAT_FUTURE_ID;
    if (!chatId) continue;
    const text = compose(rec);
    try { await tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" }); }
    catch (e) { console.error("send→" + chatId, e.message); }
  }
  return newest;
}

async function main() {
  if (!TOKEN) { console.error("Задайте BOT_OUTGOING_TOKEN в .env"); process.exit(1); }
  if (!CHAT_CURRENT_ID && !CHAT_FUTURE_ID) {
    console.error("Задайте CHAT_CURRENT_ID / CHAT_FUTURE_ID в .env"); process.exit(1);
  }
  console.log("Бот-уведомлений запущен. Общий=" + CHAT_CURRENT_ID + ", Брони=" + CHAT_FUTURE_ID);
  let last = 0;
  try { const rows = await getChangeLog(0); last = rows.length ? rows[rows.length - 1].id : 0; } catch (e) {}
  while (true) {
    try { last = await processNew(last); }
    catch (e) { console.error("poll error:", e.message); }
    await new Promise(r => setTimeout(r, 5000));
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { compose, diffAttrs, processNew, CHAT_CURRENT_ID, CHAT_FUTURE_ID };