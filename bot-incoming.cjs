// Бот-приёмник: читает сообщения из чатов, понимает намерение,
// сверяет с существующей базой и вносит изменения (без дублей).
//
// Два чата (по chat_id из .env):
//   CHAT_FUTURE_ID  — чат броней на будущие даты (в сообщениях есть дата)
//   CHAT_CURRENT_ID — чат броней на текущую дату (без даты) + служебная инфо
//
// Запуск:  node bot-incoming.cjs
const { rpc, getChangeLog, parseSlot } = require("./bots.common.cjs");

const TOKEN = process.env.BOT_INCOMING_TOKEN || "";
const API = "https://api.telegram.org/bot" + TOKEN;
const CHAT_FUTURE_ID = Number(process.env.CHAT_FUTURE_ID || 0);
const CHAT_CURRENT_ID = Number(process.env.CHAT_CURRENT_ID || 0);

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

// Фразы, которые НЕ являются бронями (служебная инфо в чате текущего дня).
// Если найдено — возвращаем null (молча игнорируем), чтобы не ругаться.
const SERVICEWORDS = [
  "мест нет", "мест нет.", "все места", "нет мест", "полная посадка",
  "время", "сотрудник", "сотрудники", "выход", "приход", "бригада", "смена",
  "админ", "менеджер", "официант", "бармен", "повар", "кухня", "тех",
  "стоп", "перерыв", "открыто", "закрыто", "спасибо", "добрый",
];

function isService(s) {
  const low = s.toLowerCase();
  return SERVICEWORDS.some(w => low.includes(w.toLowerCase()));
}

// Текущая дата (Москва) в формате ДД.ММ для чата текущего дня
function todayMsk() {
  const d = new Date(Date.now() + 3 * 3600 * 1000); // UTC+3
  const p = n => String(n).padStart(2, "0");
  return p(d.getUTCDate()) + "." + p(d.getUTCMonth() + 1);
}

// Лучшее приближение к дате: указанная в тексте или текущая (для чата текущего дня).
function extractDate(s, chatId) {
  const m = s.match(/\b(\d{1,2})\.(\d{1,2})\b/);
  if (m) {
    const d = m[1], mo = m[2];
    let y = 2026;
    if (Number(mo) <= 2) y = 2027;
    return { date: d + "." + mo, isoDay: `${y}-${String(Number(mo)).padStart(2,"0")}-${String(Number(d)).padStart(2,"0")}` };
  }
  // Чат текущего дня — берём сегодняшнюю дату (Москва)
  if (chatId === CHAT_CURRENT_ID) {
    const t = todayMsk();
    const [d, mo] = t.split(".").map(Number);
    let y = 2026;
    if (mo <= 2) y = 2027;
    return { date: t, isoDay: `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}` };
  }
  return null;
}

function extractTime(s) {
  // Время — только через двоеточие (HH:MM), чтобы не спутать с датой 22.11
  const m = s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return pad2(h) + ":" + pad2(mi);
}
function pad2(n){ return String(n).padStart(2,"0"); }

function extractGuests(s) {
  // Сначала ищем «N чел / человек / персон / гостей»
  let m = s.match(/\b(\d{1,3})\s*(?:чел|человека?|человек|персон|гост)/i);
  if (m) { const n = Number(m[1]); return n > 0 ? n : null; }
  // Если нет явного слова — берём последнее обособленное число, НЕ похожее на дату(дд.мм) и НЕ часть времени.
  // Убираем время HH:MM и даты, затем ищем оставшееся число.
  const cleaned = s.replace(/\b\d{1,2}:\d{2}\b/g, " ").replace(/\b\d{1,2}\.\d{1,2}\b/g, " ");
  const nums = cleaned.match(/\d{1,3}/g);
  if (nums && nums.length) {
    const n = Number(nums[nums.length - 1]);
    return n > 0 && n < 400 ? n : null;
  }
  return null;
}

