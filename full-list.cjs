// Парсер ПОЛНОГО списка броней на день/дни.
// Разбирает многострочное сообщение, где каждый слот начинается с времени,
// а следующие строки — детали брони. Возвращает массив "сырых" слотов с атрибутами.
// Чистая функция (без сети), чтобы её можно было тестировать.

const MONTHS = { "января":1,"февраля":2,"марта":3,"апреля":4,"мая":5,"июня":6,"июля":7,"августа":8,"сентября":9,"октября":10,"ноября":11,"декабря":12,
  "январь":1,"февраль":2,"март":3,"апрель":4,"май":5,"июнь":6,"июль":7,"август":8,"сентябрь":9,"октябрь":10,"ноябрь":11,"декабрь":12 };

// Год по месяцу (ноябрь/декабрь 2026; январь/февраль 2027)
function yearForMonth(mo) { return (mo <= 2) ? 2027 : 2026; }

// Убрать эмодзи-глифы в начале строки
function stripGlyphs(s) { return s.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}🔳🟪🔵🎂🌲🏡❌✅‼️❓⚪️🟢❔\s]+/u, ""); }

function isMonthHeader(line) {
  const low = line.toLowerCase();
  for (const m of Object.keys(MONTHS)) if (low.includes(m)) return true;
  return false;
}

function parseMonthHeader(line) {
  const low = line.toLowerCase();
  let mo = null, day = null;
  for (const m of Object.keys(MONTHS)) if (low.includes(m)) { mo = MONTHS[m]; break; }
  const dm = line.match(/\b(\d{1,2})\b/);
  if (dm) day = Number(dm[1]);
  return mo ? { day, mo, year: mo ? yearForMonth(mo) : 0 } : null;
}

function isSlotLine(line) {
  if (!/^\d{1,2}[:;]?\d{2}/.test(stripGlyphs(line).trim())) return false;
  // Должно быть валидным временем (часы 0-23), иначе «2500 /Дарья/...» не станет слотом.
  const t = parseSlotTime(stripGlyphs(line).trim());
  return t != null;
}

