// Бот-приёмник: читает сообщения из чатов, понимает намерение,
// сверяет с существующей базой и вносит изменения (без дублей).
//
// Два чата (по chat_id из .env):
//   CHAT_FUTURE_ID  — чат броней на будущие даты (в сообщениях есть дата)
//   CHAT_CURRENT_ID — чат броней на текущую дату (без даты) + служебная инфо
//
// Запуск:  node bot-incoming.cjs
const { rpc, getChangeLog, parseSlot } = require("./bots.common.cjs");
const { parseFullList } = require("./full-list.cjs");

const TOKEN = process.env.BOT_INCOMING_TOKEN || "";
const API = "https://api.telegram.org/bot" + TOKEN;
const CHAT_FUTURE_ID = Number(process.env.CHAT_FUTURE_ID || 0);
const CHAT_CURRENT_ID = Number(process.env.CHAT_CURRENT_ID || 0);
// Служебный лог-чат: сюда бот пишет результаты броней (Добавлено/Уже есть/Обновлено/Удалено/Ошибка),
// чтобы в реальных чатах с гостями не было служебной переписки.
const CHAT_LOG_ID = Number(process.env.CHAT_LOG_ID || 0);
const fs = require("fs");
const OFFSET_FILE = __dirname + "/.bot-incoming.offset";

function loadOffset() {
  try { return Number(fs.readFileSync(OFFSET_FILE, "utf8")) || 0; }
  catch (e) { return 0; }
}
function saveOffset(v) {
  try { fs.writeFileSync(OFFSET_FILE, String(v)); } catch (e) { /* не критично */ }
}

// Отправить служебное сообщение: в лог-чат (если задан) либо в чат, откуда пришло сообщение.
// В реальные чаты с гостями (когда CHAT_LOG_ID настроен) служебная переписка не попадает.
async function sendLog(text, fallbackChatId) {
  const target = CHAT_LOG_ID || fallbackChatId;
  if (!target) return;
  console.log("sendLog -> " + target + ": " + text.split("\n")[0]);
  await tg("sendMessage", { chat_id: target, text }).catch((e) => console.log("sendLog ERR " + e.message));
}

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

