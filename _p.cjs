const { parseFullList } = require("./full-list.cjs");
const txt = "24.11\n🔳20:00\nЗина 2 чел\n25 стол❗️";
const slots = parseFullList(txt);
console.log("слотов:", slots.length);
for (const s of slots) console.log(JSON.stringify(s));