function extractName(s) {
  // Имя обычно идёт не первым (до него время/кол-во могут стоять в другом порядке).
  // Нормализуем: убираем дату/время/кол-во/служебные слова, остаток — имя.
  let t = s.replace(/\b\d{1,2}\.\d{1,2}\b/g, " ")                      // дата
           .replace(/\b\d{1,2}[:\.]\d{2}\b/g, " ")                     // время
           .replace(/\d{1,3}\s*(?:чел|человек|человека|персон|гр|г)\b/gi, " ") // кол-во
           .replace(/\b(?:бронь|брони|бронь на|запись|забронировать|на|в)\b/gi, " ")
           .replace(/\s+/g, " ").trim();
  // Имя — одно-два слова с заглавной (кириллица/латиница/дефис)
  const m = t.match(/([А-ЯЁA-Z][а-яёa-zA-Z\-]+(?:[\s\-][А-ЯЁA-Z][а-яёa-zA-Z\-]+)?)/);
  return m ? m[1] : null;
}

function fmtSlot(slot) {
  return (slot.slice(0, 10) + " " + slot.slice(11, 16));
}

async function handleMessage(txt, chatId) {
  const s = (txt || "").trim();
  if (!s) return null;
  // Служебная информация в чате текущего дня — молча игнорируем (вернём null)
  if (isService(s)) return null;

  const dateInfo = extractDate(s, chatId);
  const time = extractTime(s);
  if (!dateInfo || !time) {
    return "Не понял. Пример:\nбудущий чат: «бронь Марина 22.11 16:00 2 чел»\nтекущий день: «Марина 16:00 2 чел»\nперенос: «перенеси Марина 22.11 16:00 на 18:00»";
  }
  const name = extractName(s);
  const guests = extractGuests(s);

  const day = slotDay(dateInfo.date);
  const row = await rpc("get_reservations", { p_from: day, p_to: dayNext(day) });

  // ===== ОТМЕНА =====
  if (/удали|отмени|сними|убрать/.test(s)) {
    const atSlot = row.filter(r => r.slot === parseSlot(dateInfo.date, time));
    if (!atSlot.length) return "На " + fmtSlot(parseSlot(dateInfo.date, time)) + " броней нет.";
    const tgt = (name && atSlot.find(r => r.name && r.name.toLowerCase().includes(name.toLowerCase())))
      || atSlot[0];
    await rpc("delete_reservation", { p_data: { id: tgt.id, source: "bot" } });
    return "Удалено: " + tgt.name + " · " + fmtSlot(parseSlot(dateInfo.date, time));
  }

  // ===== ПЕРЕНОС времени =====
  const isMove = /перенес|переведи|перевес|смени|сменить|перестав|\bна\b.*\bна\b/i.test(s);
  const times = [...s.matchAll(/\b(\d{1,2}):(\d{2})\b/g)];
  if (isMove && times.length >= 2) {
    const newSlot = parseSlot(dateInfo.date, pad2(Number(times[times.length-1][1])) + ":" + pad2(Number(times[times.length-1][2])));
    // старое время — первое (или исходное из extractTime)
    const oldSlot = parseSlot(dateInfo.date, time);
    if (!name) return "Укажите имя брони для переноса. Пример: «перенеси Марина 22.11 16:00 на 18:00»";
    const target = row.find(r => name && r.name && (r.name.toLowerCase().includes(name.toLowerCase())) && r.slot === oldSlot)
      || row.find(r => name && r.name && r.name.toLowerCase() === name.toLowerCase());
    if (!target) return "Не нашёл бронь «" + name + "» на " + fmtSlot(oldSlot);
    await rpc("update_reservation", {
      p_data: { id: target.id, slot: newSlot, source: "bot" }
    });
    return "Перенесено: " + target.name + " с " + fmtSlot(oldSlot) + " на " + fmtSlot(newSlot);
  }

  // ===== ИЗМЕНЕНИЕ / ДУБЛЬ существующей брони =====
  // Если на слоте+имени уже есть бронь — либо дубль, либо изменение атрибутов.
  const existingAt = row.find(r => r.name && name && r.name.toLowerCase() === name.toLowerCase() && r.slot === parseSlot(dateInfo.date, time));
  if (existingAt) {
    const updates = {};
    let any = false;
    // Кол-во человека меняем только если реально отличается (иначе это дубль)
    if (guests !== null && guests !== existingAt.guests) { updates.guests = guests; any = true; }
    const depSum = s.match(/\b(\d{3,})(?:\s*(?:руб|₽))?/i);
    if (/предоплат|внес|оплатил/i.test(s) && depSum) {
      updates.deposit = true;
      updates.deposit_sum = Number(depSum[1]);
      const method = s.match(/(карта\s*лв|терминал|наличны)/i);
      updates.deposit_method = method ? method[1].toLowerCase() : null;
      any = true;
    }
    // количество: уже в updates если guests
    if (any) {
      await rpc("update_reservation", { p_data: { id: existingAt.id, ...updates, source: "bot" } });
      return "Обновлено: " + existingAt.name + " · " + fmtSlot(parseSlot(dateInfo.date, time)) +
             (updates.guests ? " · гостей: " + updates.guests : "") +
             (updates.deposit ? " · предоплата внесена: " + updates.deposit_sum + (updates.deposit_method ? " " + updates.deposit_method : "") : "");
    }
    // Ничего изменяемого нет — считаем дублем
    return "Уже есть: " + existingAt.name + " в " + fmtSlot(parseSlot(dateInfo.date, time)) + " (не дублирую).";
  }

  if (!name) return "Не нашёл имя. Пример: «бронь Марина 22.11 16:00 2 чел»";

  // ===== СОЗДАНИЕ новой брони =====
  await rpc("create_reservation", {
    p_data: { slot: parseSlot(dateInfo.date, time), name, guests: guests || 2, no_booking: false, preorder: false, deposit: false, source: "bot" }
  });
  return "Добавлено: " + name + ", " + (guests || 2) + " чел., " + fmtSlot(parseSlot(dateInfo.date, time));
}

