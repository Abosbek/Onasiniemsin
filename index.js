/**
 * ============================================================================
 *  UZBEK TEST BOT — Cloudflare Workers + Telegram Bot API + D1
 * ============================================================================
 *  Talab qilingan barcha funksiyalar:
 *   ✅ Majburiy obuna (global blokator - obuna bo'lmasa bot ishlamaydi)
 *   ✅ Admin va Sub-admin tizimi + Botni yoqish/o'chirish (On/Off)
 *   ✅ Kanallarni boshqarish (Majburiy / Baza / Natijalar) + to'liq ro'yxat
 *   ✅ Test yaratish: fayl to'g'ridan-to'g'ri BOTGA yuboriladi, bot o'zi
 *      Baza kanaliga joylaydi (va kod orqali o'chirilganda kanaldan olib tashlaydi)
 *   ✅ Testni istalgan payt qo'lda yakunlash + reytingni Natijalar kanaliga chiqarish
 *   ✅ Testni o'chirishda barcha bog'liq ma'lumotlar (submissions, quiz_questions,
 *      user_polls, test_sessions) to'liq tozalanadi
 *   ✅ Oddiy test va Viktorina (Quiz) — ikkalasida ham reyting + xato savollar
 *   ✅ "Umumiy reyting" va "Kod orqali maxsus test reytingi"
 *   ✅ Broadcast (tsikl + yakuniy hisobot)
 *   ✅ Har bir qadamda "❌ Bekor qilish" tugmasi
 *
 *  ENV o'zgaruvchilari:
 *   BOT_TOKEN       — Telegram bot tokeni
 *   OWNER_ID        — Bosh administrator Telegram ID (raqam)
 *   WEBHOOK_SECRET  — Telegram webhook secret_token
 *   DB              — Cloudflare D1 bazasi binding
 *
 *  Endpointlar:
 *   GET /init-db  — bazani yaratish/yangilash
 *   GET /setup    — webhookni ulash
 *   POST /        — Telegram yangilanishlarini qabul qilish
 * ============================================================================
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ================= 1. BAZA YARATISH VA YANGILASH =================
    if (url.pathname === "/init-db") {
      try {
        await env.DB.batch([
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
            telegram_id INTEGER PRIMARY KEY,
            first_name TEXT, last_name TEXT, father_name TEXT,
            region TEXT, level TEXT, grade TEXT,
            registered INTEGER DEFAULT 0,
            balance REAL DEFAULT 0,
            state TEXT, state_data TEXT,
            is_whitelisted INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
          )`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS admins (
            telegram_id INTEGER PRIMARY KEY,
            role TEXT, name TEXT, added_by INTEGER,
            added_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY, value TEXT
          )`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL, title TEXT, type TEXT NOT NULL,
            added_by INTEGER, added_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS tests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE,
            subject TEXT,
            file_id TEXT, file_type TEXT,
            base_chat_id TEXT, base_message_id INTEGER,
            created_by INTEGER,
            start_time DATETIME, end_time DATETIME,
            answer_key TEXT, points TEXT,
            price REAL DEFAULT 0, timer INTEGER DEFAULT 0,
            is_quiz INTEGER DEFAULT 0, is_closed INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            test_id INTEGER, telegram_id INTEGER,
            answers TEXT, correct_count INTEGER, total_count INTEGER,
            score REAL, max_score REAL, wrong_questions TEXT,
            submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS quiz_questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            test_id INTEGER, question TEXT, options TEXT, correct_index INTEGER
          )`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_polls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            poll_id TEXT UNIQUE,
            test_id INTEGER, telegram_id INTEGER, question_id INTEGER,
            question_number INTEGER,
            correct_option_id INTEGER, selected_option_id INTEGER,
            is_correct INTEGER DEFAULT 0, answered INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS test_sessions (
            test_id INTEGER, telegram_id INTEGER,
            started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            reminded INTEGER DEFAULT 0,
            PRIMARY KEY (test_id, telegram_id)
          )`),
        ]);

        // Eski bazalar uchun ustunlarni xavfsiz qo'shish
        const alters = [
          "ALTER TABLE users ADD COLUMN balance REAL DEFAULT 0",
          "ALTER TABLE tests ADD COLUMN price REAL DEFAULT 0",
          "ALTER TABLE tests ADD COLUMN timer INTEGER DEFAULT 0",
          "ALTER TABLE tests ADD COLUMN is_quiz INTEGER DEFAULT 0",
          "ALTER TABLE tests ADD COLUMN base_chat_id TEXT",
          "ALTER TABLE tests ADD COLUMN base_message_id INTEGER",
          "ALTER TABLE submissions ADD COLUMN wrong_questions TEXT",
          "ALTER TABLE test_sessions ADD COLUMN reminded INTEGER DEFAULT 0",
        ];
        for (const q of alters) { try { await env.DB.prepare(q).run(); } catch (e) {} }

        // Standart sozlamalar
        await env.DB.prepare(
          "INSERT INTO settings (key, value) VALUES ('bot_enabled','1') ON CONFLICT(key) DO NOTHING"
        ).run();

        return new Response("✅ Baza va barcha jadvallar muvaffaqiyatli yaratildi/yangilandi!", { status: 200 });
      } catch (e) {
        return new Response("Xato: " + e.message, { status: 500 });
      }
    }

    // ================= 2. WEBHOOK ULASH =================
    if (url.pathname === "/setup") {
      const webhookUrl = `https://${url.hostname}/`;
      const res = await setWebhook(env, webhookUrl);
      return new Response(JSON.stringify(res), { headers: { "Content-Type": "application/json" } });
    }

    // ================= 3. TELEGRAM YANGILANISHLARI =================
    if (request.method === "POST") {
      try {
        const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) {
          return new Response("Forbidden", { status: 403 });
        }
        const update = await request.json();
        await handleUpdate(update, env);
      } catch (err) {
        console.log("Global xato:", err.stack || err.message);
      }
      return new Response("OK", { status: 200 });
    }

    return new Response("🤖 Uzbek Test Bot — Cloudflare Workers'da muvaffaqiyatli ishlamoqda!", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledTasks(env));
  },
};

// ============================================================================
// ================= TELEGRAM API FUNKSIYALARI =================
// ============================================================================
function apiUrl(env, method) {
  return "https://api.telegram.org/bot" + env.BOT_TOKEN + "/" + method;
}

async function tgCall(env, method, payload) {
  try {
    const res = await fetch(apiUrl(env, method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) console.log(`Telegram xatosi [${method}]:`, JSON.stringify(data));
    return data;
  } catch (e) {
    console.log(`Tarmoq xatosi [${method}]:`, e.message);
    return { ok: false, description: e.message };
  }
}

async function sendMessage(env, chatId, text, replyMarkup = null, extra = {}) {
  const payload = { chat_id: chatId, text: text, parse_mode: "HTML", ...extra };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tgCall(env, "sendMessage", payload);
}

async function editMessageText(env, chatId, messageId, text, replyMarkup = null) {
  const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tgCall(env, "editMessageText", payload);
}

async function answerCallbackQuery(env, callbackQueryId, text = null, showAlert = false) {
  const payload = { callback_query_id: callbackQueryId };
  if (text) { payload.text = text; payload.show_alert = showAlert; }
  return tgCall(env, "answerCallbackQuery", payload);
}

async function sendDocument(env, chatId, fileId, caption = "", replyMarkup = null) {
  const payload = { chat_id: chatId, document: fileId, caption: caption, parse_mode: "HTML" };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tgCall(env, "sendDocument", payload);
}

async function sendPhoto(env, chatId, fileId, caption = "", replyMarkup = null) {
  const payload = { chat_id: chatId, photo: fileId, caption: caption, parse_mode: "HTML" };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tgCall(env, "sendPhoto", payload);
}

async function sendPoll(env, chatId, question, options, correctOptionId, extra = {}) {
  const payload = {
    chat_id: chatId,
    question: question.slice(0, 300),
    options: JSON.stringify(options.map((o) => String(o).slice(0, 100))),
    type: "quiz",
    correct_option_id: correctOptionId,
    is_anonymous: false,
    ...extra,
  };
  return tgCall(env, "sendPoll", payload);
}

async function deleteMessage(env, chatId, messageId) {
  return tgCall(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
}

async function getChatMember(env, chatId, userId) {
  return tgCall(env, "getChatMember", { chat_id: chatId, user_id: userId });
}

async function getChat(env, chatId) {
  return tgCall(env, "getChat", { chat_id: chatId });
}

async function setWebhook(env, url) {
  return tgCall(env, "setWebhook", {
    url: url,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query", "poll_answer"],
  });
}

// ============================================================================
// ================= D1 BAZA BILAN ISHLASH FUNKSIYALARI =================
// ============================================================================
async function getUser(env, telegramId) {
  return (await env.DB.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(telegramId).first()) || null;
}

async function ensureUser(env, telegramId) {
  let user = await getUser(env, telegramId);
  if (!user) {
    await env.DB.prepare(
      "INSERT INTO users (telegram_id, registered, state, balance) VALUES (?, 0, 'reg_name', 0)"
    ).bind(telegramId).run();
    user = await getUser(env, telegramId);
  } else {
    await env.DB.prepare("UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE telegram_id = ?").bind(telegramId).run();
  }
  return user;
}

async function setState(env, telegramId, state, stateData = null) {
  const stateStr = stateData ? JSON.stringify(stateData) : null;
  await env.DB.prepare("UPDATE users SET state = ?, state_data = ? WHERE telegram_id = ?").bind(state, stateStr, telegramId).run();
}

function getStateData(user) {
  try { return user.state_data ? JSON.parse(user.state_data) : {}; }
  catch { return {}; }
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
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value).run();
}

async function isBotEnabled(env) {
  const v = await getSetting(env, "bot_enabled");
  return v !== "0";
}

async function getChannels(env, type) {
  const { results } = await env.DB.prepare("SELECT * FROM channels WHERE type = ? ORDER BY id ASC").bind(type).all();
  return results || [];
}

async function getAllChannels(env) {
  const { results } = await env.DB.prepare("SELECT * FROM channels ORDER BY type, id ASC").all();
  return results || [];
}

async function addChannel(env, chatId, title, type, addedBy) {
  await env.DB.prepare("INSERT INTO channels (chat_id, title, type, added_by) VALUES (?, ?, ?, ?)")
    .bind(String(chatId), title, type, addedBy).run();
}

async function deleteChannelById(env, id) {
  await env.DB.prepare("DELETE FROM channels WHERE id = ?").bind(id).run();
}

async function getTestByCode(env, code) {
  return env.DB.prepare("SELECT * FROM tests WHERE code = ?").bind(code).first();
}

async function getTestById(env, id) {
  return env.DB.prepare("SELECT * FROM tests WHERE id = ?").bind(id).first();
}

async function getActiveTests(env) {
  const { results } = await env.DB
    .prepare("SELECT * FROM tests WHERE is_closed = 0 AND CURRENT_TIMESTAMP <= end_time ORDER BY start_time")
    .all();
  return results || [];
}

async function getSubmission(env, testId, telegramId) {
  return env.DB.prepare("SELECT * FROM submissions WHERE test_id = ? AND telegram_id = ?").bind(testId, telegramId).first();
}

async function getRanking(env, testId) {
  const { results } = await env.DB.prepare(
    `SELECT s.*, u.first_name, u.last_name, u.region, u.grade
     FROM submissions s JOIN users u ON u.telegram_id = s.telegram_id
     WHERE s.test_id = ? ORDER BY s.score DESC, s.submitted_at ASC`
  ).bind(testId).all();
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

// Testni va unga bog'liq BARCHA ma'lumotlarni ildizi bilan tozalash
async function deleteTestCascade(env, testId) {
  const test = await getTestById(env, testId);
  if (!test) return null;

  // Baza kanalidagi faylni ham o'chirishga urinamiz
  if (test.base_chat_id && test.base_message_id) {
    try { await deleteMessage(env, test.base_chat_id, test.base_message_id); } catch (e) {}
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM submissions WHERE test_id = ?").bind(testId),
    env.DB.prepare("DELETE FROM quiz_questions WHERE test_id = ?").bind(testId),
    env.DB.prepare("DELETE FROM user_polls WHERE test_id = ?").bind(testId),
    env.DB.prepare("DELETE FROM test_sessions WHERE test_id = ?").bind(testId),
    env.DB.prepare("DELETE FROM tests WHERE id = ?").bind(testId),
  ]);

  return test;
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
    } catch {
      missing.push(ch);
    }
  }
  return { ok: missing.length === 0, missing };
}

// ============================================================================
// ================= KLAVIATURALAR =================
// ============================================================================
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

function cancelKeyboard(extraRows = []) {
  return { inline_keyboard: [...extraRows, [{ text: "❌ Bekor qilish", callback_data: "cancel" }]] };
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
  return { inline_keyboard: [[{ text: "🏫 Maktab o'quvchisi", callback_data: "reg:level:maktab" }, { text: "🎓 Talaba", callback_data: "reg:level:talaba" }]] };
}

function gradeKeyboard() {
  const rows = [];
  for (let i = 1; i <= 11; i += 4) {
    const row = [];
    for (let g = i; g < i + 4 && g <= 11; g++) row.push({ text: g + "-sinf", callback_data: "reg:grade:" + g });
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

function courseKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "1-kurs", callback_data: "reg:grade:1-kurs" }, { text: "2-kurs", callback_data: "reg:grade:2-kurs" }],
      [{ text: "3-kurs", callback_data: "reg:grade:3-kurs" }, { text: "4-kurs", callback_data: "reg:grade:4-kurs" }],
    ],
  };
}

function studentMainMenu() {
  return {
    keyboard: [
      [{ text: "📝 Test tekshirish" }, { text: "📋 Faol testlar" }],
      [{ text: "🏆 Reyting" }, { text: "⚙️ Profil" }],
      [{ text: "💰 Hisobim" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function profileEditKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "✏️ Ismni o'zgartirish", callback_data: "profile:name" }],
      [{ text: "✏️ Familiyani o'zgartirish", callback_data: "profile:lastname" }],
      [{ text: "🌍 Viloyatni o'zgartirish", callback_data: "profile:region" }],
      [{ text: "🎓 Sinf/kursni o'zgartirish", callback_data: "profile:grade" }],
    ],
  };
}

function ratingMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🌍 Umumiy reyting", callback_data: "rating:general" }],
      [{ text: "🔑 Kod orqali test reytingi", callback_data: "rating:bycode" }],
    ],
  };
}

function adminMenuKeyboard(role, botEnabled) {
  const rows = [
    [{ text: "📊 Statistika", callback_data: "admin:stats" }],
    [{ text: "➕ Oddiy Test", callback_data: "admin:addtest" }, { text: "➕ Viktorina", callback_data: "admin:addquiz" }],
    [{ text: "📋 Mening testlarim", callback_data: "admin:mytests" }],
    [{ text: "🗑 Testni kod orqali o'chirish", callback_data: "admin:delbycode" }],
  ];
  if (role === "owner") {
    rows.push([{ text: "💳 Karta raqami", callback_data: "admin:setcard" }, { text: "💵 Balans to'ldirish", callback_data: "admin:addbalance" }]);
    rows.push([{ text: "📢 Kanallar", callback_data: "admin:channels" }, { text: "✉️ Xabar tarqatish", callback_data: "admin:broadcast" }]);
    rows.push([{ text: "👨‍🏫 Sub-adminlar", callback_data: "admin:subadmins" }]);
    rows.push([{ text: botEnabled ? "🟢 Bot: Yoqilgan (o'chirish)" : "🔴 Bot: O'chirilgan (yoqish)", callback_data: "admin:togglebot" }]);
  }
  return { inline_keyboard: rows };
}

function channelsMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "➕ Majburiy kanal qo'shish", callback_data: "chan:add:required" }],
      [{ text: "🗄 Baza kanalini belgilash", callback_data: "chan:add:base" }],
      [{ text: "🏆 Natijalar kanalini belgilash", callback_data: "chan:add:results" }],
      [{ text: "📋 Barcha kanallar ro'yxati", callback_data: "chan:listall" }],
      [{ text: "⬅️ Orqaga", callback_data: "admin:back" }],
    ],
  };
}

function pointsModeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Barchasiga bir xil ball", callback_data: "addtest:points:equal" }],
      [{ text: "Har biriga alohida ball", callback_data: "addtest:points:custom" }],
      [{ text: "❌ Bekor qilish", callback_data: "cancel" }],
    ],
  };
}

function testEditKeyboard(test) {
  const rows = [
    [{ text: "✏️ Nomini o'zgartirish", callback_data: `test:edit:subject:${test.id}` }],
    [{ text: "💰 Narxni o'zgartirish", callback_data: `test:edit:price:${test.id}` }],
  ];
  if (!test.is_quiz) rows.push([{ text: "🔑 Javoblarni almashtirish", callback_data: `test:edit:key:${test.id}` }]);
  rows.push([{ text: "📊 Joriy reyting", callback_data: `test:rank:${test.id}` }]);
  if (!test.is_closed) rows.push([{ text: "🏁 Yakunlash", callback_data: `test:finish:${test.id}` }]);
  rows.push([{ text: "🗑 Testni o'chirish", callback_data: `test:delete:${test.id}` }]);
  return { inline_keyboard: rows };
}

function subscriptionKeyboard(missing) {
  const rows = missing.map((ch) => [{ text: "➕ " + (ch.title || "Kanalga o'tish"), url: channelUrl(ch.chat_id) }]);
  rows.push([{ text: "✅ A'zo bo'ldim", callback_data: "check_sub" }]);
  return { inline_keyboard: rows };
}

function channelUrl(chatId) {
  const id = String(chatId);
  if (id.startsWith("@")) return "https://t.me/" + id.slice(1);
  if (id.startsWith("https://")) return id;
  if (id.startsWith("t.me/")) return "https://" + id;
  return "https://t.me/" + id.replace(/^-100/, "").replace(/^-/, "");
}

// ============================================================================
// ================= YORDAMCHI FUNKSIYALAR (VAQT, HISOB-KITOB) =================
// ============================================================================
async function generateTestCode(env) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const exists = await env.DB.prepare("SELECT id FROM tests WHERE code = ?").bind(code).first();
    if (!exists) return code;
  }
  return String(Date.now()).slice(-6);
}

function parseUserDateTime(str) {
  const m = str.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, d, mo, y, h, mi] = m;
  const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${mi}:00+05:00`;
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;
  return date.toISOString();
}

function formatDateTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  d.setHours(d.getHours() + 5);
  const pad = (n) => String(n).padStart(2, "0");
  return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + " " + pad(d.getUTCDate()) + "." + pad(d.getUTCMonth() + 1) + "." + d.getUTCFullYear();
}

function minutesUntil(iso) {
  return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
}

function formatMinutes(mins) {
  if (mins < 60) return mins + " daqiqa";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h + " soat " + m + " daqiqa";
}

function parseQuizBlock(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l);
  if (lines.length < 3) return null;

  const question = lines[0];
  const options = [];
  let correctIndex = -1;

  for (let i = 1; i < lines.length; i++) {
    let opt = lines[i];
    if (opt.endsWith("+")) {
      correctIndex = i - 1;
      opt = opt.slice(0, -1).trim();
    }
    options.push(opt);
  }

  if (correctIndex === -1 || options.length < 2 || options.length > 10) return null;
  return { question, options, correctIndex };
}

function shuffleQuizOptions(options, correctIndex) {
  const arr = options.map((opt, i) => ({ text: opt, isCorrect: i === correctIndex }));
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const newCorrectIndex = arr.findIndex((x) => x.isCorrect);
  return { shuffledOptions: arr.map((x) => x.text), newCorrectIndex };
}

function scoreAnswers(userAnswers, key, points) {
  const ua = userAnswers.toUpperCase().replace(/[^A-Z]/g, "");
  const k = key.toUpperCase();
  let score = 0, maxScore = 0, correctCount = 0;
  const wrongQuestions = [];

  for (let i = 0; i < k.length; i++) {
    const p = points[i] !== undefined ? points[i] : 1;
    maxScore += p;
    if (ua[i] && ua[i] === k[i]) {
      score += p;
      correctCount++;
    } else {
      wrongQuestions.push(i + 1);
    }
  }
  return { score, maxScore, correctCount, total: k.length, wrongQuestions };
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ============================================================================
// ================= RO'YXATDAN O'TISH =================
// ============================================================================
async function handleRegistrationText(env, user, text) {
  const chatId = user.telegram_id;
  const t = text.trim();

  if (user.state === "reg_name") {
    if (t.length < 2) { await sendMessage(env, chatId, "❗️ Ismingizni to'liq kiriting:"); return; }
    await updateUserFields(env, chatId, { first_name: t });
    await setState(env, chatId, "reg_lastname");
    await sendMessage(env, chatId, "Familiyangizni kiriting:");
    return;
  }

  if (user.state === "reg_lastname") {
    if (t.length < 2) { await sendMessage(env, chatId, "❗️ Familiyangizni to'liq kiriting:"); return; }
    await updateUserFields(env, chatId, { last_name: t });
    await setState(env, chatId, "reg_fathername");
    await sendMessage(env, chatId, "Otasining ismini kiriting:");
    return;
  }

  if (user.state === "reg_fathername") {
    if (t.length < 2) { await sendMessage(env, chatId, "❗️ Otasining ismini to'liq kiriting:"); return; }
    await updateUserFields(env, chatId, { father_name: t });
    await setState(env, chatId, "reg_region");
    await sendMessage(env, chatId, "🌍 Hududingizni tanlang:", regionKeyboard());
    return;
  }
}

async function handleRegistrationCallback(env, user, data) {
  const chatId = user.telegram_id;

  if (data.startsWith("reg:region:")) {
    const code = data.split(":")[2];
    await updateUserFields(env, chatId, { region: regionNameByCode(code) });
    await setState(env, chatId, "reg_level");
    await sendMessage(env, chatId, "🎓 Ta'lim darajangizni tanlang:", levelKeyboard());
    return true;
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

// ============================================================================
// ================= PROFIL =================
// ============================================================================
async function handleProfileCallback(env, user, data) {
  const chatId = user.telegram_id;
  if (data === "profile:name") { await setState(env, chatId, "profile_edit_name"); await sendMessage(env, chatId, "Yangi ismingizni kiriting:", cancelKeyboard()); return true; }
  if (data === "profile:lastname") { await setState(env, chatId, "profile_edit_lastname"); await sendMessage(env, chatId, "Yangi familiyangizni kiriting:", cancelKeyboard()); return true; }
  if (data === "profile:region") { await setState(env, chatId, "profile_edit_region"); await sendMessage(env, chatId, "Yangi hududingizni tanlang:", regionKeyboard()); return true; }
  if (data === "profile:grade") { await setState(env, chatId, "profile_edit_level"); await sendMessage(env, chatId, "Ta'lim darajangizni tanlang:", levelKeyboard()); return true; }
  return false;
}

async function handleProfileEditCallback(env, user, data) {
  const chatId = user.telegram_id;

  if (user.state === "profile_edit_region" && data.startsWith("reg:region:")) {
    const code = data.split(":")[2];
    await updateUserFields(env, chatId, { region: regionNameByCode(code), state: null, state_data: null });
    await sendMessage(env, chatId, "✅ Hudud yangilandi.", studentMainMenu());
    return true;
  }

  if (user.state === "profile_edit_level" && data.startsWith("reg:level:")) {
    const level = data.split(":")[2];
    await updateUserFields(env, chatId, { level });
    await setState(env, chatId, "profile_edit_grade");
    if (level === "maktab") await sendMessage(env, chatId, "Sinfingizni tanlang:", gradeKeyboard());
    else await sendMessage(env, chatId, "Kursingizni tanlang:", courseKeyboard());
    return true;
  }

  if (user.state === "profile_edit_grade" && data.startsWith("reg:grade:")) {
    const grade = data.split(":")[2];
    await updateUserFields(env, chatId, { grade, state: null, state_data: null });
    await sendMessage(env, chatId, "✅ Sinf/kurs yangilandi.", studentMainMenu());
    return true;
  }

  return false;
}

async function handleProfileEditText(env, user, text) {
  const chatId = user.telegram_id;
  const t = text.trim();

  if (user.state === "profile_edit_name") {
    if (t.length < 2) { await sendMessage(env, chatId, "❗️ To'liq kiriting:", cancelKeyboard()); return true; }
    await updateUserFields(env, chatId, { first_name: t, state: null, state_data: null });
    await sendMessage(env, chatId, "✅ Ism yangilandi.", studentMainMenu());
    return true;
  }
  if (user.state === "profile_edit_lastname") {
    if (t.length < 2) { await sendMessage(env, chatId, "❗️ To'liq kiriting:", cancelKeyboard()); return true; }
    await updateUserFields(env, chatId, { last_name: t, state: null, state_data: null });
    await sendMessage(env, chatId, "✅ Familiya yangilandi.", studentMainMenu());
    return true;
  }
  return false;
}

// ============================================================================
// ================= REYTING =================
// ============================================================================
async function showGeneralRating(env, chatId) {
  const { results } = await env.DB.prepare(
    `SELECT u.telegram_id, u.first_name, u.last_name, SUM(s.score) as total_score
     FROM submissions s JOIN users u ON u.telegram_id = s.telegram_id
     GROUP BY u.telegram_id ORDER BY total_score DESC LIMIT 10`
  ).all();

  let msg = "🌍 <b>Umumiy TOP-10 reyting (barcha testlar bo'yicha):</b>\n\n";
  if (!results || results.length === 0) {
    msg += "Hali reyting shakllanmagan.";
  } else {
    results.forEach((r, i) => {
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
      msg += `${medal} ${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)} — <b>${r.total_score} ball</b>\n`;
    });
  }

  const myScore = await env.DB.prepare("SELECT SUM(score) as s FROM submissions WHERE telegram_id = ?").bind(chatId).first();
  msg += `\n🏅 Sizning umumiy to'plagan ballingiz: <b>${myScore && myScore.s ? myScore.s : 0}</b>`;
  await sendMessage(env, chatId, msg, studentMainMenu());
}

async function showTestRanking(env, chatId, testCode, viewerIsAdmin = false) {
  const test = await getTestByCode(env, testCode);
  if (!test) { await sendMessage(env, chatId, "❌ Bunday kodli test topilmadi.", viewerIsAdmin ? undefined : studentMainMenu()); return; }

  const ranking = await getRanking(env, test.id);
  let msg = `🏆 <b>"${escapeHtml(test.subject || test.code)}"</b> testi reytingi:\n\n`;
  if (ranking.length === 0) {
    msg += "Hali hech kim bu testni ishlamagan.";
  } else {
    ranking.slice(0, 15).forEach((r, i) => {
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
      msg += `${medal} ${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)} — <b>${r.score}/${r.max_score}</b>\n`;
    });
    if (!viewerIsAdmin) {
      const myPlace = ranking.findIndex((r) => r.telegram_id === chatId) + 1;
      if (myPlace > 0) msg += `\n🏅 Sizning o'rningiz: <b>${myPlace}</b> (${ranking.length} qatnashuvchidan)`;
    }
  }
  await sendMessage(env, chatId, msg, viewerIsAdmin ? undefined : studentMainMenu());
}

// ============================================================================
// ================= ASOSIY MENYU (O'QUVCHI) =================
// ============================================================================
async function handleMainMenuText(env, user, text) {
  const chatId = user.telegram_id;
  const t = text.trim();

  if (t === "📝 Test tekshirish") {
    await setState(env, chatId, "waiting_test_code");
    await sendMessage(env, chatId, "🔑 Test kodini yuboring (masalan: 1234):", cancelKeyboard());
    return true;
  }

  if (t === "📋 Faol testlar") {
    const tests = await getActiveTests(env);
    if (tests.length === 0) { await sendMessage(env, chatId, "Hozircha faol testlar yo'q."); return true; }
    let msg = "📋 <b>Faol testlar:</b>\n\n";
    tests.forEach((tst, i) => {
      const type = tst.is_quiz ? "🎮 Viktorina" : "📄 Oddiy test";
      const pText = tst.price > 0 ? `(💰 ${tst.price} so'm)` : "(🎁 Bepul)";
      msg += `${i + 1}. <b>${escapeHtml(tst.subject || "Test")}</b> ${pText} [${type}]\n🔑 Kodi: <b>${tst.code}</b>\n⏱ Taymer: ${tst.timer ? tst.timer + " daqiqa" : "Yo'q"}\n⏰ Tugash: ${formatDateTime(tst.end_time)}\n\n`;
    });
    await sendMessage(env, chatId, msg);
    return true;
  }

  if (t === "🏆 Reyting") {
    await sendMessage(env, chatId, "🏆 Qaysi reytingni ko'rmoqchisiz?", ratingMenuKeyboard());
    return true;
  }

  if (t === "⚙️ Profil") {
    const msg = `👤 <b>Sizning profilingiz:</b>\n\nIsm: ${escapeHtml(user.first_name) || "-"}\nFamiliya: ${escapeHtml(user.last_name) || "-"}\nOtasining ismi: ${escapeHtml(user.father_name) || "-"}\nViloyat: ${escapeHtml(user.region) || "-"}\nSinf/Kurs: ${escapeHtml(user.grade) || "-"}\n\n💳 Hisobingiz: <b>${user.balance || 0} so'm</b>\n\nNimani o'zgartiramiz?`;
    await sendMessage(env, chatId, msg, profileEditKeyboard());
    return true;
  }

  if (t === "💰 Hisobim") {
    const card = await getSetting(env, "admin_card") || "Hali kiritilmagan";
    const msg = `💳 <b>Sizning hisobingiz:</b> ${user.balance || 0} so'm\n\nHisobni to'ldirish uchun ushbu kartaga pul o'tkazing:\n<code>${escapeHtml(card)}</code>\n\nTo'lov qilganingizdan so'ng qancha pul o'tkazganingizni yozib yuboring (faqat raqam bilan, masalan: 5000):`;
    await setState(env, chatId, "waiting_deposit_amount");
    await sendMessage(env, chatId, msg, cancelKeyboard());
    return true;
  }

  return false;
}

// ============================================================================
// ================= TEST VA VIKTORINANI ISHLASH =================
// ============================================================================
async function checkTestTimer(env, testId, telegramId) {
  const test = await env.DB.prepare("SELECT timer FROM tests WHERE id = ?").bind(testId).first();
  if (!test || !test.timer) return true;

  const session = await env.DB.prepare("SELECT started_at FROM test_sessions WHERE test_id = ? AND telegram_id = ?").bind(testId, telegramId).first();
  if (!session) return true;

  const elapsedMinutes = (Date.now() - new Date(session.started_at + "Z").getTime()) / 60000;
  return elapsedMinutes <= test.timer;
}

async function handleTestCode(env, user, code) {
  const chatId = user.telegram_id;
  const cleanCode = code.trim();
  const test = await getTestByCode(env, cleanCode);

  if (!test) { await sendMessage(env, chatId, "❌ Bunday kodli test topilmadi. Qaytadan urinib ko'ring:", cancelKeyboard()); return; }

  const now = new Date();
  const start = new Date(test.start_time);
  const end = new Date(test.end_time);

  if (test.is_closed || now > end) {
    await sendMessage(env, chatId, "⛔️ Bu testning muddati allaqachon tugagan yoki yakunlangan.", studentMainMenu());
    await setState(env, chatId, null);
    return;
  }

  if (now < start) {
    await sendMessage(env, chatId, "⏳ Bu test hali boshlanmagan. Boshlanish vaqti: " + formatDateTime(test.start_time), cancelKeyboard());
    return;
  }

  const existing = await getSubmission(env, test.id, chatId);
  if (existing) {
    await sendMessage(env, chatId, "⚠️ Siz bu testni allaqachon ishlagansiz.", studentMainMenu());
    await setState(env, chatId, null);
    return;
  }

  // 💰 To'lovni tekshirish
  if (test.price > 0) {
    if ((user.balance || 0) < test.price) {
      await sendMessage(env, chatId, `❗️ Bu test pullik. Test narxi: <b>${test.price} so'm</b>.\nSizning hisobingizda <b>${user.balance || 0} so'm</b> mavjud.\n\nIltimos, "💰 Hisobim" bo'limi orqali hisobingizni to'ldiring.`, studentMainMenu());
      await setState(env, chatId, null);
      return;
    }
    await env.DB.prepare("UPDATE users SET balance = balance - ? WHERE telegram_id = ?").bind(test.price, chatId).run();
    await sendMessage(env, chatId, `💸 Hisobingizdan test uchun ${test.price} so'm yechib olindi.`);
  }

  // ⏱ Shaxsiy taymerni boshlash
  await env.DB.prepare(
    "INSERT INTO test_sessions (test_id, telegram_id) VALUES (?, ?) ON CONFLICT(test_id, telegram_id) DO UPDATE SET started_at = CURRENT_TIMESTAMP, reminded = 0"
  ).bind(test.id, chatId).run();

  if (test.is_quiz) {
    await sendMessage(env, chatId, `🎮 <b>Viktorina boshlandi!</b>${test.timer ? "\n⏱ Sizda <b>" + test.timer + " daqiqa</b> vaqt bor." : ""}`);
    await sendNextQuizQuestion(env, chatId, test.id);
  } else {
    const caption = `📄 Sizga test taqdim etildi.\n⏱ Vaqtingiz: <b>${test.timer > 0 ? test.timer + " daqiqa" : "Cheklanmagan"}</b>.\n\n✏️ Javoblaringizni bitta xabar qilib yuboring (masalan: <code>abcdabcd...</code>)`;
    if (test.file_type === "photo") await sendPhoto(env, chatId, test.file_id, caption, cancelKeyboard());
    else await sendDocument(env, chatId, test.file_id, caption, cancelKeyboard());
    await setState(env, chatId, "waiting_answers:" + test.id);
  }
}

async function sendNextQuizQuestion(env, chatId, testId) {
  const test = await getTestById(env, testId);
  const now = new Date();

  const isTimeOk = await checkTestTimer(env, testId, chatId);
  if (!isTimeOk || (test && now > new Date(test.end_time))) {
    await finishQuizTest(env, chatId, testId, true);
    return;
  }

  const questions = await env.DB.prepare("SELECT * FROM quiz_questions WHERE test_id = ? ORDER BY id ASC").bind(testId).all();
  const answered = await env.DB.prepare("SELECT question_id FROM user_polls WHERE test_id = ? AND telegram_id = ?").bind(testId, chatId).all();
  const answeredIds = (answered.results || []).map((r) => r.question_id);

  const allQuestions = questions.results || [];
  const nextQ = allQuestions.find((q) => !answeredIds.includes(q.id));

  if (!nextQ) {
    await finishQuizTest(env, chatId, testId, false);
    return;
  }

  const questionNumber = answeredIds.length + 1;
  const totalQuestions = allQuestions.length;
  const options = JSON.parse(nextQ.options);
  const shuffled = shuffleQuizOptions(options, nextQ.correct_index);

  const res = await sendPoll(
    env, chatId,
    `(${questionNumber}/${totalQuestions}) ${nextQ.question}`,
    shuffled.shuffledOptions, shuffled.newCorrectIndex,
    { reply_markup: cancelKeyboard() }
  );

  if (res.ok) {
    await env.DB.prepare(
      `INSERT INTO user_polls (poll_id, test_id, telegram_id, question_id, question_number, correct_option_id, answered)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    ).bind(res.result.poll.id, testId, chatId, nextQ.id, questionNumber, shuffled.newCorrectIndex).run();
  }
}

async function handlePollAnswer(env, pollAnswer) {
  const pollId = pollAnswer.poll_id;
  const userId = pollAnswer.user.id;
  const selected = Array.isArray(pollAnswer.option_ids) && pollAnswer.option_ids.length > 0 ? pollAnswer.option_ids[0] : null;

  const pollData = await env.DB.prepare("SELECT * FROM user_polls WHERE poll_id = ?").bind(pollId).first();
  if (!pollData || pollData.answered) return;

  const isCorrect = selected !== null && selected === pollData.correct_option_id ? 1 : 0;
  await env.DB.prepare("UPDATE user_polls SET answered = 1, selected_option_id = ?, is_correct = ? WHERE poll_id = ?")
    .bind(selected, isCorrect, pollId).run();

  const isTimeOk = await checkTestTimer(env, pollData.test_id, userId);
  if (!isTimeOk) { await finishQuizTest(env, userId, pollData.test_id, true); return; }

  const existing = await getSubmission(env, pollData.test_id, userId);
  if (existing) return;

  await sendNextQuizQuestion(env, userId, pollData.test_id);
}

async function finishQuizTest(env, telegramId, testId, timeout = false) {
  const existing = await getSubmission(env, testId, telegramId);
  if (existing) return;

  const test = await getTestById(env, testId);
  if (!test) return;

  const points = JSON.parse(test.points || "[]");
  const totalQuestions = points.length;

  const { results: polls } = await env.DB.prepare(
    "SELECT * FROM user_polls WHERE test_id = ? AND telegram_id = ? ORDER BY question_number ASC"
  ).bind(testId, telegramId).all();

  let correctCount = 0, score = 0;
  const wrongQuestions = [];
  const pollByNumber = {};
  (polls || []).forEach((p) => { pollByNumber[p.question_number] = p; });

  for (let i = 0; i < totalQuestions; i++) {
    const qNum = i + 1;
    const p = pollByNumber[qNum];
    const pts = points[i] !== undefined ? points[i] : 1;
    if (p && p.is_correct) { correctCount++; score += pts; }
    else wrongQuestions.push(qNum);
  }

  const maxScore = points.reduce((a, b) => a + b, 0);

  await env.DB.prepare(
    `INSERT INTO submissions (test_id, telegram_id, answers, correct_count, total_count, score, max_score, wrong_questions)
     VALUES (?, ?, 'QUIZ', ?, ?, ?, ?, ?)`
  ).bind(testId, telegramId, correctCount, totalQuestions, score, maxScore, JSON.stringify(wrongQuestions)).run();

  const prefix = timeout
    ? "⏰ <b>Vaqt tugadi!</b> Viktorina yakunlandi."
    : "🎉 <b>Viktorina yakunlandi!</b> Barcha savollarga javob berdingiz.";

  await sendResultAndChannel(env, telegramId, testId, correctCount, totalQuestions, score, maxScore, wrongQuestions, prefix);
}

async function handleAnswerSubmission(env, user, testId, answerText) {
  const chatId = user.telegram_id;
  const test = await getTestById(env, testId);
  if (!test) { await setState(env, chatId, null); return; }

  const isTimeOk = await checkTestTimer(env, testId, chatId);
  if (!isTimeOk) {
    await sendMessage(env, chatId, "⏰ <b>Vaqt tugadi!</b> Shaxsiy taymeringiz yakuniga yetdi. Javoblar qabul qilinmadi.", studentMainMenu());
    await setState(env, chatId, null);
    return;
  }

  const now = new Date();
  const end = new Date(test.end_time);
  if (test.is_closed || now > end) {
    await sendMessage(env, chatId, "⛔️ Afsuski, testning umumiy muddati tugagan.", studentMainMenu());
    await setState(env, chatId, null);
    return;
  }

  const existing = await getSubmission(env, testId, chatId);
  if (existing) { await sendMessage(env, chatId, "⚠️ Siz allaqachon javob yubordingiz.", studentMainMenu()); await setState(env, chatId, null); return; }

  const cleaned = answerText.replace(/[^a-zA-Z]/g, "");
  if (cleaned.length === 0) { await sendMessage(env, chatId, "❗️ Iltimos, javoblarni harflar bilan yuboring (masalan: abcd...):", cancelKeyboard()); return; }

  const points = JSON.parse(test.points || "[]");
  const result = scoreAnswers(cleaned, test.answer_key, points);

  await env.DB.prepare(
    `INSERT INTO submissions (test_id, telegram_id, answers, correct_count, total_count, score, max_score, wrong_questions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(testId, chatId, cleaned.toUpperCase(), result.correctCount, result.total, result.score, result.maxScore, JSON.stringify(result.wrongQuestions)).run();
  await setState(env, chatId, null);

  await sendResultAndChannel(env, chatId, testId, result.correctCount, result.total, result.score, result.maxScore, result.wrongQuestions);
}

async function sendResultAndChannel(env, telegramId, testId, correctCount, total, score, maxScore, wrongQuestions, prefix = "✅ <b>Natijangiz tayyor!</b>") {
  const user = await getUser(env, telegramId);
  const test = await getTestById(env, testId);
  const ranking = await getRanking(env, testId);
  const place = ranking.findIndex((r) => r.telegram_id === telegramId) + 1;
  const percent = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  const wrongList = wrongQuestions.length > 0 ? wrongQuestions.join(", ") : "yo'q 🎉";

  const studentMsg = `${prefix}\n\n📊 Ball: <b>${score} / ${maxScore}</b> (${percent}%)\n✔️ To'g'ri javoblar: ${correctCount} / ${total}\n❌ Xato savollar: ${wrongList}\n🏆 Reyting: <b>${place}-o'rin</b> (${ranking.length} qatnashuvchidan)`;
  await sendMessage(env, telegramId, studentMsg, studentMainMenu());

  const resultsChannels = await getChannels(env, "results");
  if (resultsChannels.length > 0) {
    const channelMsg = `🆕 <b>Yangi natija</b>\n👤 ${escapeHtml(user.first_name)} ${escapeHtml(user.last_name)}\n🌍 ${escapeHtml(user.region)} | ${escapeHtml(user.grade)}\n📘 Test: ${escapeHtml(test.subject || test.code)} [${test.is_quiz ? "🎮 Viktorina" : "📄 Oddiy"}]\n📊 Ball: ${score}/${maxScore} (${percent}%)\n🏆 O'rin: ${place}\n🕒 ${formatDateTime(new Date().toISOString())}`;
    for (const ch of resultsChannels) await sendMessage(env, ch.chat_id, channelMsg);
  }
}

// ============================================================================
// ================= ADMIN PANEL =================
// ============================================================================
async function showAdminMenu(env, chatId, role) {
  const enabled = await isBotEnabled(env);
  await sendMessage(env, chatId, "👑 <b>Admin panel</b>\n\nKerakli bo'limni tanlang:", adminMenuKeyboard(role, enabled));
}

async function handleAdminCallback(env, user, data, role) {
  const chatId = user.telegram_id;

  if (data === "admin:back") { await showAdminMenu(env, chatId, role); return true; }

  if (data === "admin:stats") {
    const total = await countUsers(env);
    const today = await countUsersToday(env);
    const testsCount = await env.DB.prepare("SELECT COUNT(*) as c FROM tests").first();
    const activeCount = (await getActiveTests(env)).length;
    const subCount = await env.DB.prepare("SELECT COUNT(*) as c FROM submissions").first();
    const enabled = await isBotEnabled(env);
    await sendMessage(env, chatId,
      `📊 <b>Statistika</b>\n\n👥 Jami ro'yxatdan o'tganlar: <b>${total}</b>\n🆕 Bugun qo'shilganlar: <b>${today}</b>\n📚 Jami testlar: <b>${testsCount.c}</b>\n🟢 Faol testlar: <b>${activeCount}</b>\n✍️ Jami topshirilgan javoblar: <b>${subCount.c}</b>`,
      adminMenuKeyboard(role, enabled));
    return true;
  }

  // ---------- Test yaratish ----------
  if (data === "admin:addtest") {
    const baseChannels = await getChannels(env, "base");
    if (baseChannels.length === 0) { await sendMessage(env, chatId, "⚠️ Avval Baza kanali belgilanishi kerak. Owner administratordan so'rang."); return true; }
    await setState(env, chatId, "admin_awaiting_file");
    await sendMessage(env, chatId, `📤 Oddiy test faylini (PDF yoki rasm ko'rinishida) shu yerga — <b>botga to'g'ridan-to'g'ri</b> yuboring.\nBot uni o'zi <b>${escapeHtml(baseChannels[0].title || baseChannels[0].chat_id)}</b> kanaliga joylab qo'yadi.`, cancelKeyboard());
    return true;
  }

  if (data === "admin:addquiz") {
    const code = await generateTestCode(env);
    const res = await env.DB.prepare(
      `INSERT INTO tests (code, file_id, file_type, created_by, start_time, end_time, answer_key, points, is_quiz, is_closed)
       VALUES (?, '', 'quiz', ?, datetime('now'), datetime('now'), '', '[]', 1, 1)`
    ).bind(code, chatId).run();
    await setState(env, chatId, "admin_quiz_subject", { testId: res.meta.last_row_id });
    await sendMessage(env, chatId, `🎮 Yangi Viktorina yaratilmoqda. Maxsus kod: <b>${code}</b>\n\nViktorina fani/mavzusini kiriting:`, cancelKeyboard());
    return true;
  }

  if (data === "admin:mytests") {
    const query = role === "owner"
      ? env.DB.prepare("SELECT * FROM tests ORDER BY created_at DESC LIMIT 15")
      : env.DB.prepare("SELECT * FROM tests WHERE created_by = ? ORDER BY created_at DESC LIMIT 15").bind(chatId);
    const { results } = await query.all();
    if (!results || results.length === 0) { await sendMessage(env, chatId, "Hozircha testlar mavjud emas.", adminMenuKeyboard(role, await isBotEnabled(env))); return true; }

    await sendMessage(env, chatId, `📋 <b>${role === "owner" ? "Barcha testlar" : "Sizning testlaringiz"}:</b>`);
    for (const t of results) {
      const subCount = await env.DB.prepare("SELECT COUNT(*) as c FROM submissions WHERE test_id = ?").bind(t.id).first();
      const msg = `📘 <b>${escapeHtml(t.subject || "Test")}</b> [${t.is_quiz ? "🎮 Quiz" : "📄 Oddiy"}]\n🔑 Kodi: <b>${t.code}</b>\n💰 Narxi: ${t.price || 0} so'm\n⏱ Taymer: ${t.timer ? t.timer + " daqiqa" : "Yo'q"}\n⏰ ${formatDateTime(t.start_time)} — ${formatDateTime(t.end_time)}\n✍️ Ishlaganlar: ${subCount.c}\n📌 Holati: ${t.is_closed ? "🔴 Yopiq" : "🟢 Faol"}`;
      await sendMessage(env, chatId, msg, testEditKeyboard(t));
    }
    return true;
  }

  // ---------- Testni tahrirlash / yakunlash / o'chirish ----------
  if (data.startsWith("test:edit:subject:")) {
    const testId = data.split(":")[3];
    const t = await getTestById(env, testId);
    if (!(await canManageTest(env, chatId, role, t))) { await sendMessage(env, chatId, "⛔️ Bu sizning testingiz emas."); return true; }
    await setState(env, chatId, `admin_edit_subject:${testId}`);
    await sendMessage(env, chatId, "Yangi fani/mavzusini kiriting:", cancelKeyboard());
    return true;
  }

  if (data.startsWith("test:edit:price:")) {
    const testId = data.split(":")[3];
    const t = await getTestById(env, testId);
    if (!(await canManageTest(env, chatId, role, t))) { await sendMessage(env, chatId, "⛔️ Bu sizning testingiz emas."); return true; }
    await setState(env, chatId, `admin_edit_price:${testId}`);
    await sendMessage(env, chatId, "Yangi narxni kiriting (Bepul bo'lsa 0):", cancelKeyboard());
    return true;
  }

  if (data.startsWith("test:edit:key:")) {
    const testId = data.split(":")[3];
    const t = await getTestById(env, testId);
    if (!(await canManageTest(env, chatId, role, t))) { await sendMessage(env, chatId, "⛔️ Bu sizning testingiz emas."); return true; }
    await setState(env, chatId, `admin_edit_key:${testId}`);
    await sendMessage(env, chatId, "Yangi javoblar kalitini kiriting (Masalan: ABCD...):", cancelKeyboard());
    return true;
  }

  if (data.startsWith("test:rank:")) {
    const testId = data.split(":")[2];
    const t = await getTestById(env, testId);
    if (!t) { await sendMessage(env, chatId, "❌ Test topilmadi."); return true; }
    await showTestRanking(env, chatId, t.code, true);
    return true;
  }

  if (data.startsWith("test:finish:")) {
    const testId = data.split(":")[2];
    const t = await getTestById(env, testId);
    if (!t) { await sendMessage(env, chatId, "❌ Test topilmadi."); return true; }
    if (!(await canManageTest(env, chatId, role, t))) { await sendMessage(env, chatId, "⛔️ Bu sizning testingiz emas."); return true; }
    await adminFinishTest(env, testId);
    await sendMessage(env, chatId, "✅ Test yakunlandi. Yakuniy reyting Natijalar kanaliga yuborildi.", adminMenuKeyboard(role, await isBotEnabled(env)));
    return true;
  }

  if (data.startsWith("test:delete:")) {
    const testId = data.split(":")[2];
    const t = await getTestById(env, testId);
    if (!t) { await sendMessage(env, chatId, "❌ Test topilmadi."); return true; }
    if (!(await canManageTest(env, chatId, role, t))) { await sendMessage(env, chatId, "⛔️ Bu sizning testingiz emas."); return true; }
    await askDeleteConfirm(env, chatId, t);
    return true;
  }

  if (data.startsWith("test:delconfirm:")) {
    const testId = data.split(":")[2];
    const t = await getTestById(env, testId);
    if (!t) { await sendMessage(env, chatId, "❌ Test allaqachon o'chirilgan."); return true; }
    if (!(await canManageTest(env, chatId, role, t))) { await sendMessage(env, chatId, "⛔️ Bu sizning testingiz emas."); return true; }
    await deleteTestCascade(env, testId);
    await sendMessage(env, chatId, "🗑 Test va unga bog'liq barcha ma'lumotlar (javoblar, savollar, sessiyalar) to'liq o'chirildi. Fayl Baza kanalidan ham olib tashlandi.", adminMenuKeyboard(role, await isBotEnabled(env)));
    return true;
  }

  if (data === "admin:delbycode") {
    await setState(env, chatId, "admin_delete_by_code");
    await sendMessage(env, chatId, "🗑 O'chirmoqchi bo'lgan testning kodini kiriting:", cancelKeyboard());
    return true;
  }

  if (data.startsWith("addtest:points:")) {
    const mode = data.split(":")[2];
    const stateData = getStateData(user);
    if (mode === "equal") {
      await setState(env, chatId, "admin_test_points_equal", stateData);
      await sendMessage(env, chatId, "Bitta savol uchun necha ball bermoqchisiz (masalan: 1):", cancelKeyboard());
    } else {
      await setState(env, chatId, "admin_test_points_custom", stateData);
      await sendMessage(env, chatId, "Ballarni vergul bilan kiriting (masalan: 1,2,1):", cancelKeyboard());
    }
    return true;
  }

  // ---------- Faqat OWNER uchun bo'limlar ----------
  if (role !== "owner") return false;

  if (data === "admin:channels") { await sendMessage(env, chatId, "📢 <b>Kanallarni boshqarish</b>", channelsMenuKeyboard()); return true; }

  if (data.startsWith("chan:add:")) {
    const type = data.split(":")[2];
    await setState(env, chatId, "admin_channel_add", { type });
    const typeName = type === "required" ? "Majburiy" : type === "base" ? "Baza" : "Natijalar";
    await sendMessage(env, chatId,
      `➕ <b>${typeName}</b> kanal qo'shish:\n\n1) Botni ushbu kanalga <b>administrator</b> qilib tayinlang.\n2) Kanaldan istalgan xabarni shu chatga <b>forward</b> qiling YOKI kanal <b>@username</b>'ini yuboring.`,
      cancelKeyboard());
    return true;
  }

  if (data === "chan:listall") {
    const all = await getAllChannels(env);
    if (all.length === 0) { await sendMessage(env, chatId, "📋 Hozircha hech qanday kanal qo'shilmagan.", channelsMenuKeyboard()); return true; }

    const typeNames = { required: "📢 Majburiy", base: "🗄 Baza", results: "🏆 Natijalar" };
    const grouped = { required: [], base: [], results: [] };
    all.forEach((c) => { if (grouped[c.type]) grouped[c.type].push(c); });

    let msg = "📋 <b>Barcha kanallar:</b>\n\n";
    const rows = [];
    for (const type of ["required", "base", "results"]) {
      msg += `<b>${typeNames[type]}:</b>\n`;
      if (grouped[type].length === 0) msg += "— belgilanmagan —\n";
      else grouped[type].forEach((c) => { msg += `• ${escapeHtml(c.title || c.chat_id)}\n`; rows.push([{ text: `🗑 ${c.title || c.chat_id}`, callback_data: `chan:del:${c.id}` }]); });
      msg += "\n";
    }
    rows.push([{ text: "⬅️ Orqaga", callback_data: "admin:channels" }]);
    await sendMessage(env, chatId, msg, { inline_keyboard: rows });
    return true;
  }

  if (data.startsWith("chan:del:")) {
    const id = data.split(":")[2];
    await deleteChannelById(env, id);
    await answerCallbackQuery(env, user.callback_query_id, "🗑 Kanal o'chirildi.");
    await sendMessage(env, chatId, "✅ Kanal ro'yxatdan o'chirildi.", channelsMenuKeyboard());
    return true;
  }

  if (data === "admin:broadcast") {
    await setState(env, chatId, "admin_broadcast_waiting");
    await sendMessage(env, chatId, "✉️ Barcha foydalanuvchilarga yuboriladigan xabar matnini kiriting:", cancelKeyboard());
    return true;
  }

  if (data === "admin:togglebot") {
    const current = await isBotEnabled(env);
    await setSetting(env, "bot_enabled", current ? "0" : "1");
    const enabled = !current;
    await sendMessage(env, chatId, enabled ? "🟢 Bot yoqildi. Foydalanuvchilar botdan foydalanishlari mumkin." : "🔴 Bot o'chirildi. Endi faqat siz botdan foydalana olasiz.", adminMenuKeyboard(role, enabled));
    return true;
  }

  if (data === "admin:subadmins") {
    const { results } = await env.DB.prepare("SELECT * FROM admins WHERE role = 'admin'").all();
    let msg = "👨‍🏫 <b>Sub-adminlar ro'yxati:</b>\n\n";
    const rows = [];
    if (!results || results.length === 0) msg += "Hali sub-admin qo'shilmagan.";
    else results.forEach((r) => { msg += `• ${escapeHtml(r.name) || r.telegram_id} (ID: <code>${r.telegram_id}</code>)\n`; rows.push([{ text: `🗑 O'chirish: ${r.telegram_id}`, callback_data: `subadmin:del:${r.telegram_id}` }]); });
    msg += "\n\n➕ Yangi sub-admin qo'shish uchun uning Telegram ID raqamini yuboring:";
    rows.push([{ text: "❌ Bekor qilish", callback_data: "cancel" }]);
    await setState(env, chatId, "admin_subadmin_add");
    await sendMessage(env, chatId, msg, { inline_keyboard: rows });
    return true;
  }

  if (data.startsWith("subadmin:del:")) {
    const id = data.split(":")[2];
    await env.DB.prepare("DELETE FROM admins WHERE telegram_id = ? AND role = 'admin'").bind(id).run();
    await sendMessage(env, chatId, `✅ Sub-admin (ID: ${id}) o'chirildi.`, adminMenuKeyboard(role, await isBotEnabled(env)));
    return true;
  }

  if (data === "admin:setcard") {
    await setState(env, chatId, "admin_setcard");
    await sendMessage(env, chatId, "💳 Karta raqamini va ism-sharifni kiriting:\n(Masalan: 8600 1234 5678 9012 - Palonchiyev P)", cancelKeyboard());
    return true;
  }

  if (data === "admin:addbalance") {
    await setState(env, chatId, "admin_addbalance_id");
    await sendMessage(env, chatId, "💰 Pul qo'shmoqchi bo'lgan foydalanuvchi Telegram ID sini kiriting:", cancelKeyboard());
    return true;
  }

  return false;
}

async function canManageTest(env, chatId, role, test) {
  if (!test) return false;
  if (role === "owner") return true;
  return String(test.created_by) === String(chatId);
}

async function askDeleteConfirm(env, chatId, test) {
  await sendMessage(env, chatId,
    `⚠️ <b>Diqqat!</b> "${escapeHtml(test.subject || test.code)}" (kod: ${test.code}) testini butunlay o'chirmoqchimisiz?\n\nBarcha javoblar, savollar va sessiyalar qaytarib bo'lmas tarzda o'chiriladi, fayl Baza kanalidan ham olib tashlanadi.`,
    { inline_keyboard: [[{ text: "✅ Ha, o'chirish", callback_data: `test:delconfirm:${test.id}` }, { text: "❌ Bekor qilish", callback_data: "cancel" }]] });
}

async function adminFinishTest(env, testId) {
  await env.DB.prepare("UPDATE tests SET is_closed = 1 WHERE id = ?").bind(testId).run();
  const test = await getTestById(env, testId);
  const ranking = await getRanking(env, testId);

  let msg = `🏁 <b>"${escapeHtml(test.subject || test.code)}"</b> testi yakunlandi!\n\n🏆 <b>Yakuniy Reyting:</b>\n`;
  if (ranking.length === 0) msg += "Hech kim ishlamadi.";
  else ranking.slice(0, 15).forEach((r, i) => {
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
    msg += `${medal} ${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)} — <b>${r.score}/${r.max_score}</b> ball\n`;
  });

  const resultsChannels = await getChannels(env, "results");
  for (const ch of resultsChannels) await sendMessage(env, ch.chat_id, msg);
}

// Test faylini Baza kanaliga joylash
async function postTestFileToChannel(env, baseChatId, fileId, fileType, caption) {
  const res = fileType === "photo"
    ? await sendPhoto(env, baseChatId, fileId, caption)
    : await sendDocument(env, baseChatId, fileId, caption);
  if (!res.ok) return null;
  return res.result.message_id;
}

async function handleIncomingTestFile(env, chatId, fileId, fileType) {
  const baseChannels = await getChannels(env, "base");
  if (baseChannels.length === 0) {
    await sendMessage(env, chatId, "⚠️ Baza kanali topilmadi. Owner administrator kanalni belgilashi kerak.");
    return;
  }
  const baseChannel = baseChannels[0];
  const code = await generateTestCode(env);
  const caption = `🆕 <b>Yangi test yuklandi</b>\n🔑 Kodi: <b>${code}</b>`;

  const messageId = await postTestFileToChannel(env, baseChannel.chat_id, fileId, fileType, caption);
  if (!messageId) {
    await sendMessage(env, chatId, "❌ Faylni Baza kanaliga joylab bo'lmadi. Botni o'sha kanalga <b>administrator</b> qilib qo'yganingizni tekshiring va qayta urinib ko'ring.", cancelKeyboard());
    return;
  }

  const res = await env.DB.prepare(
    `INSERT INTO tests (code, file_id, file_type, base_chat_id, base_message_id, created_by, start_time, end_time, answer_key, points, is_quiz, is_closed)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), '', '[]', 0, 1)`
  ).bind(code, fileId, fileType, baseChannel.chat_id, messageId, chatId).run();

  await setState(env, chatId, "admin_test_subject", { testId: res.meta.last_row_id });
  await sendMessage(env, chatId, `✅ Fayl <b>${escapeHtml(baseChannel.title || baseChannel.chat_id)}</b> kanaliga muvaffaqiyatli joylandi.\nTest kodi: <b>${code}</b>\n\nTestning fani/mavzusini kiriting:`, cancelKeyboard());
}

async function handleChannelForward(env, chatId, forwardFromChat, type) {
  const chatIdStr = String(forwardFromChat.id);
  let title = forwardFromChat.title || forwardFromChat.username || chatIdStr;
  try {
    const info = await getChat(env, chatIdStr);
    if (info.ok) title = info.result.title || info.result.username || chatIdStr;
  } catch (e) {}
  await addChannel(env, chatIdStr, title, type, chatId);
  await setState(env, chatId, null);
  await sendMessage(env, chatId, `✅ Kanal muvaffaqiyatli qo'shildi: <b>${escapeHtml(title)}</b>`, channelsMenuKeyboard());
}

// ============================================================================
// ================= ADMINNING MATNLI QADAMLARI =================
// ============================================================================
async function handleAddTestText(env, user, text) {
  const chatId = user.telegram_id;
  const data = getStateData(user);
  const t = text.trim();

  // ---- Testni tahrirlash ----
  if (user.state && user.state.startsWith("admin_edit_subject:")) {
    const testId = user.state.split(":")[1];
    await env.DB.prepare("UPDATE tests SET subject = ? WHERE id = ?").bind(t, testId).run();
    await setState(env, chatId, null);
    await sendMessage(env, chatId, "✅ Test nomi yangilandi!", adminMenuKeyboard(await isAdmin(env, chatId), await isBotEnabled(env)));
    return true;
  }
  if (user.state && user.state.startsWith("admin_edit_price:")) {
    const testId = user.state.split(":")[1];
    const p = parseFloat(t.replace(",", ".").replace(/[^\d.]/g, "")) || 0;
    await env.DB.prepare("UPDATE tests SET price = ? WHERE id = ?").bind(p, testId).run();
    await setState(env, chatId, null);
    await sendMessage(env, chatId, "✅ Test narxi yangilandi!", adminMenuKeyboard(await isAdmin(env, chatId), await isBotEnabled(env)));
    return true;
  }
  if (user.state && user.state.startsWith("admin_edit_key:")) {
    const testId = user.state.split(":")[1];
    const key = t.replace(/[^a-zA-Z]/g, "").toUpperCase();
    if (!key) { await sendMessage(env, chatId, "❗️ Faqat harflardan iborat kalit kiriting:", cancelKeyboard()); return true; }
    await env.DB.prepare("UPDATE tests SET answer_key = ? WHERE id = ?").bind(key, testId).run();
    await setState(env, chatId, "admin_test_points_mode", { testId });
    await sendMessage(env, chatId, "✅ Javoblar yangilandi. Endi yangi javoblarga ballarni belgilaymiz:", pointsModeKeyboard());
    return true;
  }

  // ---- Testni kod orqali o'chirish ----
  if (user.state === "admin_delete_by_code") {
    const test = await getTestByCode(env, t);
    if (!test) { await sendMessage(env, chatId, "❌ Bunday kodli test topilmadi. Qaytadan kiriting:", cancelKeyboard()); return true; }
    const role = await isAdmin(env, chatId);
    if (!(await canManageTest(env, chatId, role, test))) { await sendMessage(env, chatId, "⛔️ Bu boshqa administratorning testi, uni o'chira olmaysiz."); await setState(env, chatId, null); return true; }
    await setState(env, chatId, null);
    await askDeleteConfirm(env, chatId, test);
    return true;
  }

  // ---- Yangi test/viktorina yaratish jarayonlari ----
  if (user.state === "admin_test_subject" || user.state === "admin_quiz_subject") {
    if (t.length < 2) { await sendMessage(env, chatId, "❗️ Nomni to'liqroq kiriting:", cancelKeyboard()); return true; }
    await env.DB.prepare("UPDATE tests SET subject = ? WHERE id = ?").bind(t, data.testId).run();
    await setState(env, chatId, user.state.replace("subject", "start"), data);
    await sendMessage(env, chatId, "⏰ Boshlanish vaqtini kiriting (KK.OO.YYYY SS:DD):\nMasalan: 25.07.2026 09:00", cancelKeyboard());
    return true;
  }

  if (user.state === "admin_test_start" || user.state === "admin_quiz_start") {
    const iso = parseUserDateTime(t);
    if (!iso) { await sendMessage(env, chatId, "❗️ Noto'g'ri format. KK.OO.YYYY SS:DD shaklida kiriting:", cancelKeyboard()); return true; }
    await env.DB.prepare("UPDATE tests SET start_time = ? WHERE id = ?").bind(iso, data.testId).run();
    await setState(env, chatId, user.state.replace("start", "end"), data);
    await sendMessage(env, chatId, "⏰ Tugash vaqtini kiriting (KK.OO.YYYY SS:DD):", cancelKeyboard());
    return true;
  }

  if (user.state === "admin_test_end" || user.state === "admin_quiz_end") {
    const iso = parseUserDateTime(t);
    if (!iso) { await sendMessage(env, chatId, "❗️ Noto'g'ri format. Qayta kiriting:", cancelKeyboard()); return true; }
    const startTest = await getTestById(env, data.testId);
    if (startTest && new Date(iso) <= new Date(startTest.start_time)) {
      await sendMessage(env, chatId, "❗️ Tugash vaqti boshlanish vaqtidan keyin bo'lishi kerak. Qayta kiriting:", cancelKeyboard());
      return true;
    }
    await env.DB.prepare("UPDATE tests SET end_time = ? WHERE id = ?").bind(iso, data.testId).run();
    await setState(env, chatId, user.state.replace("end", "timer"), data);
    await sendMessage(env, chatId, "⏱ Shaxsiy taymer qancha bo'lsin (daqiqa)?\n(Taymer kerak bo'lmasa 0 deb yozing):", cancelKeyboard());
    return true;
  }

  if (user.state === "admin_test_timer" || user.state === "admin_quiz_timer") {
    const timer = parseInt(t, 10) || 0;
    await env.DB.prepare("UPDATE tests SET timer = ? WHERE id = ?").bind(timer, data.testId).run();

    if (user.state.includes("quiz")) {
      await setState(env, chatId, "admin_quiz_questions", data);
      await sendMessage(env, chatId, "📝 Viktorina savollarini yuboring.\n\nFormat:\n<code>Savol matni\nJavob variant 1\nJavob variant 2+\nJavob variant 3</code>\n\nTo'g'ri javob oxiriga <b>+</b> belgisi qo'ying.\nBarcha savollarni yuborib bo'lgach, <b>Tugatish</b> deb yozing.", cancelKeyboard());
    } else {
      await setState(env, chatId, "admin_test_key", data);
      await sendMessage(env, chatId, "🔑 Javoblar kalitini kiriting (ABCD...):", cancelKeyboard());
    }
    return true;
  }

  if (user.state === "admin_test_key") {
    const key = t.replace(/[^a-zA-Z]/g, "").toUpperCase();
    if (!key) { await sendMessage(env, chatId, "❗️ Faqat harflardan iborat kalit kiriting:", cancelKeyboard()); return true; }
    await env.DB.prepare("UPDATE tests SET answer_key = ? WHERE id = ?").bind(key, data.testId).run();
    await setState(env, chatId, "admin_test_points_mode", data);
    await sendMessage(env, chatId, "Ballarni qanday belgilaymiz?", pointsModeKeyboard());
    return true;
  }

  if (user.state === "admin_test_points_equal") {
    const val = parseFloat(t.replace(",", "."));
    if (isNaN(val) || val <= 0) { await sendMessage(env, chatId, "❗️ Musbat son kiriting:", cancelKeyboard()); return true; }
    const test = await getTestById(env, data.testId);
    const points = new Array(test.answer_key.length).fill(val);
    await env.DB.prepare("UPDATE tests SET points = ? WHERE id = ?").bind(JSON.stringify(points), data.testId).run();
    await setState(env, chatId, "admin_test_price", data);
    await sendMessage(env, chatId, "💰 Bu test narxi qancha?\nBepul bo'lsa 0 deb yozing:", cancelKeyboard());
    return true;
  }

  if (user.state === "admin_test_points_custom") {
    const test = await getTestById(env, data.testId);
    const points = t.split(",").map((x) => parseFloat(x.trim())).filter((x) => !isNaN(x));
    if (points.length !== test.answer_key.length) { await sendMessage(env, chatId, `❗️ Ballar soni savollar soniga (${test.answer_key.length}) mos tushmadi. Qayta kiriting:`, cancelKeyboard()); return true; }
    await env.DB.prepare("UPDATE tests SET points = ? WHERE id = ?").bind(JSON.stringify(points), data.testId).run();
    await setState(env, chatId, "admin_test_price", data);
    await sendMessage(env, chatId, "💰 Bu test narxi qancha?\nBepul bo'lsa 0 deb yozing:", cancelKeyboard());
    return true;
  }

  if (user.state === "admin_quiz_questions") {
    if (t.toLowerCase() === "tugatish") {
      const qCount = await env.DB.prepare("SELECT COUNT(*) as c FROM quiz_questions WHERE test_id = ?").bind(data.testId).first();
      if (!qCount || qCount.c === 0) { await sendMessage(env, chatId, "❗️ Kamida bitta savol qo'shishingiz kerak.", cancelKeyboard()); return true; }
      const points = new Array(qCount.c).fill(1);
      await env.DB.prepare("UPDATE tests SET points = ? WHERE id = ?").bind(JSON.stringify(points), data.testId).run();
      await setState(env, chatId, "admin_quiz_price", data);
      await sendMessage(env, chatId, `✅ Qabul qilingan savollar: ${qCount.c} ta.\n\n💰 Bu test narxi qancha? (Bepul bo'lsa 0):`, cancelKeyboard());
      return true;
    }
    const qData = parseQuizBlock(t);
    if (!qData) { await sendMessage(env, chatId, "❌ Format xato! To'g'ri javob oxiriga + qo'yishni unutmang. Yoki tugatgan bo'lsangiz \"Tugatish\" deb yozing.", cancelKeyboard()); return true; }
    await env.DB.prepare("INSERT INTO quiz_questions (test_id, question, options, correct_index) VALUES (?, ?, ?, ?)")
      .bind(data.testId, qData.question, JSON.stringify(qData.options), qData.correctIndex).run();
    await sendMessage(env, chatId, "✅ Savol saqlandi. Keyingisini yuboring (yoki \"Tugatish\" deb yozing):", cancelKeyboard());
    return true;
  }

  if (user.state === "admin_test_price" || user.state === "admin_quiz_price") {
    const price = parseFloat(t.replace(",", ".").replace(/[^\d.]/g, "")) || 0;
    await env.DB.prepare("UPDATE tests SET price = ?, is_closed = 0 WHERE id = ?").bind(price, data.testId).run();
    const test = await getTestById(env, data.testId);
    await setState(env, chatId, null);
    const pText = price > 0 ? `\n💰 Narxi: ${price} so'm` : "\n🎁 Bepul";
    await sendMessage(env, chatId,
      `🎉 <b>Test faollashtirildi!</b>\n\n📘 ${escapeHtml(test.subject)}\n🔑 Kod: <b>${test.code}</b>\n⏰ ${formatDateTime(test.start_time)} — ${formatDateTime(test.end_time)}${pText}`,
      adminMenuKeyboard(await isAdmin(env, chatId), await isBotEnabled(env)));
    return true;
  }

  // ---- Kanal qo'shish (matn orqali) ----
  if (user.state === "admin_channel_add" && (t.startsWith("@") || /^-?\d{5,}$/.test(t))) {
    let title = t;
    try {
      const info = await getChat(env, t);
      if (info.ok) title = info.result.title || info.result.username || t;
    } catch (e) {}
    await addChannel(env, t, title, data.type, chatId);
    await setState(env, chatId, null);
    await sendMessage(env, chatId, `✅ Kanal muvaffaqiyatli qo'shildi: <b>${escapeHtml(title)}</b>`, channelsMenuKeyboard());
    return true;
  }

  // ---- Sub-admin qo'shish ----
  if (user.state === "admin_subadmin_add") {
    const id = parseInt(t.replace(/\D/g, ""), 10);
    if (!id) { await sendMessage(env, chatId, "❗️ Faqat raqamlardan iborat Telegram ID kiriting:", cancelKeyboard()); return true; }
    if (String(id) === String(env.OWNER_ID)) { await sendMessage(env, chatId, "❗️ Bu ID allaqachon Bosh administrator."); return true; }
    const targetUser = await getUser(env, id);
    await env.DB.prepare("INSERT INTO admins (telegram_id, role, name, added_by) VALUES (?, 'admin', ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET role='admin'")
      .bind(id, targetUser ? `${targetUser.first_name || ""} ${targetUser.last_name || ""}`.trim() : null, chatId).run();
    await setState(env, chatId, null);
    await sendMessage(env, chatId, `✅ Sub-admin qo'shildi (ID: ${id}).`, adminMenuKeyboard("owner", await isBotEnabled(env)));
    try { await sendMessage(env, id, "🎉 Sizga bot boshqaruvida <b>Sub-admin</b> huquqi berildi!\n/admin buyrug'i orqali panelga kirishingiz mumkin."); } catch (e) {}
    return true;
  }

  // ---- Xabar tarqatish ----
  if (user.state === "admin_broadcast_waiting") {
    await setState(env, chatId, null);
    await sendMessage(env, chatId, "⏳ Xabar tarqatilmoqda, biroz kuting...");
    const ids = await getAllUserIds(env);
    let sent = 0, failed = 0;
    const batchSize = 25;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map((id) => sendMessage(env, id, t)));
      results.forEach((r) => {
        if (r.status === "fulfilled" && r.value && r.value.ok) sent++;
        else failed++;
      });
    }
    await sendMessage(env, chatId, `✅ <b>Xabar tarqatish yakunlandi!</b>\n\n👥 Jami foydalanuvchilar: ${ids.length}\n✔️ Yuborildi: ${sent}\n❌ Yuborilmadi: ${failed}`, adminMenuKeyboard(await isAdmin(env, chatId), await isBotEnabled(env)));
    return true;
  }

  if (user.state === "admin_setcard") {
    await setSetting(env, "admin_card", t);
    await setState(env, chatId, null);
    await sendMessage(env, chatId, "✅ Karta ma'lumotlari muvaffaqiyatli saqlandi.", adminMenuKeyboard("owner", await isBotEnabled(env)));
    return true;
  }

  if (user.state === "admin_addbalance_id") {
    const targetId = parseInt(t.replace(/\D/g, ""), 10);
    if (!targetId) { await sendMessage(env, chatId, "❗️ Noto'g'ri ID. Faqat raqam kiriting:", cancelKeyboard()); return true; }
    const targetUser = await getUser(env, targetId);
    if (!targetUser) { await sendMessage(env, chatId, "❗️ Bunday foydalanuvchi topilmadi. Qayta kiriting:", cancelKeyboard()); return true; }
    await setState(env, chatId, "admin_addbalance_amount", { targetId });
    await sendMessage(env, chatId, `👤 Foydalanuvchi topildi: ${escapeHtml(targetUser.first_name)} ${escapeHtml(targetUser.last_name)}\n\nQancha summa qo'shmoqchisiz?`, cancelKeyboard());
    return true;
  }

  if (user.state === "admin_addbalance_amount") {
    const amount = parseFloat(t.replace(/[^\d.]/g, ""));
    if (!amount || amount <= 0) { await sendMessage(env, chatId, "❗️ Noto'g'ri summa. Qayta kiriting:", cancelKeyboard()); return true; }
    await env.DB.prepare("UPDATE users SET balance = balance + ? WHERE telegram_id = ?").bind(amount, data.targetId).run();
    await setState(env, chatId, null);
    await sendMessage(env, chatId, `✅ ID ${data.targetId} hisobiga ${amount} so'm qo'shildi.`, adminMenuKeyboard("owner", await isBotEnabled(env)));
    try { await sendMessage(env, data.targetId, `🎉 <b>Hisobingiz to'ldirildi!</b>\n💰 Qo'shilgan summa: ${amount} so'm`); } catch (e) {}
    return true;
  }

  // ---- O'quvchi pul o'tkazganini bildirganda ----
  if (user.state === "waiting_deposit_amount") {
    const amount = parseFloat(t.replace(/[^\d.]/g, ""));
    if (!amount || amount <= 0) { await sendMessage(env, chatId, "❗️ Iltimos, faqat to'g'ri summa kiriting (masalan: 5000):", cancelKeyboard()); return true; }
    await setState(env, chatId, null);
    await sendMessage(env, chatId, "⏳ So'rovingiz adminga yuborildi. To'lov tasdiqlangach hisobingiz to'ldiriladi.", studentMainMenu());
    const adminMsg = `💵 <b>Yangi to'lov xabari!</b>\n\n👤 Foydalanuvchi: ${escapeHtml(user.first_name)} (ID: <code>${chatId}</code>)\n💰 Yuborgan summa: <b>${amount} so'm</b>\n\nKartani tekshirib, pul tushgan bo'lsa /admin → "Balans to'ldirish" orqali balansni to'ldiring.`;
    try { await sendMessage(env, env.OWNER_ID, adminMsg); } catch (e) {}
    return true;
  }

  return false;
}

// ============================================================================
// ================= OBUNA GATE VA CANCEL =================
// ============================================================================
async function requireSubscription(env, chatId) {
  const sub = await checkSubscription(env, chatId);
  if (!sub.ok) {
    await sendMessage(env, chatId, "📢 <b>Botdan foydalanish uchun quyidagi kanal(lar)ga a'zo bo'ling:</b>", subscriptionKeyboard(sub.missing));
    return false;
  }
  return true;
}

async function handleCancel(env, chatId) {
  await setState(env, chatId, null);
  const role = await isAdmin(env, chatId);
  if (role) {
    const enabled = await isBotEnabled(env);
    await sendMessage(env, chatId, "❌ Amal bekor qilindi.", adminMenuKeyboard(role, enabled));
  } else {
    await sendMessage(env, chatId, "❌ Amal bekor qilindi.", studentMainMenu());
  }
}

// ============================================================================
// ================= ASOSIY EVENT ROUTER =================
// ============================================================================
async function handleUpdate(update, env) {
  try {
    // ---- Global On/Off blokator ----
    let earlyChatId = null;
    if (update.message) earlyChatId = update.message.chat.id;
    else if (update.callback_query) earlyChatId = update.callback_query.from.id;

    if (earlyChatId !== null) {
      const enabled = await isBotEnabled(env);
      if (!enabled && String(earlyChatId) !== String(env.OWNER_ID)) {
        if (update.callback_query) await answerCallbackQuery(env, update.callback_query.id, "🛠 Bot vaqtincha o'chirilgan.", true);
        else await sendMessage(env, earlyChatId, "🛠 <b>Bot vaqtincha texnik ishlar tufayli o'chirilgan.</b>\n\nIltimos, keyinroq qayta urinib ko'ring.");
        return;
      }
    }

    // ---- Viktorina javoblari ----
    if (update.poll_answer) {
      await handlePollAnswer(env, update.poll_answer);
      return;
    }

    // ---- Tugmalar bosilganda ----
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.from.id;
      const user = await ensureUser(env, chatId);
      await answerCallbackQuery(env, cb.id);
      user.callback_query_id = cb.id;

      if (cb.data === "cancel") { await handleCancel(env, chatId); return; }

      if (cb.data.startsWith("reg:")) {
        if (user.state && user.state.startsWith("profile_edit_")) await handleProfileEditCallback(env, user, cb.data);
        else await handleRegistrationCallback(env, user, cb.data);
        return;
      }

      if (cb.data === "check_sub") {
        const sub = await checkSubscription(env, chatId);
        if (!sub.ok) { await answerCallbackQuery(env, cb.id, "❗️ Siz hali barcha kanallarga a'zo bo'lmagansiz!", true); return; }
        await sendMessage(env, chatId, "✅ Tabriklaymiz! Endi botdan to'liq foydalanishingiz mumkin.", studentMainMenu());
        return;
      }

      const role = await isAdmin(env, chatId);
      if (!role) {
        const ok = await requireSubscription(env, chatId);
        if (!ok) return;
      }

      if (cb.data.startsWith("profile:")) { await handleProfileCallback(env, user, cb.data); return; }

      if (cb.data === "rating:general") { await showGeneralRating(env, chatId); return; }
      if (cb.data === "rating:bycode") {
        await setState(env, chatId, "waiting_rating_code");
        await sendMessage(env, chatId, "🔑 Reytingini ko'rmoqchi bo'lgan testning kodini kiriting:", cancelKeyboard());
        return;
      }

      if (role && (cb.data.startsWith("admin:") || cb.data.startsWith("addtest:") || cb.data.startsWith("chan:") || cb.data.startsWith("test:") || cb.data.startsWith("subadmin:"))) {
        await handleAdminCallback(env, user, cb.data, role);
        return;
      }
      return;
    }

    // ---- Shaxsiy xabarlar ----
    if (update.message && update.message.chat.type === "private") {
      const msg = update.message;
      const chatId = msg.chat.id;
      const text = msg.text || "";

      let user = await ensureUser(env, chatId);
      const role = await isAdmin(env, chatId);

      // Test faylini bevosita botga yuborish (admin)
      if (role && user.state === "admin_awaiting_file" && (msg.document || msg.photo)) {
        const fileId = msg.document ? msg.document.file_id : msg.photo[msg.photo.length - 1].file_id;
        const fileType = msg.document ? "document" : "photo";
        await handleIncomingTestFile(env, chatId, fileId, fileType);
        return;
      }
      if (role && user.state === "admin_awaiting_file" && !msg.document && !msg.photo) {
        await sendMessage(env, chatId, "❗️ Iltimos, faqat PDF yoki rasm ko'rinishidagi test faylini yuboring.", cancelKeyboard());
        return;
      }

      // Kanal qo'shish (forward orqali)
      if (role && user.state === "admin_channel_add" && msg.forward_from_chat) {
        await handleChannelForward(env, chatId, msg.forward_from_chat, getStateData(user).type);
        return;
      }

      if (text === "/start") {
        if (user.registered) {
          if (!role) { const ok = await requireSubscription(env, chatId); if (!ok) return; }
          await sendMessage(env, chatId, "🏠 Bosh menyu:", studentMainMenu());
        } else {
          await setState(env, chatId, "reg_name");
          await sendMessage(env, chatId, "👋 Assalomu alaykum! Botga xush kelibsiz.\n\nRo'yxatdan o'tish uchun ismingizni kiriting:");
        }
        return;
      }

      if (text === "/admin") {
        if (role) await showAdminMenu(env, chatId, role);
        else await sendMessage(env, chatId, "⛔️ Sizda admin huquqi yo'q.");
        return;
      }

      // Asosiy menyu tugmalari bosilganda kutishni to'xtatish
      const MAIN_MENU_CMDS = ["📝 Test tekshirish", "📋 Faol testlar", "🏆 Reyting", "⚙️ Profil", "💰 Hisobim"];
      if (MAIN_MENU_CMDS.includes(text)) { await setState(env, chatId, null); user.state = null; }

      // Ro'yxatdan o'tish qadamlari
      if (["reg_name", "reg_lastname", "reg_fathername"].includes(user.state)) {
        await handleRegistrationText(env, user, text);
        return;
      }

      if (!user.registered) { await sendMessage(env, chatId, "Ro'yxatdan o'tish uchun /start buyrug'ini bosing."); return; }

      // 📢 Majburiy obuna — GLOBAL BLOKATOR (adminlar bundan mustasno)
      if (!role) {
        const ok = await requireSubscription(env, chatId);
        if (!ok) return;
      }

      // Profilni tahrirlash (matn)
      if (user.state && user.state.startsWith("profile_edit_")) {
        const h = await handleProfileEditText(env, user, text);
        if (h) return;
      }

      // Adminning matnli buyruqlari
      if (role && ((user.state && user.state.startsWith("admin_")) )) {
        const h = await handleAddTestText(env, user, text);
        if (h) return;
      }

      // Reyting: kod orqali
      if (user.state === "waiting_rating_code") {
        await setState(env, chatId, null);
        await showTestRanking(env, chatId, text.trim(), false);
        return;
      }

      // Depozit summasi
      if (user.state === "waiting_deposit_amount") {
        const h = await handleAddTestText(env, user, text);
        if (h) return;
      }

      // Oddiy test kodini qabul qilish
      if (user.state === "waiting_test_code") {
        await handleTestCode(env, user, text);
        return;
      }

      // Oddiy test javobini qabul qilish
      if (user.state && user.state.startsWith("waiting_answers:")) {
        await handleAnswerSubmission(env, user, parseInt(user.state.split(":")[1], 10), text);
        return;
      }

      const handled = await handleMainMenuText(env, user, text);
      if (!handled) {
        await sendMessage(env, chatId, "Iltimos, kerakli amalni tugmalar orqali tanlang 👇", studentMainMenu());
      }
    }
  } catch (err) {
    console.log("handleUpdate xato:", err.stack || err.message);
  }
}

// ============================================================================
// ================= CRON: REJALASHTIRILGAN VAZIFALAR =================
// ============================================================================
async function runScheduledTasks(env) {
  try {
    // 1) Vaqti tugagan testlarni yopish va Natijalar kanaliga yakuniy reyting chiqarish
    const { results: expiredTests } = await env.DB.prepare(
      "SELECT * FROM tests WHERE is_closed = 0 AND datetime('now') > datetime(end_time)"
    ).all();

    for (const test of expiredTests || []) {
      await env.DB.prepare("UPDATE tests SET is_closed = 1 WHERE id = ?").bind(test.id).run();

      const ranking = await getRanking(env, test.id);
      let msg = `🏁 <b>"${escapeHtml(test.subject || test.code)}"</b> testi (muddati tugashi bilan) avtomatik yakunlandi!\n\n🏆 <b>Yakuniy Reyting:</b>\n`;
      if (ranking.length === 0) msg += "Hech kim ishlamadi.";
      else ranking.slice(0, 15).forEach((r, i) => {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
        msg += `${medal} ${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)} — <b>${r.score}/${r.max_score}</b> ball\n`;
      });

      const resultsChannels = await getChannels(env, "results");
      for (const ch of resultsChannels) await sendMessage(env, ch.chat_id, msg);
    }

    // 2) Shaxsiy taymer tugashiga 5 daqiqa qolgan foydalanuvchilarga eslatma
    const { results: soonTests } = await env.DB.prepare(
      "SELECT * FROM tests WHERE is_closed = 0 AND timer > 0"
    ).all();

    for (const test of soonTests || []) {
      const { results: sessions } = await env.DB.prepare(
        "SELECT * FROM test_sessions WHERE test_id = ? AND reminded = 0"
      ).bind(test.id).all();

      for (const s of sessions || []) {
        const elapsedMinutes = (Date.now() - new Date(s.started_at + "Z").getTime()) / 60000;
        const remaining = test.timer - elapsedMinutes;
        if (remaining <= 5 && remaining > 0) {
          const already = await getSubmission(env, test.id, s.telegram_id);
          if (already) continue;
          await sendMessage(env, s.telegram_id, `⏰ Diqqat! Shaxsiy taymeringiz tugashiga <b>${Math.max(Math.round(remaining), 0)} daqiqa</b> qoldi.`);
          await env.DB.prepare("UPDATE test_sessions SET reminded = 1 WHERE test_id = ? AND telegram_id = ?").bind(test.id, s.telegram_id).run();
        }
      }
    }
  } catch (err) {
    console.log("Cron xato:", err.stack || err.message);
  }
}