function parseSlotTime(line) {
  const m = stripGlyphs(line).match(/^\s*(\d{1,2})[:;](\d{2})/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return pad2(h) + ":" + pad2(mi);
}
function pad2(n){ return String(n).padStart(2,"0"); }

// Является ли строка блокировкой «НЕ БРОНИРОВАТЬ» (❌ сразу после времени, либо строка с ❌/Стоп)
function isNoBookingSlot(line) {
  const s = stripGlyphs(line).trim();
  return /❌/.test(s) || /стоп/i.test(s);
}

// Телефон
function extractPhone(s) { const m = s.match(/\+?[\d\-\s]{7,}\d/); return m ? m[0].trim() : null; }

// Кол-во человек
function extractGuests(s) {
  // Сначала ищем «N чел / человек / персон / гостей» (самый надёжный).
  // Без флага /u символ \b не считает кириллицу словом, поэтому используем
  // явные анкоры (?:^|[^0-9]) и (?!...), чтобы не цеплять «101 мессенджер».
  let m = s.match(/(?:^|[^0-9])(\d{1,3})\s*(?:чел|человека?|человек|персон|гостей?|гостя?)(?![а-яёa-z0-9])/i);
  if (m) { const n = Number(m[1]); return n > 0 ? n : null; }
  // «Имя N» / «Имя N тут» — число стоит после имени
  const mi2 = s.match(/([А-ЯЁA-Z][а-яёa-zA-Z\-]+(?:\s[А-ЯЁA-Z][а-яёa-zA-Z\-]+)?)\s+(\d{1,2})(?![:.])\b/);
  // «число ИМЯ» в начале (например "6 Екатерина", "9 Таисия")
  const mi = s.match(/^\s*(\d{1,3})\s+([А-ЯЁA-Z])/);
  const cand = [];
  if (mi) { const n = Number(mi[1]); if (n > 0 && n <= 60) cand.push(n); }
  if (mi2) { const n = Number(mi2[2]); if (n > 0 && n <= 60) cand.push(n); }
  if (cand.length) return cand[cand.length - 1];
  return null;
}

// Общая сумма
function extractTotal(s) {
  const m = s.match(/ОБЩАЯ\s*[:#№]?\s*(\d[\d\s\u00a0]*)/i);
  return m ? Number(m[1].replace(/[\s\u00a0]/g,"")) : null;
}

// Предоплата: сумма + способ
function extractDeposit(s) {
  const m = s.match(/ПРЕДОПЛАТА\s*[:#№]?\s*(\d[\d\s\u00a0]*)/i);
  if (!m) return null;
  const sum = Number(m[1].replace(/[\s\u00a0]/g,""));
  const low = s.toLowerCase();
  let method = null;
  if (/термин/.test(low)) method = "терминал";
  else if (/налич/.test(low)) method = "наличные";
  else if (/карта\s*лв|лв/.test(low)) method = "карта ЛВ";
  else if (/карт/.test(low)) method = "карта ЛВ";
  return { sum, method };
}

// Имя: часть строки, не являющаяся ни телефоном, ни количеством, ни служебным.
function extractName(s) {
  let t = s.replace(/\b\d{1,3}\s*(?:чел|человека?|человек|персон|гост)\b/gi, " ")
    .replace(/\b\d{1,2}\.\d{1,2}\b/g, " ")
    .replace(/^\s*\d{1,3}\s*/, " ")
    .replace(/\+?[\d\-\s]{7,}\d/g, " ")
    .replace(/\b(?:бронь|брони|запись|на|в|стол|зал|окно)\b/gi, " ")
    .replace(/\s+/g, " ").trim();
  const m = t.match(/([А-ЯЁA-Z][а-яёa-zA-Z\-]+(?:\s[А-ЯЁA-Z][а-яёa-zA-Z\-]+)?)/);
  return m ? m[1] : null;
}

// Извлечь имя из накопленного содержимого слота (строки деталей).
function slotName(detailLines) {
  for (const ln of detailLines) {
    const s = ln.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}🔳🟪🔵🎂🌲🏡❌✅‼️❓⚪️🟢❔\s]+/u, "").trim();
    if (!s) continue;
    if (/предзаказ|общая|предоплат|осталось|торт|стол|зал|окно|мессенджер|чат|меню|мезонин/i.test(s)) continue;
    // «ЧИСЛО /Имя/ N+N реб» / «2500 /Дарья/ 5+5 реб» — имя между слэшами
    const ms = s.match(/\/\s*([А-ЯЁA-Z][а-яёa-zA-Z\-]+(?:[\s\-][А-ЯЁA-Z][а-яёa-zA-Z\-]+)?)\s*\//);
    if (ms) return ms[1];
    // Имя, стоящее перед "/" или с числом после себя
    const m = s.match(/^\s*([А-ЯЁA-Z][а-яёa-zA-Z\-]+(?:[\s\-][А-ЯЁA-Z][а-яёa-zA-Z\-]+)?)\s*(?:\/|\d)/);
    if (m) return m[1];
    const m2 = s.match(/\b([А-ЯЁA-Z][а-яёa-zA-Z\-]+(?:[\s\-][А-ЯЁA-Z][а-яёa-zA-Z\-]+)?)\s+\d+\s*чел/i);
    if (m2) return m2[1];
  }
  const joined = detailLines.join(" ");
  return extractName(joined);
}

// Главная: разобрать полный текст списка.
// Returns: [{ slot: "HH:MM", no_booking, phone, guests, preorder, total_sum, deposit_sum, deposit_method, cake, comment(filtered), name }]
function parseFullList(text) {
  const lines = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const result = [];
  let cur = null;          // текущий разбираемый слот
  let curDate = null;      // текущая дата {year, mo, day} из последнего заголовка
  let skipToSlot = true;   // до первого слота не собираем "хвост"
  let dateMissing = false; // если слот идёт без даты/заголовка

  for (const line of lines) {
    // Заголовок месяца/даты
    if (isMonthHeader(line)) {
      const h = parseMonthHeader(line);
      if (h && h.mo) {
        curDate = { day: h.day, mo: h.mo, year: yearForMonth(h.mo) };
        // начало нового блока — предыдущий слот завершён
        cur = null;
        skipToSlot = true;
      }
      continue;
    }

    // Слот с временем
    if (isSlotLine(line)) {
      const time = parseSlotTime(line);
      if (!time) continue;
      // закрываем предыдущий и дооформляем его имя/кол-во/дату
      if (cur) { finalizeSlot(cur); result.push(cur); }
      cur = { slot: time, no_booking: isNoBookingSlot(line), phone: null, guests: null,
              preorder: false, total_sum: null, deposit_sum: null, deposit_method: null,
              cake: null, comment: "", date: curDate ? { d: curDate.day, mo: curDate.mo, y: curDate.year } : null,
              _detail: [] };
      skipToSlot = false;
      continue;
    }

    // Детали брони (следующие строки до нового слота/заголовка)
    if (skipToSlot || !cur) continue;

    const s = stripGlyphs(line).trim();
    if (!s) continue;
    cur._detail.push(s);

    // НЕ БРОНИРОВАТЬ отдельной строкой
    if (/не бронировать|стоп|❌/.test(s) && !/\d{3,}/.test(s)) { cur.no_booking = true; continue; }

    // телефон
    const phone = extractPhone(s);
    if (phone && /[\d\-\s]{8,}/.test(phone.replace("+",""))) { cur.phone = phone; }

    // предзаказ
    if (/предзаказ/i.test(s)) cur.preorder = true;

    // общая сумма
    const t = extractTotal(s);
    if (t != null) cur.total_sum = t;

    // предоплата
    const d = extractDeposit(s);
    if (d) { cur.deposit_sum = d.sum; cur.deposit_method = d.method; }

    // торт
    if (/торт|мультиторт|наполеон|безе|меринг|медовик|искушение|🍰|🎂|🧁/i.test(s) && !/предзаказ|общая|предоплат|осталось/i.test(s)) {
      const cakeText = s.replace(/^\s*[🎂🧁🍰]+\s*/u, "");
      cur.cake = cur.cake ? cur.cake + "; " + cakeText : cakeText;
      continue;
    }

    // остальное — в комментарий (кроме чисто "осталось опл N")
    if (!/осталось\s+опл/i.test(s)) {
      cur.comment = cur.comment ? cur.comment + "; " + s : s;
    }
  }
  if (cur) { finalizeSlot(cur); result.push(cur); }
  return result;
}

// Оформить слот перед выдачей: имя, кол-во, очистка деталей.
function finalizeSlot(cur) {
  cur.name = slotName(cur._detail || []);
  cur.guests = slotGuests(cur._detail || []);
  delete cur._detail;
}

// Кол-во человек слота из накопленных строк деталей.
function slotGuests(detailLines) {
  for (const ln of detailLines) {
    const s = ln.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}🔳🟪🔵🎂🌲🏡❌✅‼️❓⚪️🟢❔\s]+/u, "").trim();
    // сроки чисто про торт/мессенджер/предоплату/остаток — без гостей
    if (/торт|мессенджер|чат|предоплат|осталось|общая|шт/i.test(s) && !/\s[А-ЯЁA-Z]/.test(s)) continue;
    if (/^\s*(40|50|60)\s+(стол|зал)/i.test(s)) continue; // «40 СТОЛ», «50 ЗАЛ» — не гости
    // «9 Таисия 3 стол❓» / «4 Светлана В2» / «Нина 3 стол» — число перед именем
    const mSt = s.match(/(\d{1,2})\s+([А-ЯЁA-Z][а-яёa-zA-Z\-]+(?:\s[А-ЯЁA-Z][а-яёa-zA-Z\-]+)?)\s+(?:\d{1,2}\s*)?(?:стол|зал|окно)?/i);
    // «Дарья / 5+5 реб» / «Татьяна /10+2 реб» / «2500 /Дарья/ 5+5 реб»
    const mp = s.match(/([А-ЯЁ][а-яё]+)\s*\/\s*(\d+)\s*\+\s*(\d+)\s*реб/i) ||
               s.match(/\b(\d+)\s*\+\s*(\d+)\s*реб/i);
    if (mp) {
      const a = mp[2] ? Number(mp[2]) : Number(mp[1]);
      const b = mp[3] ? Number(mp[3]) : Number(mp[2]);
      return a + b;
    }
    if (mSt) { const n = Number(mSt[1]); if (n > 0 && n <= 60) return n; }
    let g = extractGuests(s);
    if (g != null) return g;
  }
  return null;
}

module.exports = { parseFullList, extractName, extractGuests, extractPhone, extractTotal, extractDeposit };