function slotDay(dateDot) {
  const [d, mo] = dateDot.split(".").map(Number);
  let y = 2026; if (mo <= 2) y = 2027;
  return `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}T00:00:00+03:00`;
}
function dayNext(day) {
  const d = new Date(day);
  d.setDate(d.getDate() + 1);
  const p = n => String(n).padStart(2,"0");
  return d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate()) + "T00:00:00+03:00";
}

async function main() {
  if (!TOKEN) { console.error("Задайте BOT_INCOMING_TOKEN в .env"); process.exit(1); }
  console.log("Бот-приёмник запущен (polling). Выход — Ctrl+C");
  console.log("Подсказка: напишите боту /id из чата → он вернёт id этого чата.");
  let offset = 0;
  while (true) {
    let updates;
    try {
      updates = await tg("getUpdates", { offset, timeout: 30 });
    } catch (e) {
      console.error("getUpdates error:", e.message);
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      if (!u.message || !u.message.text) continue;
      const chatId = u.message.chat.id;
      try {
        const txt = u.message.text.trim();
        // Команда /id — вернуть id текущего чата (для настройки CHAT_CURRENT_ID / CHAT_FUTURE_ID)
        if (/^\/id\b/i.test(txt) || /^id чата/i.test(txt)) {
          await tg("sendMessage", { chat_id: chatId, text: "ID этого чата: " + chatId });
          continue;
        }
        const reply = await handleMessage(u.message.text, chatId);
        if (reply) await tg("sendMessage", { chat_id: chatId, text: reply });
        // если reply === null — служебное, молчим
      } catch (e) {
        console.error("handle err:", e.message);
        await tg("sendMessage", { chat_id: chatId, text: "Ошибка: " + e.message }).catch(()=>{});
      }
    }
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { handleMessage };