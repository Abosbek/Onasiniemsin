export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/init-db") {
      try {
        await env.DB.exec(SCHEMA);
        return new Response("✅ Baza jadvallari muvaffaqiyatli yaratildi!", { status: 200 });
      } catch (e) {
        return new Response("Xato: " + e.message, { status: 500 });
      }
    }

    if (url.pathname === "/setup") {
      const webhookUrl = `https://${url.hostname}/`;
      const res = await setWebhook(env, webhookUrl);
      return new Response(JSON.stringify(res), { headers: { "Content-Type": "application/json" } });
    }

    if (request.method === "POST") {
      try {
        const update = await request.json();
        await handleUpdate(update, env);
      } catch (err) {
        console.log("Xato:", err.stack || err.message);
      }
      return new Response("OK", { status: 200 });
    }

    return new Response("Uzbek Test Bot Cloudflare'da mukammal ishlayapti!", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    await runScheduledTasks(env);
  }
};

// ================= BAZA JADVALLARI (SCHEMA) =================
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    first_name TEXT,
    last_name TEXT,
    father_name TEXT,
    region TEXT,
    level TEXT,
    grade TEXT,
    registered INTEGER DEFAULT 0,
    state TEXT,
    state_data TEXT,
    is_whitelisted INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admins (
    telegram_id INTEGER PRIMARY KEY,
    role TEXT,
    name TEXT,
    added_by INTEGER,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS channels (
    chat_id TEXT PRIMARY KEY,
    title TEXT,
    type TEXT,
    added_by INTEGER,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,
    subject TEXT,
    file_id TEXT,
    file_type TEXT,
    created_by INTEGER,
    start_time DATETIME,
    end_time DATETIME,
    answer_key TEXT,
    points TEXT,
    is_closed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_id INTEGER,
    telegram_id INTEGER,
    answers TEXT,
    correct_count INTEGER,
    total_count INTEGER,
    score REAL,
    max_score REAL,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

// ================= TELEGRAM API =================
function apiUrl(env, method) {
  return "https://api.telegram.org/bot" + env.BOT_TOKEN + "/" + method;
}

async function tgCall(env, method, payload) {
  const res = await fetch(apiUrl(env, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) console.log("Telegram API xatosi [" + method + "]:", JSON.stringify(data));
  return data;
}

async function sendMessage(env, chatId, text, replyMarkup = null, extra = {}) {
  const payload = { chat_id: chatId, text, parse_mode: "HTML", ...extra };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tgCall(env, "sendMessage", payload);
}

async function answerCallbackQuery(env, callbackQueryId, text = null, showAlert = false) {
  const payload = { callback_query_id: callbackQueryId };
  if (text) { payload.text = text; payload.show_alert = showAlert; }
  return tgCall(env, "answerCallbackQuery", payload);
}

async function sendDocument(env, chatId, fileId, caption = "", replyMarkup = null) {
  const payload = { chat_id: chatId, document: fileId, caption, parse_mode: "HTML" };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tgCall(env, "sendDocument", payload);
}

async function sendPhoto(env, chatId, fileId, caption = "", replyMarkup = null) {
  const payload = { chat_id: chatId, photo: fileId, caption, parse_mode: "HTML" };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tgCall(env, "sendPhoto", payload);
}

async function getChatMember(env, chatId, userId) {
  return tgCall(env, "getChatMember", { chat_id: chatId, user_id: userId });
}

async function setWebhook(env, url) {
  return tgCall(env, "setWebhook", {
    url, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query", "channel_post"],
  });
}

// ================= D1 BAZA FUNKSIYALARI =================
async function getUser(env, telegramId) {
  return await env.DB.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(telegramId).first() || null;
}

async function ensureUser(env, telegramId) {
  let user = await getUser(env, telegramId);
  if (!user) {
    await env.DB.prepare("INSERT INTO users (telegram_id, registered, state) VALUES (?, 0, 'reg_name')").bind(telegramId).run();
    user = await getUser(env, telegramId);
  } else {
    await env.DB.prepare("UPDATE users SET last_seen = datetime('now') WHERE telegram_id = ?").bind(telegramId).run();
  }
  return user;
}

async function setState(env, telegramId, state, stateData = null) {
  await env.DB.prepare("UPDATE users SET state = ?, state_data = ? WHERE telegram_id = ?").bind(state, stateData ? JSON.stringify(stateData) : null, telegramId).run();
}

function getStateData(user) {
  try { return user.state_data ? JSON.parse(user.state_data) : {}; } catch { return {}; }
}

async function updateUserFields(env, telegramId, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => k + " = ?").join(", ");
  const values = keys.map((k) => fields[k]);
  await env.DB.prepare("UPDATE users SET " + setClause + " WHERE telegram_id = ?").bind(...values, telegramId).run();
}

async function isAdmin(env, telegramId) {
  if (String(telegramId) === String(env.OWNER_ID)) return "owner";
  const row = await env.DB.prepare("SELECT role FROM admins WHERE telegram_id = ?").bind(telegramId).first();
  return row ? row.role : null;
}

async function isWhitelisted(env, telegramId) {
  if (String(telegramId) === String(env.OWNER_ID)) return true;
  const row = await env.DB.prepare("SELECT is_whitelisted FROM users WHERE telegram_id = ? AND is_whitelisted = 1").bind(telegramId).first();
  return !!row;
}

async function getSetting(env, key) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

async function setSetting(env, key, value) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

async function getChannels(env, type) {
  const { results } = await env.DB.prepare("SELECT * FROM channels WHERE type = ?").bind(type).all();
  return results || [];
}

async function getTestByCode(env, code) {
  return env.DB.prepare("SELECT * FROM tests WHERE code = ?").bind(code).first();
}

async function getActiveTests(env) {
  const { results } = await env.DB.prepare("SELECT * FROM tests WHERE is_closed = 0 AND datetime('now') <= datetime(end_time) ORDER BY start_time").all();
  return results || [];
}

async function getSubmission(env, testId, telegramId) {
  return env.DB.prepare("SELECT * FROM submissions WHERE test_id = ? AND telegram_id = ?").bind(testId, telegramId).first();
}

async function getRanking(env, testId) {
  const { results } = await env.DB.prepare("SELECT s.*, u.first_name, u.last_name, u.region, u.grade FROM submissions s JOIN users u ON u.telegram_id = s.telegram_id WHERE s.test_id = ? ORDER BY s.score DESC, s.submitted_at ASC").bind(testId).all();
  return results || [];
}

async function countUsers(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE registered = 1").first();
  return row ? row.c : 0;
}

async function countUsersToday(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE registered = 1 AND date(created_at) = date('now')").first();
  return row ? row.c : 0;
}

async function getAllUserIds(env) {
  const { results } = await env.DB.prepare("SELECT telegram_id FROM users WHERE registered = 1").all();
  return (results || []).map((r) => r.telegram_id);
}

// ================= VILOYATLAR VA KLAVIATURALAR =================
const REGIONS = [
  { code: "AND", name: "Andijon" }, { code: "BUX", name: "Buxoro" }, { code: "FAR", name: "Farg'ona" },
  { code: "JIZ", name: "Jizzax" }, { code: "XOR", name: "Xorazm" }, { code: "NAM", name: "Namangan" },
  { code: "NAV", name: "Navoiy" }, { code: "QAS", name: "Qashqadaryo" }, { code: "SAM", name: "Samarqand" },
  { code: "SIR", name: "Sirdaryo" }, { code: "SUR", name: "Surxondaryo" }, { code: "TVL", name: "Toshkent viloyati" },
  { code: "TSH", name: "Toshkent shahri" }, { code: "QOR", name: "Qoraqalpog'iston Respublikasi" },
];

function regionNameByCode(code) {
  const r = REGIONS.find((x) => x.code === code);
  return r ? r.name : code;
}

function regionKeyboard() {
  const rows = [];
  for (let i = 0; i < REGIONS.length; i += 2) {
    const row = [{ text: REGIONS[i].name, callback_data: "reg:region:" + REGIONS[i].code }];
    if (REGIONS[i + 1]) row.push({ text: REGIONS[i + 1].name, callback_data: "reg:region:" + REGIONS[i + 1].code });
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

function levelKeyboard() {
  return { inline_keyboard: [ [{ text: "🏫 Maktab o'quvchisi", callback_data: "reg:level:maktab" }, { text: "🎓 Talaba", callback_data: "reg:level:talaba" }] ] };
}

function gradeKeyboard() {
  const rows = [];
  for (let i = 1; i <= 11; i += 4) {
    const row = [];
    for (let g = i; g < i + 4 && g <= 11; g++) { row.push({ text: g + "-sinf", callback_data: "reg:grade:" + g }); }
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

function courseKeyboard() {
  return { inline_keyboard: [ [{ text: "1-kurs", callback_data: "reg:grade:1-kurs" }, { text: "2-kurs", callback_data: "reg:grade:2-kurs" }], [{ text: "3-kurs", callback_data: "reg:grade:3-kurs" }, { text: "4-kurs", callback_data: "reg:grade:4-kurs" }] ] };
}

function studentMainMenu() {
  return { keyboard: [ [{ text: "📝 Test tekshirish" }], [{ text: "📋 Faol testlar" }, { text: "⚙️ Profilni tahrirlash" }] ], resize_keyboard: true, is_persistent: true };
}

function profileEditKeyboard() {
  return { inline_keyboard: [ [{ text: "✏️ Ismni o'zgartirish", callback_data: "profile:name" }], [{ text: "✏️ Familiyani o'zgartirish", callback_data: "profile:lastname" }], [{ text: "🌍 Viloyatni o'zgartirish", callback_data: "profile:region" }], [{ text: "🎓 Sinf/kursni o'zgartirish", callback_data: "profile:grade" }] ] };
}

function adminMenuKeyboard(role) {
  const rows = [ [{ text: "📊 Statistika", callback_data: "admin:stats" }], [{ text: "➕ Yangi test qo'shish", callback_data: "admin:addtest" }], [{ text: "📋 Mening testlarim", callback_data: "admin:mytests" }] ];
  if (role === "owner") {
    rows.push([{ text: "📢 Kanallarni boshqarish", callback_data: "admin:channels" }]);
    rows.push([{ text: "✉️ Xabar tarqatish", callback_data: "admin:broadcast" }]);
    rows.push([{ text: "👨‍🏫 Sub-adminlar", callback_data: "admin:teachers" }]);
    rows.push([{ text: "🔴/🟢 Texnik rejim", callback_data: "admin:maintenance" }]);
  }
  return { inline_keyboard: rows };
}

function channelsMenuKeyboard() {
  return { inline_keyboard: [ [{ text: "➕ Majburiy kanal qo'shish", callback_data: "chan:add:required" }], [{ text: "🗄 Baza kanalini belgilash", callback_data: "chan:add:base" }], [{ text: "🏆 Natijalar kanalini belgilash", callback_data: "chan:add:results" }], [{ text: "📋 Kanallar ro'yxati", callback_data: "chan:list" }], [{ text: "⬅️ Orqaga", callback_data: "admin:back" }] ] };
}

function pointsModeKeyboard() {
  return { inline_keyboard: [ [{ text: "Barchasiga bir xil ball", callback_data: "addtest:points:equal" }], [{ text: "Har biriga alohida ball", callback_data: "addtest:points:custom" }] ] };
}

// ================= YORDAMCHI FUNKSIYALAR =================
async function generateTestCode(env) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const exists = await env.DB.prepare("SELECT id FROM tests WHERE code = ?").bind(code).first();
    if (!exists) return code;
  }
  throw new Error("Noyob kod generatsiya qilib bo'lmadi");
}

async function checkSubscription(env, telegramId) {
  const required = await getChannels(env, "required");
  if (required.length === 0) return { ok: true, missing: [] };
  const missing = [];
  for (const ch of required) {
    try {
      const res = await getChatMember(env, ch.chat_id, telegramId);
      const status = res?.result?.status;
      if (!res.ok || ["left", "kicked"].includes(status)) missing.push(ch);
    } catch { missing.push(ch); }
  }
  return { ok: missing.length === 0, missing };
}

function channelUrl(chatId) {
  const id = String(chatId);
  if (id.startsWith("@")) return "https://t.me/" + id.slice(1);
  if (id.startsWith("https://") || id.startsWith("t.me/")) return id.startsWith("t.me") ? "https://" + id : id;
  return "https://t.me/" + id;
}

function subscriptionKeyboard(missing) {
  const rows = missing.map((ch) => [ { text: "➕ " + (ch.title || "Kanalga o'tish"), url: channelUrl(ch.chat_id) } ]);
  rows.push([{ text: "✅ A'zo bo'ldim", callback_data: "check_sub" }]);
  return { inline_keyboard: rows };
}

function parseUserDateTime(str) {
  const m = str.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, d, mo, y, h, mi] = m;
  const iso = y + "-" + mo.padStart(2, "0") + "-" + d.padStart(2, "0") + "T" + h.padStart(2, "0") + ":" + mi + ":00";
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;
  return iso;
}

function formatDateTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  const pad = (n) => String(n).padStart(2, "0");
  return pad(d.getUTCDate()) + "." + pad(d.getUTCMonth() + 1) + "." + d.getUTCFullYear() + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
}

function minutesUntil(iso) {
  const target = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z").getTime();
  return Math.round((target - Date.now()) / 60000);
}

function scoreAnswers(userAnswers, key, points) {
  const ua = userAnswers.toUpperCase().replace(/[^A-Z]/g, "");
  const k = key.toUpperCase();
  let score = 0; let maxScore = 0; let correctCount = 0; const wrongQuestions = [];
  for (let i = 0; i < k.length; i++) {
    const p = points[i] !== undefined ? points[i] : 1;
    maxScore += p;
    if (ua[i] && ua[i] === k[i]) { score += p; correctCount++; } 
    else { wrongQuestions.push(i + 1); }
  }
  return { score, maxScore, correctCount, total: k.length, wrongQuestions };
}

function formatMinutes(mins) {
  if (mins < 60) return mins + " daqiqa";
  const h = Math.floor(mins / 60); const m = mins % 60;
  return h + " soat " + m + " daqiqa";
}

// ================= RO'YXATDAN O'TISH & PROFIL =================
async function handleRegistrationText(env, user, text) {
  const chatId = user.telegram_id; const t = text.trim();
  if (user.state === "reg_name") {
    if (t.length < 2) { await sendMessage(env, chatId, "❗️ Ismingizni to'liq kiriting:"); return; }
    await updateUserFields(env, chatId, { first_name: t });
    await setState(env, chatId, "reg_lastname");
    await sendMessage(env, chatId, "Familiyangizni kiriting:"); return;
  }
  if (user.state === "reg_lastname") {
    if (t.length < 2) { await sendMessage(env, chatId, "❗️ Familiyangizni to'liq kiriting:"); return; }
    await updateUserFields(env, chatId, { last_name: t });
    await setState(env, chatId, "reg_fathername");
    await sendMessage(env, chatId, "Otasining ismini kiriting:"); return;
  }
  if (user.state === "reg_fathername") {
    if (t.length < 2) { await sendMessage(env, chatId, "❗️ Otasining ismini to'liq kiriting:"); return; }
    await updateUserFields(env, chatId, { father_name: t });
    await setState(env, chatId, "reg_region");
    await sendMessage(env, chatId, "🌍 Hududingizni tanlang:", regionKeyboard()); return;
  }
}

async function handleRegistrationCallback(env, user, data) {
  const chatId = user.telegram_id;
  if (data.startsWith("reg:region:")) {
    const code = data.split(":")[2];
    await updateUserFields(env, chatId, { region: regionNameByCode(code) });
    await setState(env, chatId, "reg_level");
    await sendMessage(env, chatId, "🎓 Ta'lim darajangizni tanlang:", levelKeyboard()); return true;
  }
  if (data.startsWith("reg:level:")) {
    const level = data.split(":")[2];
    await updateUserFields(env, chatId, { level });
    await setState(env, chatId, "reg_grade");
    if (level === "maktab") await sendMessage(env, chatId, "📚 Necha sinfda o'qiysiz?", gradeKeyboard());
    else await sendMessage(env, chatId, "📚 Necha kursda o'qiysiz?", courseKeyboard());
    return true;
  }
  if (data.startsWith("reg:grade:")) {
    const grade = data.split(":")[2];
    await updateUserFields(env, chatId, { grade, registered: 1, state: null, state_data: null });
    await sendMessage(env, chatId, "✅ Ro'yxatdan muvaffaqiyatli o'tdingiz!\n\nEndi quyidagi menyudan foydalanishingiz mumkin 👇", studentMainMenu());
    return true;
  }
  return false;
}

async function handleProfileCallback(env, user, data) {
  const chatId = user.telegram_id;
  if (data === "profile:name") { await setState(env, chatId, "profile_edit_name"); await sendMessage(env, chatId, "Yangi ismingizni kiriting:"); return true; }
  if (data === "profile:lastname") { await setState(env, chatId, "profile_edit_lastname"); await sendMessage(env, chatId, "Yangi familiyangizni kiriting:"); return true; }
  if (data === "profile:region") { await setState(env, chatId, "profile_edit_region"); await sendMessage(env, chatId, "Yangi hududingizni tanlang:", regionKeyboard()); return true; }
  if (data === "profile:grade") { await setState(env, chatId, "profile_edit_level"); await sendMessage(env, chatId, "Ta'lim darajangizni tanlang:", levelKeyboard()); return true; }
  return false;
}

async function handleProfileEditText(env, user, text) {
  const chatId = user.telegram_id; const t = text.trim();
  if (user.state === "profile_edit_name") { await updateUserFields(env, chatId, { first_name: t, state: null, state_data: null }); await sendMessage(env, chatId, "✅ Ism yangilandi.", studentMainMenu()); return true; }
  if (user.state === "profile_edit_lastname") { await updateUserFields(env, chatId, { last_name: t, state: null, state_data: null }); await sendMessage(env, chatId, "✅ Familiya yangilandi.", studentMainMenu()); return true; }
  return false;
}

async function handleProfileEditCallback(env, user, data) {
  const chatId = user.telegram_id;
  if (user.state === "profile_edit_region" && data.startsWith("reg:region:")) {
    const code = data.split(":")[2];
    await updateUserFields(env, chatId, { region: regionNameByCode(code), state: null, state_data: null });
    await sendMessage(env, chatId, "✅ Hudud yangilandi.", studentMainMenu()); return true;
  }
  if (user.state === "profile_edit_level" && data.startsWith("reg:level:")) {
    const level = data.split(":")[2]; await updateUserFields(env, chatId, { level }); await setState(env, chatId, "profile_edit_grade");
    if (level === "maktab") await sendMessage(env, chatId, "Sinfingizni tanlang:", gradeKeyboard()); else await sendMessage(env, chatId, "Kursingizni tanlang:", courseKeyboard());
    return true;
  }
  if (user.state === "profile_edit_grade" && data.startsWith("reg:grade:")) {
    const grade = data.split(":")[2]; await updateUserFields(env, chatId, { grade, state: null, state_data: null });
    await sendMessage(env, chatId, "✅ Sinf/kurs yangilandi.", studentMainMenu()); return true;
  }
  return false;
}

// ================= USER & TEST MANTIQ =================
async function handleMainMenuText(env, user, text) {
  const chatId = user.telegram_id; const t = text.trim();
  if (t === "📝 Test tekshirish") { await setState(env, chatId, "waiting_test_code"); await sendMessage(env, chatId, "🔑 Test kodini yuboring (masalan: 1234):"); return true; }
  if (t === "📋 Faol testlar") { await showActiveTests(env, chatId); return true; }
  if (t === "⚙️ Profilni tahrirlash") { await setState(env, chatId, "profile_menu"); await sendMessage(env, chatId, "Nimani o'zgartiramiz?", profileEditKeyboard()); return true; }
  return false;
}

async function showActiveTests(env, chatId) {
  const tests = await getActiveTests(env);
  if (tests.length === 0) { await sendMessage(env, chatId, "Hozircha faol testlar yo'q."); return; }
  let msg = "📋 <b>Faol testlar:</b>\n\n";
  tests.forEach((t, i) => { msg += (i + 1) + ". " + (t.subject || "Test") + " (Kodi: <b>" + t.code + "</b>)\n   ⏰ Tugash: " + formatDateTime(t.end_time) + "\n\n"; });
  await sendMessage(env, chatId, msg);
}

async function handleTestCode(env, user, code) {
  const chatId = user.telegram_id; const cleanCode = code.trim();
  const test = await getTestByCode(env, cleanCode);
  if (!test) { await sendMessage(env, chatId, "❌ Bunday kodli test topilmadi. Qaytadan urinib ko'ring:"); return; }
  const now = new Date(); const start = new Date(test.start_time.includes("T") ? test.start_time : test.start_time.replace(" ", "T") + "Z"); const end = new Date(test.end_time.includes("T") ? test.end_time : test.end_time.replace(" ", "T") + "Z");
  if (test.is_closed || now > end) { await sendMessage(env, chatId, "⛔️ Bu testning muddati allaqachon tugagan."); await setState(env, chatId, null); return; }
  if (now < start) { await sendMessage(env, chatId, "⏳ Bu test hali boshlanmagan. Boshlanish vaqti: " + formatDateTime(test.start_time)); return; }
  const existing = await getSubmission(env, test.id, chatId);
  if (existing) { await sendMessage(env, chatId, "⚠️ Siz bu testni allaqachon ishlagansiz."); await setState(env, chatId, null); return; }
  const sub = await checkSubscription(env, chatId);
  if (!sub.ok) { await sendMessage(env, chatId, "📢 Testni olishdan oldin quyidagi kanallarga a'zo bo'ling:", subscriptionKeyboard(sub.missing)); await setState(env, chatId, "waiting_test_code", { pendingCode: cleanCode }); return; }
  const minsLeft = Math.max(0, Math.round((end - now) / 60000));
  const caption = "📄 Sizga test taqdim etildi.\n⏰ Muddat tugashiga <b>" + formatMinutes(minsLeft) + "</b> qoldi.\n\n✏️ Javoblaringizni bitta xabar qilib yuboring (masalan: <code>abcdabcd...</code>)";
  if (test.file_type === "photo") await sendPhoto(env, chatId, test.file_id, caption); else await sendDocument(env, chatId, test.file_id, caption);
  await setState(env, chatId, "waiting_answers:" + test.id);
}

async function handleCheckSubCallback(env, user) {
  const chatId = user.telegram_id; const sub = await checkSubscription(env, chatId);
  if (!sub.ok) return { ok: false };
  const data = getStateData(user);
  if (data.pendingCode) await handleTestCode(env, user, data.pendingCode);
  else { await sendMessage(env, chatId, "✅ Rahmat! Endi test kodini qayta yuboring."); await setState(env, chatId, "waiting_test_code"); }
  return { ok: true };
}

async function handleAnswerSubmission(env, user, testId, answerText) {
  const chatId = user.telegram_id; const test = await env.DB.prepare("SELECT * FROM tests WHERE id = ?").bind(testId).first();
  if (!test) { await setState(env, chatId, null); return; }
  const now = new Date(); const end = new Date(test.end_time.includes("T") ? test.end_time : test.end_time.replace(" ", "T") + "Z");
  if (test.is_closed || now > end) { await sendMessage(env, chatId, "⛔️ Afsuski, testning muddati tugagan."); await setState(env, chatId, null); return; }
  const existing = await getSubmission(env, testId, chatId);
  if (existing) { await sendMessage(env, chatId, "⚠️ Siz allaqachon javob yubordingiz."); await setState(env, chatId, null); return; }
  const cleaned = answerText.replace(/[^a-zA-Z]/g, "");
  if (cleaned.length === 0) { await sendMessage(env, chatId, "❗️ Iltimos, javoblarni harflar bilan yuboring."); return; }
  const points = JSON.parse(test.points || "[]");
  const result = scoreAnswers(cleaned, test.answer_key, points);
  await env.DB.prepare("INSERT INTO submissions (test_id, telegram_id, answers, correct_count, total_count, score, max_score) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(testId, chatId, cleaned.toUpperCase(), result.correctCount, result.total, result.score, result.maxScore).run();
  await setState(env, chatId, null);
  const ranking = await getRanking(env, testId); const place = ranking.findIndex((r) => r.telegram_id === chatId) + 1; const percent = result.maxScore > 0 ? Math.round((result.score / result.maxScore) * 100) : 0;
  const wrongList = result.wrongQuestions.length > 0 ? result.wrongQuestions.join(", ") : "yo'q 🎉";
  const resultMsg = "✅ <b>Natijangiz tayyor!</b>\n\n📊 Ball: <b>" + result.score + " / " + result.maxScore + "</b> (" + percent + "%)\n✔️ To'g'ri javoblar: " + result.correctCount + " / " + result.total + "\n❌ Xato savollar: " + wrongList + "\n🏆 Reyting: <b>" + place + "-o'rin</b> (" + ranking.length + " qatnashuvchidan)";
  await sendMessage(env, chatId, resultMsg, studentMainMenu());
  const resultsChannels = await getChannels(env, "results");
  const channelMsg = "🆕 <b>Yangi natija</b>\n👤 " + user.first_name + " " + user.last_name + "\n🌍 " + user.region + " | " + user.grade + "\n📘 Test: " + (test.subject || test.code) + "\n📊 Ball: " + result.score + "/" + result.maxScore + "\n🏆 O'rin: " + place + "\n🕒 " + formatDateTime(new Date().toISOString());
  for (const ch of resultsChannels) await sendMessage(env, ch.chat_id, channelMsg);
  await sendMessage(env, env.OWNER_ID, channelMsg);
}

// ================= ADMIN PANEL =================
async function showAdminMenu(env, chatId, role) {
  await sendMessage(env, chatId, "👑 <b>Admin panel</b>\n\nKerakli bo'limni tanlang:", adminMenuKeyboard(role));
}

async function handleAdminCallback(env, user, data, role) {
  const chatId = user.telegram_id;
  if (data === "admin:back") { await showAdminMenu(env, chatId, role); return true; }
  if (data === "admin:stats") {
    const total = await countUsers(env); const today = await countUsersToday(env);
    await sendMessage(env, chatId, "📊 <b>Statistika</b>\n\n👥 Jami o'quvchilar: <b>" + total + "</b>\n🆕 Bugun qo'shilganlar: <b>" + today + "</b>", adminMenuKeyboard(role)); return true;
  }
  if (data === "admin:addtest") {
    const baseChannels = await getChannels(env, "base");
    if (baseChannels.length === 0) { await sendMessage(env, chatId, "⚠️ Avval Baza kanalini belgilang."); return true; }
    await setState(env, chatId, "admin_awaiting_file");
    await sendMessage(env, chatId, "📤 Test faylini (PDF yoki rasm) <b>" + (baseChannels[0].title || baseChannels[0].chat_id) + "</b> Baza kanaliga yuboring."); return true;
  }
  if (data === "admin:mytests") {
    const { results } = await env.DB.prepare("SELECT * FROM tests WHERE created_by = ? ORDER BY created_at DESC LIMIT 15").bind(chatId).all();
    if (!results || results.length === 0) { await sendMessage(env, chatId, "Sizda hali testlar yo'q.", adminMenuKeyboard(role)); return true; }
    let msg = "📋 <b>Sizning testlaringiz:</b>\n\n";
    for (const t of results) {
      const subCount = await env.DB.prepare("SELECT COUNT(*) as c FROM submissions WHERE test_id = ?").bind(t.id).first();
      msg += "• " + (t.subject || "Test") + " — Kodi: <b>" + t.code + "</b>\n  ⏰ " + formatDateTime(t.start_time) + " — " + formatDateTime(t.end_time) + "\n  ✍️ Ishlaganlar: " + subCount.c + (t.is_closed ? " (yopilgan)" : "") + "\n\n";
    }
    await sendMessage(env, chatId, msg, adminMenuKeyboard(role)); return true;
  }
  if (data === "admin:channels" && role === "owner") { await sendMessage(env, chatId, "📢 <b>Kanallarni boshqarish</b>", channelsMenuKeyboard()); return true; }
  if (data.startsWith("chan:add:") && role === "owner") {
    const type = data.split(":")[2]; await setState(env, chatId, "admin_channel_add", { type });
    await sendMessage(env, chatId, "Kanal qo'shish uchun:\n1) Botni o'sha kanalga admin qiling.\n2) Kanaldan istalgan xabarni shu chatga forward qiling yoki kanal username'ini yuboring."); return true;
  }
  if (data === "chan:list" && role === "owner") {
    const required = await getChannels(env, "required"); const base = await getChannels(env, "base"); const results = await getChannels(env, "results");
    let msg = "📋 <b>Kanallar:</b>\n\n<b>Majburiy kanallar:</b>\n"; msg += required.length ? required.map((c) => "• " + (c.title || c.chat_id)).join("\n") : "yo'q";
    msg += "\n\n<b>Baza kanali:</b>\n"; msg += base.length ? base.map((c) => "• " + (c.title || c.chat_id)).join("\n") : "belgilanmagan";
    msg += "\n\n<b>Natijalar kanali:</b>\n"; msg += results.length ? results.map((c) => "• " + (c.title || c.chat_id)).join("\n") : "belgilanmagan";
    await sendMessage(env, chatId, msg, channelsMenuKeyboard()); return true;
  }
  if (data === "admin:broadcast" && role === "owner") { await setState(env, chatId, "admin_broadcast_waiting"); await sendMessage(env, chatId, "✉️ Xabar matnini kiriting:"); return true; }
  if (data === "admin:maintenance" && role === "owner") {
    const current = await getSetting(env, "maintenance"); const newVal = current === "1" ? "0" : "1"; await setSetting(env, "maintenance", newVal);
    await sendMessage(env, chatId, newVal === "1" ? "🔴 Texnik rejim YOQILDI." : "🟢 Texnik rejim O'CHIRILDI.", adminMenuKeyboard(role)); return true;
  }
  if (data === "admin:teachers" && role === "owner") {
    const { results } = await env.DB.prepare("SELECT * FROM admins WHERE role = 'teacher'").all();
    let msg = "👨‍🏫 <b>Sub-adminlar</b>\n\n"; msg += results && results.length ? results.map((r) => "• " + (r.name || r.telegram_id)).join("\n") : "Yo'q";
    msg += "\n\nYangi qo'shish uchun Telegram ID raqamini yuboring:"; await setState(env, chatId, "admin_teacher_add"); await sendMessage(env, chatId, msg); return true;
  }
  if (data.startsWith("addtest:points:")) {
    const mode = data.split(":")[2]; const stateData = getStateData(user);
    if (mode === "equal") { await setState(env, chatId, "admin_test_points_equal", stateData); await sendMessage(env, chatId, "Bitta savol uchun ballni kiriting (masalan: 1):"); }
    else { await setState(env, chatId, "admin_test_points_custom", stateData); await sendMessage(env, chatId, "Ballarni vergul bilan kiriting (1,2,1...):"); }
    return true;
  }
  return false;
}

async function handleBaseChannelFile(env, chatId, waitingAdminId, fileId, fileType) {
  const code = await generateTestCode(env);
  const res = await env.DB.prepare("INSERT INTO tests (code, file_id, file_type, created_by, start_time, end_time, answer_key, points, is_closed) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), '', '[]', 1)").bind(code, fileId, fileType, waitingAdminId).run();
  await setState(env, waitingAdminId, "admin_test_subject", { testId: res.meta.last_row_id });
  await sendMessage(env, waitingAdminId, "✅ Fayl qabul qilindi. Kodi: <b>" + code + "</b>\n\nEndi fan nomini kiriting:");
}

async function handleAddTestText(env, user, text) {
  const chatId = user.telegram_id; const data = getStateData(user); const t = text.trim();
  if (user.state === "admin_test_subject") { await env.DB.prepare("UPDATE tests SET subject = ? WHERE id = ?").bind(t, data.testId).run(); await setState(env, chatId, "admin_test_start", data); await sendMessage(env, chatId, "⏰ Boshlanish vaqtini kiriting (KK.OO.YYYY SS:DD):"); return true; }
  if (user.state === "admin_test_start") { const iso = parseUserDateTime(t); if (!iso) { await sendMessage(env, chatId, "❗️ Format xato."); return true; } await env.DB.prepare("UPDATE tests SET start_time = ? WHERE id = ?").bind(iso, data.testId).run(); await setState(env, chatId, "admin_test_end", data); await sendMessage(env, chatId, "⏰ Tugash vaqtini kiriting (KK.OO.YYYY SS:DD):"); return true; }
  if (user.state === "admin_test_end") { const iso = parseUserDateTime(t); if (!iso) { await sendMessage(env, chatId, "❗️ Format xato."); return true; } await env.DB.prepare("UPDATE tests SET end_time = ? WHERE id = ?").bind(iso, data.testId).run(); await setState(env, chatId, "admin_test_key", data); await sendMessage(env, chatId, "🔑 Javoblar kalitini kiriting (ABCD...):"); return true; }
  if (user.state === "admin_test_key") { const key = t.replace(/[^a-zA-Z]/g, "").toUpperCase(); if (!key) { await sendMessage(env, chatId, "❗️ Faqat harflar."); return true; } await env.DB.prepare("UPDATE tests SET answer_key = ? WHERE id = ?").bind(key, data.testId).run(); await setState(env, chatId, "admin_test_points_mode", { ...data, keyLen: key.length }); await sendMessage(env, chatId, "Ballarni belgilaymiz:", pointsModeKeyboard()); return true; }
  if (user.state === "admin_test_points_equal") { const val = parseFloat(t.replace(",", ".")); if (isNaN(val) || val <= 0) { await sendMessage(env, chatId, "❗️ Musbat son kiriting:"); return true; } const test = await env.DB.prepare("SELECT answer_key FROM tests WHERE id = ?").bind(data.testId).first(); const points = new Array(test.answer_key.length).fill(val); await finalizeTest(env, chatId, data.testId, points); return true; }
  if (user.state === "admin_test_points_custom") { const test = await env.DB.prepare("SELECT answer_key FROM tests WHERE id = ?").bind(data.testId).first(); const points = t.split(",").map((x) => parseFloat(x.trim())).filter((x) => !isNaN(x)); if (points.length !== test.answer_key.length) { await sendMessage(env, chatId, "❗️ Ballar soni savollarga mos tushmadi."); return true; } await finalizeTest(env, chatId, data.testId, points); return true; }
  if (user.state === "admin_broadcast_waiting") { await setState(env, chatId, null); await sendMessage(env, chatId, "⏳ Xabar yuborilmoqda..."); const ids = await getAllUserIds(env); let sent = 0; const batchSize = 25; for (let i = 0; i < ids.length; i += batchSize) { const batch = ids.slice(i, i + batchSize); await Promise.allSettled(batch.map((id) => sendMessage(env, id, t))); sent += batch.length; } await sendMessage(env, chatId, "✅ " + sent + " kishiga yuborildi."); return true; }
  if (user.state === "admin_channel_add" && t.startsWith("@")) { await env.DB.prepare("INSERT INTO channels (chat_id, title, type, added_by) VALUES (?, ?, ?, ?)").bind(t, t, data.type, chatId).run(); await setState(env, chatId, null); await sendMessage(env, chatId, "✅ Qo'shildi.", channelsMenuKeyboard()); return true; }
  if (user.state === "admin_teacher_add") { const id = parseInt(t.replace(/\D/g, ""), 10); if (!id) return true; await env.DB.prepare("INSERT INTO admins (telegram_id, role, added_by) VALUES (?, 'teacher', ?) ON CONFLICT(telegram_id) DO NOTHING").bind(id, chatId).run(); await setState(env, chatId, null); await sendMessage(env, chatId, "✅ Qo'shildi."); return true; }
  return false;
}

async function finalizeTest(env, chatId, testId, points) {
  await env.DB.prepare("UPDATE tests SET points = ?, is_closed = 0 WHERE id = ?").bind(JSON.stringify(points), testId).run();
  const test = await env.DB.prepare("SELECT * FROM tests WHERE id = ?").bind(testId).first();
  await setState(env, chatId, null);
  await sendMessage(env, chatId, "🎉 <b>Test faollashtirildi!</b>\n\n📘 " + test.subject + "\n🔑 Kod: <b>" + test.code + "</b>\n⏰ " + formatDateTime(test.start_time) + " — " + formatDateTime(test.end_time), adminMenuKeyboard("owner"));
}

async function handleChannelForward(env, chatId, forwardChat, type) {
  await env.DB.prepare("INSERT INTO channels (chat_id, title, type, added_by) VALUES (?, ?, ?, ?)").bind(String(forwardChat.id), forwardChat.title || forwardChat.username || String(forwardChat.id), type, chatId).run();
  await setState(env, chatId, null);
  await sendMessage(env, chatId, "✅ Kanal qo'shildi: " + (forwardChat.title || forwardChat.username), channelsMenuKeyboard());
}

// ================= ASOSIY EVENT ROUTER =================
async function handleUpdate(update, env) {
  if (update.channel_post) {
    const post = update.channel_post; const chatId = String(post.chat.id); const baseChannels = await getChannels(env, "base");
    if (!baseChannels.some((c) => c.chat_id === chatId)) return;
    let fileId = null; let fileType = null;
    if (post.document) { fileId = post.document.file_id; fileType = "document"; } else if (post.photo && post.photo.length > 0) { fileId = post.photo[post.photo.length - 1].file_id; fileType = "photo"; }
    if (!fileId) return;
    const { results } = await env.DB.prepare("SELECT telegram_id FROM users WHERE state = 'admin_awaiting_file' LIMIT 1").all();
    if (results && results.length > 0) await handleBaseChannelFile(env, chatId, results[0].telegram_id, fileId, fileType);
    return;
  }
  
  if (update.callback_query) {
    const cb = update.callback_query; const chatId = cb.from.id; const user = await ensureUser(env, chatId);
    await answerCallbackQuery(env, cb.id);
    if (cb.data.startsWith("reg:")) {
      if (user.state && user.state.startsWith("profile_edit_")) await handleProfileEditCallback(env, user, cb.data);
      else await handleRegistrationCallback(env, user, cb.data);
      return;
    }
    if (cb.data === "check_sub") { await handleCheckSubCallback(env, user); return; }
    if (cb.data.startsWith("profile:")) { await handleProfileCallback(env, user, cb.data); return; }
    if (cb.data.startsWith("admin:") || cb.data.startsWith("chan:") || cb.data.startsWith("addtest:")) {
      const role = await isAdmin(env, chatId); if (role) await handleAdminCallback(env, user, cb.data, role); return;
    }
  }

  if (update.message && update.message.chat.type === "private") {
    const msg = update.message; const chatId = msg.chat.id; const text = msg.text || "";
    const maintenance = await getSetting(env, "maintenance"); const admRole = await isAdmin(env, chatId);
    if (maintenance === "1" && !admRole && !(await isWhitelisted(env, chatId))) {
      await sendMessage(env, chatId, "🛠 Botda texnik ishlar olib borilmoqda. Iltimos keyinroq urinib ko'ring."); return;
    }

    if (text === "/start") {
      const user = await ensureUser(env, chatId);
      if (user.registered) await sendMessage(env, chatId, "🏠 Bosh menyu:", studentMainMenu());
      else { await setState(env, chatId, "reg_name"); await sendMessage(env, chatId, "👋 Botga xush kelibsiz!\n\nIsmingizni kiriting:"); }
      return;
    }
    if (text === "/admin") {
      const role = await isAdmin(env, chatId);
      if (role) await showAdminMenu(env, chatId, role); else await sendMessage(env, chatId, "⛔️ Huquq yo'q.");
      return;
    }

    const user = await ensureUser(env, chatId);
    if (user.state === "admin_channel_add" && msg.forward_from_chat) { await handleChannelForward(env, chatId, msg.forward_from_chat, getStateData(user).type); return; }
    if (["reg_name", "reg_lastname", "reg_fathername"].includes(user.state)) { await handleRegistrationText(env, user, text); return; }
    if (!user.registered) { await sendMessage(env, chatId, "Iltimos, tugmalardan foydalaning."); return; }
    if (user.state && user.state.startsWith("admin_")) { const h = await handleAddTestText(env, user, text); if (h) return; }
    if (user.state === "profile_edit_name" || user.state === "profile_edit_lastname") { await handleProfileEditText(env, user, text); return; }
    if (user.state === "waiting_test_code") { await handleTestCode(env, user, text); return; }
    if (user.state && user.state.startsWith("waiting_answers:")) { await handleAnswerSubmission(env, user, parseInt(user.state.split(":")[1], 10), text); return; }
    
    const h = await handleMainMenuText(env, user, text);
    if (!h) await sendMessage(env, chatId, "Iltimos, menyudan tanlang 👇", studentMainMenu());
  }
}

// ================= CRON: REJALASHTIRILGAN VAZIFALAR =================
async function runScheduledTasks(env) {
  try {
    await env.DB.prepare("UPDATE tests SET is_closed = 1 WHERE is_closed = 0 AND datetime('now') > datetime(end_time)").run();
    const { results: soonTests } = await env.DB.prepare("SELECT * FROM tests WHERE is_closed = 0 AND datetime(end_time) BETWEEN datetime('now') AND datetime('now', '+5 minutes')").all();
    
    for (const test of soonTests || []) {
      const { results: waitingUsers } = await env.DB.prepare("SELECT telegram_id, state, state_data FROM users WHERE state = ?").bind("waiting_answers:" + test.id).all();
      for (const u of waitingUsers || []) {
        const already = await env.DB.prepare("SELECT id FROM submissions WHERE test_id = ? AND telegram_id = ?").bind(test.id, u.telegram_id).first();
        if (already) continue;
        let sd = {}; try { sd = u.state_data ? JSON.parse(u.state_data) : {}; } catch { sd = {}; }
        if (sd.reminded) continue;
        
        const mins = minutesUntil(test.end_time);
        await sendMessage(env, u.telegram_id, "⏰ Diqqat! Test yakunlanishiga <b>" + Math.max(mins, 0) + " daqiqa</b> qoldi. Javoblarni yuboring!");
        await setState(env, u.telegram_id, "waiting_answers:" + test.id, { ...sd, reminded: true });
      }
    }
  } catch (err) { console.log("Cron xato:", err.message); }
}