// Детектор «списка прихода/графика сотрудников»: много строк вида «Имя ЧЧ:ММ» подряд.
// Бронь — это обычно 1-2 имени; если в тексте ≥4 строк с временем, это приход, а не броня.
function isStaffArrival(s) {
  const lines = s.split(/\n+/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  const timeLines = lines.filter(l => /\b\d{1,2}:\d{2}\b/.test(l) && /[А-ЯЁA-Z]/.test(l));
  // Все строки текста должны быть «имя + время» (без дат, без спецлиний списка броней)
  const allTimes = timeLines.length === lines.length;
  if (!allTimes) return false;
  // Исключаем явные списочные конструкции броней (заголовки дат, спецсимволы блокировки)
  const hasSpecial = /🔳|🔵|❌|ДЕКАБРЬ|ЯНВАРЬ|ДЕК |ЯНВ |ПРЕДЗАКАЗ|ОБЩАЯ|СТОЛ|ОСТАЛОСЬ|такая бронь|бронь на/i.test(s);
  if (hasSpecial) return false;
  return true;
}

// Текущая дата (Москва) в формате ДД.ММ для чата текущего дня
function todayMsk() {
  const d = new Date(Date.now() + 3 * 3600 * 1000); // UTC+3
  const p = n => String(n).padStart(2, "0");
  return p(d.getUTCDate()) + "." + p(d.getUTCMonth() + 1);
}

// Лучшее приближение к дате: указанная в тексте или текущая (для чата текущего дня).
const MONTHWORD = { "января":1,"февраля":2,"марта":3,"апреля":4,"мая":5,"июня":6,"июля":7,"августа":8,"сентября":9,"октября":10,"ноября":11,"декабря":12,
  "январь":1,"февраль":2,"март":3,"апрель":4,"май":5,"июнь":6,"июль":7,"август":8,"сентябрь":9,"октябрь":10,"ноябрь":11,"декабрь":12 };
function extractDate(s, chatId) {
  const low = s.toLowerCase();
  // «11 ДЕКАБРЯ» / «11 декабря» — месяц словом.
  // Без /u символ \b не считает кириллицу словом, поэтому нужны явные анкоры.
  const mm = low.match(/(?:^|[^0-9])(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|январь|февраль|март|апрель|май|июнь|июль|август|сентябрь|октябрь|ноябрь|декабрь)(?![а-яёa-z0-9])/);
  if (mm) {
    const d = Number(mm[1]), mo = MONTHWORD[mm[2]];
    if (d >= 1 && d <= 31) {
      let y = 2026; if (mo <= 2) y = 2027;
      const dd = String(d).padStart(2,"0"), m2 = String(mo).padStart(2,"0");
      return { date: dd + "." + m2, isoDay: `${y}-${m2}-${dd}` };
    }
  }
  // «11.12» — число.месяц
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
  // «9 взрослых + 7 детей» / «5+5 реб» — считаем сумму
  let msum = s.match(/(\d{1,3})\s*(?:взросл[а-яё]*|взр[а-яё]*|чел[а-яё]*)\s*\+\s*(\d{1,3})\s*(?:дет[а-яё]*|реб[а-яё]*|чел[а-яё]*)/i) ||
             s.match(/(\d{1,3})\s*\+\s*(\d{1,3})\s*(?:дет[а-яё]*|реб[а-яё]*)/i);
  if (msum) { const n = Number(msum[1]) + Number(msum[2]); return n > 0 ? n : null; }
  // Сначала ищем «N чел / человек / персон / гостей»
  let m = s.match(/(?:^|[^0-9])(\d{1,3})\s*(?:чел|человека?|человек|персон|гостей?|гостя?)(?![а-яёa-z0-9])/i);
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

// Слова, означающие место/стол/зал в ресторане — никогда не имена гостей.
// «40 стол», «50 зал», «стол накрыть» — это номер места или пометка, а не имя.
// Если парсер принял одно из них за имя — отбрасываем и продолжаем поиск.
const PLACE_WORDS = ["стол", "столик", "зал", "залб", "окно", "веранда", "мезонин", "кабинет", "балкон", "бар"];

function isPlaceWord(w) {
  const low = (w || "").toLowerCase().replace(/\s+/g, " ").trim();
  return PLACE_WORDS.includes(low);
}

function extractName(s) {
  // Имя обычно идёт не первым (до него время/кол-во могут стоять в другом порядке).
  // Нормализуем: убираем дату/время/кол-во/служебные слова, остаток — имя.
  let t = s.replace(/\b\d{1,2}\.\d{1,2}\b/g, " ")                      // дата
           .replace(/\b\d{1,2}[:\.]\d{2}\b/g, " ")                     // время
           .replace(/\d{1,3}\s*[,]\s*\d{1,3}\s*(?:чел|человек|персон|гост)\w*/gi, " ")
           .replace(/(?:^|\s)\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?=\s|$)/gi, " ") // дата словом: «31 декабря»
           .replace(/\d{1,3}\s*(?:человека|человек|персон|чел|гр|г)\s*/gi, " ") // кол-во
           .replace(/(?:^|\s)(?:бронь|брони|бронь\s+на|запись|забронировать|перенес[а-яё]*|переведи|перевес|смени|сменить|перестав)\s+(?=[А-ЯЁA-Zа-яёa-z])/gi, " ")
           .replace(/(?:^|\s)(?:отмен[а-яё]*|удали[а-яё]*|сними[а-яё]*|убери[а-яё]*|убрать[а-яё]*)(?=\s|$)/gi, " ")
           .replace(/(?:^|\s)(?:стол|столик|зал|окно|веранда|мезонин|кабинет|балкон|бар)(?=\s|$)/gi, " ") // слова-места не имя
           .replace(/\s+/g, " ").trim();
  // Собираем все слова-кандидаты, отбрасываем стоп-слова (место, команды).
  // Предпочитаем заглавное слово-имя (личное), а служебные пропускаем.
  const tokens = t.split(/[\s\/]+/).filter(Boolean);
  let fallback = null;
  for (const w of tokens) {
    const low = w.toLowerCase();
    if (PLACE_WORDS.includes(low)) continue;                 // стол/зал/окно — не имя
    if (/^(?:бронь|брони|запись|забронировать|на|в|отмен|удали|сними|убери|убрать|перенес|переведи|смени|перестав)$/.test(low)) continue; // команды
    if (/^[\d+\-₽.,]+$/.test(w)) continue;                    // числа/суммы
    // Имя личное — с заглавной буквы, берём первое такое
    if (/^[А-ЯЁA-Z]/.test(w) && /[а-яёa-z]/i.test(w)) return w;
    if (!fallback) fallback = w;                              // строчное — как запасной вариант
  }
  return fallback;
}

function fmtSlot(slot) {
  // Слот из базы Supabase приходит в UTC (…14:00+00:00), а parseSlot строит +03:00 (17:00+03:00).
  // Всегда показываем время по Москве (+03:00), чтобы «Удалено/Обновлено/Перенесено»
  // отображали то же время, что видел пользователь при создании.
  const d = new Date(slot);
  if (Number.isNaN(d.getTime())) return slot;
  const msk = new Date(d.getTime() + 3 * 3600 * 1000);
  const p = n => String(n).padStart(2, "0");
  return msk.getUTCFullYear() + "-" + p(msk.getUTCMonth() + 1) + "-" + p(msk.getUTCDate()) + " " +
    p(msk.getUTCHours()) + ":" + p(msk.getUTCMinutes());
}

// Сравнить два слота по моменту времени (не по строке!): Supabase возвращает slot в UTC,
// а parseSlot у нас строит +03:00, поэтому строчное сравнение ложно даёт «не совпадает».
function sameSlot(a, b) {
  if (!a || !b) return false;
  const ta = new Date(a).getTime(), tb = new Date(b).getTime();
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

// Дата для разобранного слота: из заголовка месяца/даты или сегодня (чат текущего дня).
function dateFromSlot(sl, chatId) {
  if (sl.date && sl.date.d) {
    const y = sl.date.y || (sl.date.mo <= 2 ? 2027 : 2026);
    const isoDay = `${y}-${String(sl.date.mo).padStart(2,"0")}-${String(sl.date.d).padStart(2,"0")}`;
    return { date: `${String(sl.date.d).padStart(2,"0")}.${String(sl.date.mo).padStart(2,"0")}`, isoDay };
  }
  if (chatId === CHAT_CURRENT_ID) {
    const t = todayMsk(); const [d, mo] = t.split(".").map(Number);
    let y = 2026; if (mo <= 2) y = 2027;
    return { date: t, isoDay: `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}` };
  }
  return null;
}

// Режим «полный список броней»: разобрать весь список, внести ТОЛЬКО новые брони
// (сверка по слоту дата+время + имени), существующие не трогать, дубли не создавать.
async function handleFullList(slots, chatId) {
  // Группируем слоты по дате, чтобы загрузить существующие брони одним запросом на день.
  const groups = new Map();
  for (const sl of slots) {
    if (!sl.name) continue; // блокировка/пустая ячейка без имени — не создаём
    const dateInfo = dateFromSlot(sl, chatId);
    if (!dateInfo) continue;
    const key = dateInfo.isoDay;
    if (!groups.has(key)) groups.set(key, { dateInfo, items: [] });
    groups.get(key).items.push(sl);
  }
  let added = 0, skipped = 0;
  const reports = [];
  for (const { dateInfo, items } of groups.values()) {
    const day = slotDay(dateInfo.date);
    const row = await rpc("get_reservations", { p_from: day, p_to: dayNext(day) });
    for (const sl of items) {
      const slotStr = parseSlot(dateInfo.date, sl.slot);
      const exists = row.some(r =>
        sameSlot(r.slot, slotStr) && r.name && sl.name &&
        r.name.trim().toLowerCase() === sl.name.trim().toLowerCase());
      if (exists) { skipped++; continue; }
      await rpc("create_reservation", {
        p_data: {
          slot: slotStr, name: sl.name, guests: sl.guests || 2,
          phone: sl.phone || null, comment: sl.comment || null,
          preorder: !!sl.preorder,
          total_sum: sl.total_sum != null ? String(sl.total_sum) : null,
          deposit: sl.deposit_sum != null,
          deposit_sum: sl.deposit_sum != null ? String(sl.deposit_sum) : null,
          deposit_method: sl.deposit_method || null,
          cake: sl.cake || null,
          no_booking: !!sl.no_booking,
          source: "bot"
        }
      });
      added++;
      reports.push("+ " + sl.name + " · " + fmtSlot(slotStr) + " · " + (sl.guests || 2) + " чел");
    }
  }
  if (added === 0) {
    return "Разобрал полный список: новых броней нет (все уже есть в базе)" +
      (skipped ? " — совпало по слоту+имени: " + skipped + "." : ".");
  }
  return "Внёс из списка новых броней: " + added +
    (skipped ? ", уже есть (пропущено): " + skipped : "") +
    (reports.length ? "\n" + reports.join("\n") : "");
}

async function handleMessage(txt, chatId) {
  const s = (txt || "").trim();
  if (!s) return null;
  // Режим «полный список»: если разобралось ≥2 слотов — обрабатываем как список целиком.
  // Проверка ДО isService: в списке есть служебные строки («время», «стоп»), их нельзя
  // принимать за маркер «молчать».
  const fullSlots = parseFullList(s);
  if (fullSlots.length >= 2) {
    return await handleFullList(fullSlots, chatId);
  }
  // Список прихода сотрудников (много строк «Имя ЧЧ:ММ») — молча игнорируем.
  if (isStaffArrival(s)) return null;
  // Служебная информация в чате текущего дня — молча игнорируем (вернём null)
  if (isService(s)) return null;

  const dateInfo = extractDate(s, chatId);
  const time = extractTime(s);
  const name = extractName(s);
  const guests = extractGuests(s);

  // ===== ОТМЕНА (время необязательно: если имя единственное на дату) =====
  if (/удал|отмен|сними|убрать|cancel/i.test(s)) {
    if (!dateInfo) return "Укажите дату для отмены. Пример: «отмени Марина 22.11 16:00»";
    const day = slotDay(dateInfo.date);
    const row = await rpc("get_reservations", { p_from: day, p_to: dayNext(day) });
    if (!name) return "Укажите имя брони для отмены.";
    const byName = row.filter(r => r.name && r.name.toLowerCase().includes(name.toLowerCase()));
    if (!byName.length) return "На " + dateInfo.date + " бронь «" + name + "» не найдена.";
    let tgt;
    if (time) {
      const sp = parseSlot(dateInfo.date, time);
      tgt = byName.find(r => sameSlot(r.slot, sp)) || byName[0];
    } else {
      if (byName.length > 1) {
        return "Бронь «" + name + "» на " + dateInfo.date + " есть в нескольких временах: " +
          byName.map(r => fmtSlot(r.slot).slice(11)).join(", ") + ". Укажите время.";
      }
      tgt = byName[0];
    }
    await rpc("delete_reservation", { p_data: { id: tgt.id, source: "bot" } });
    return "Удалено: " + tgt.name + " · " + fmtSlot(tgt.slot);
  }

  if (!dateInfo || !time) {
    return "Не понял. Пример:\nбудущий чат: «бронь Марина 22.11 16:00 2 чел»\nтекущий день: «Марина 16:00 2 чел»\nперенос: «перенеси Марина 22.11 16:00 на 18:00»";
  }

  const day = slotDay(dateInfo.date);
  const pfrom = day, pto = dayNext(day);
  const row = await rpc("get_reservations", { p_from: pfrom, p_to: pto });

  // ===== ПЕРЕНОС времени =====
  const isMove = /перенес|переведи|перевес|смени|сменить|перестав|\bна\b.*\bна\b/i.test(s);
  const times = [...s.matchAll(/\b(\d{1,2}):(\d{2})\b/g)];
  if (isMove && times.length >= 2) {
    const newSlot = parseSlot(dateInfo.date, pad2(Number(times[times.length-1][1])) + ":" + pad2(Number(times[times.length-1][2])));
    // старое время — первое (или исходное из extractTime)
    const oldSlot = parseSlot(dateInfo.date, time);
    if (!name) return "Укажите имя брони для переноса. Пример: «перенеси Марина 22.11 16:00 на 18:00»";
    const target = row.find(r => name && r.name && (r.name.toLowerCase().includes(name.toLowerCase())) && sameSlot(r.slot, oldSlot))
      || row.find(r => name && r.name && r.name.toLowerCase() === name.toLowerCase());
    if (!target) return "Не нашёл бронь «" + name + "» на " + fmtSlot(oldSlot);
    await rpc("update_reservation", {
      p_data: { id: target.id, slot: newSlot, source: "bot" }
    });
    return "Перенесено: " + target.name + " с " + fmtSlot(oldSlot) + " на " + fmtSlot(newSlot);
  }

  // ===== ИЗМЕНЕНИЕ / ДУБЛЬ существующей брони =====
  // Если на слоте+имени уже есть бронь — либо дубль, либо изменение атрибутов.
  const sameSlotP = parseSlot(dateInfo.date, time);
  const existingAt = row.find(r => sameSlot(r.slot, sameSlotP) && r.name && name && r.name.toLowerCase() === name.toLowerCase());
  if (existingAt) {
    const ps = parseFullList(s);
    const sl = ps.length === 1 ? ps[0] : null;
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
    // Расширенные атрибуты из списочного формата (если есть)
    if (sl) {
      const rich = {
        phone: sl.phone || null,
        comment: sl.comment || null,
        preorder: !!sl.preorder,
        total_sum: sl.total_sum != null ? String(sl.total_sum) : null,
        deposit_sum: sl.deposit_sum != null ? String(sl.deposit_sum) : null,
        deposit_method: sl.deposit_method || null,
        cake: sl.cake || null
      };
      // применяем только те, что реально изменились
      for (const k of Object.keys(rich)) {
        const v = rich[k];
        const cur = existingAt[k] == null ? null : String(existingAt[k]);
        if (String((v == null ? "" : v)) !== (cur == null ? "" : cur)) {
          updates[k] = v; any = true;
        }
      }
      if (sl.deposit_sum != null) updates.deposit = true;
      else if (sl.preorder && sl.deposit_sum == null) updates.deposit = false;
    }
    if (any) {
      await rpc("update_reservation", { p_data: { id: existingAt.id, ...updates, source: "bot" } });
      return "Обновлено: " + existingAt.name + " · " + fmtSlot(parseSlot(dateInfo.date, time)) +
             (updates.guests ? " · гостей: " + updates.guests : "") +
             (updates.deposit ? " · предоплата внесена: " + updates.deposit_sum + (updates.deposit_method ? " " + updates.deposit_method : "") : "") +
             (updates.comment ? " · комм." : "");
    }
    // Ничего изменяемого нет — считаем дублем
    return "Уже есть: " + existingAt.name + " в " + fmtSlot(parseSlot(dateInfo.date, time)) + " (не дублирую).";
  }

  if (!name) return "Не нашёл имя. Пример: «бронь Марина 22.11 16:00 2 чел»";

  // ===== СБОР АТРИБУТОВ =====
  // Если текст — одна броня в «списочном» формате, берём расширенные атрибуты
  // из полного парсера (телефон, предзаказ, суммы, торт, комментарий).
  const ps = parseFullList(s);
  const sl = ps.length === 1 ? ps[0] : null;
  // Имя из полного парсера (slotName) распознаёт «Имя / N чел» и слэш-паттерн
  // надёжнее, чем extractName(s) по всей строке. Если оно есть и не слово-место,
  // берём его; иначе оставляем из extractName.
  if (sl && sl.name && !isPlaceWord(sl.name)) name = sl.name;
  const slotStr = parseSlot(dateInfo.date, time);
  const phoneFromMsg = (sl && sl.phone) || null;
  const attrs = {
    phone: phoneFromMsg,
    comment: (sl && sl.comment) || null,
    preorder: !!(sl && sl.preorder),
    total_sum: (sl && sl.total_sum != null) ? String(sl.total_sum) : null,
    deposit: !!(sl && sl.deposit_sum != null),
    deposit_sum: (sl && sl.deposit_sum != null) ? String(sl.deposit_sum) : null,
    deposit_method: (sl && sl.deposit_method) || null,
    cake: (sl && sl.cake) || null
  };

  // ===== ДУБЛЬ ПО ТЕЛЕФОНУ на слоте (запасной ключ) =====
  // Если имя распозналось неточно, но на том же слоте уже есть бронь с тем же
  // номером телефона — это то же бронирование (гость уточнил детали), а не новая
  // запись. Обновляем существующую, а не создаём дубль.
  if (phoneFromMsg) {
    const normPh = phoneFromMsg.replace(/\D/g, "");
    const byPhone = row.find(r => sameSlot(r.slot, slotStr) && r.phone &&
      String(r.phone).replace(/\D/g, "") === normPh && normPh.length >= 6);
    if (byPhone && (!existingAt || byPhone.id !== existingAt.id)) {
      // объединяем атрибуты сообщения с тем, что уже есть
      const updates = {};
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        const cur = byPhone[k] == null ? null : String(byPhone[k]);
        if (String((v == null ? "" : v)) !== (cur == null ? "" : cur)) updates[k] = v;
      }
      if (guests !== null && guests !== byPhone.guests) updates.guests = guests;
      if (sl && sl.deposit_sum != null) updates.deposit = true;
      if (Object.keys(updates).length) {
        await rpc("update_reservation", { p_data: { id: byPhone.id, ...updates, source: "bot" } });
        return "Обновлено (по телефону): " + byPhone.name + " · " + fmtSlot(slotStr) +
          (updates.comment ? " · комм." : "");
      }
      // ничего менять не нужно — это дубль того же телефона
      return "Уже есть (тот же телефон): " + byPhone.name + " в " + fmtSlot(slotStr) + " (не дублирую).";
    }
  }

  // ===== СОЗДАНИЕ новой брони =====
  await rpc("create_reservation", {
    p_data: { slot: slotStr, name, guests: guests || 2, no_booking: false, source: "bot", ...attrs }
  });
  return "Добавлено: " + name + ", " + (guests || 2) + " чел., " + fmtSlot(slotStr) +
    (attrs.comment ? "\nКомментарий: " + attrs.comment : "");
}

function slotDay(dateDot) {
  const [d, mo] = dateDot.split(".").map(Number);
  let y = 2026; if (mo <= 2) y = 2027;
  return `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}T00:00:00+03:00`;
}
function dayNext(day) {
  // Инкремент календарной даты, устойчивый к часовому поясу сервера.
  // Извлекаем Y-M-D из строки (например 2026-11-24T00:00:00+03:00) и сдвигаем как календарную дату.
  const m = String(day).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) { const d0 = new Date(day); return d0.toISOString().slice(0, 10) + "T00:00:00+03:00"; }
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  const p = n => String(n).padStart(2,"0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth()+1) + "-" + p(d.getUTCDate()) + "T00:00:00+03:00";
}

async function main() {
  if (!TOKEN) { console.error("Задайте BOT_INCOMING_TOKEN в .env"); process.exit(1); }
  const { SUPABASE_URL } = require("./bots.common.cjs");
  console.log("STARTUP db=" + (SUPABASE_URL || "(пусто)") + " chatLog=" + CHAT_LOG_ID);
  console.log("Бот-приёмник запущен (polling). Выход — Ctrl+C");
  console.log("Подсказка: напишите боту /id из чата → он вернёт id этого чата.");
  // offset персистентный: переживает перезапуск Render, иначе бот заново
  // читает всю очередь getUpdates и плодит дубли.
  let offset = loadOffset();
  console.log("offset старта:", offset);
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
      // фиксируем прогресс ДО обработки, чтобы даже при сбое не повторять
      offset = u.update_id + 1;
      saveOffset(offset);
      if (!u.message || !u.message.text) continue;
      const chatId = u.message.chat.id;
      try {
        const txt = u.message.text.trim();
        // Команда /id — вернуть id текущего чата (для настройки CHAT_CURRENT_ID / CHAT_FUTURE_ID).
        // Отвечаем в исходный чат — иначе смысл команды теряется.
        if (/^\/id\b/i.test(txt) || /^id чата/i.test(txt)) {
          await tg("sendMessage", { chat_id: chatId, text: "ID этого чата: " + chatId });
          continue;
        }
        const reply = await handleMessage(u.message.text, chatId);
        // Все служебные результаты (Добавлено/Уже есть/Обновлено/Удалено/Ошибка) шлём в лог-чат,
        // а в реальные чаты с гостями не пишем ничего. Пока CHAT_LOG_ID не задан — отвечаем в исходный чат.
        if (reply) {
          let out = reply;
          // Для «Не понял» добавляем текст исходного сообщения, чтобы в лог-чате было видно,
          // какое именно сообщение бот не разобрал.
          if (/^Не понял/.test(reply)) {
            out = "⁉️ Не понял:\n" + (u.message.text || "") + "\n\n—\n" + reply;
          }
          await sendLog(out, chatId);
        }
        // если reply === null — служебное, молчим
      } catch (e) {
        console.error("handle err:", e.message);
        await sendLog("Ошибка: " + e.message, chatId);
      }
    }
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { handleMessage };