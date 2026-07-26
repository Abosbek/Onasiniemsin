export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ================= 1. BAZA YARATISH VA YANGILASH =================
    if (url.pathname === "/init-db") {
      try {
        await env.DB.batch([
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (telegram_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, father_name TEXT, region TEXT, level TEXT, grade TEXT, registered INTEGER DEFAULT 0, balance REAL DEFAULT 0, state TEXT, state_data TEXT, is_whitelisted INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_seen DATETIME DEFAULT CURRENT_TIMESTAMP)`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS admins (telegram_id INTEGER PRIMARY KEY, role TEXT, name TEXT, added_by INTEGER, added_at DATETIME DEFAULT CURRENT_TIMESTAMP)`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS channels (chat_id TEXT PRIMARY KEY, title TEXT, type TEXT, added_by INTEGER, added_at DATETIME DEFAULT CURRENT_TIMESTAMP)`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS tests (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, subject TEXT, file_id TEXT, file_type TEXT, created_by INTEGER, start_time DATETIME, end_time DATETIME, answer_key TEXT, points TEXT, price REAL DEFAULT 0, timer INTEGER DEFAULT 0, is_quiz INTEGER DEFAULT 0, is_closed INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, test_id INTEGER, telegram_id INTEGER, answers TEXT, correct_count INTEGER, total_count INTEGER, score REAL, max_score REAL, submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP)`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS quiz_questions (id INTEGER PRIMARY KEY AUTOINCREMENT, test_id INTEGER, question TEXT, options TEXT, correct_index INTEGER)`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_polls (poll_id TEXT PRIMARY KEY, test_id INTEGER, telegram_id INTEGER, question_id INTEGER, is_correct INTEGER DEFAULT 0, answered INTEGER DEFAULT 0)`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS test_sessions (test_id INTEGER, telegram_id INTEGER, started_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(test_id, telegram_id))`)
        ]);
        
        // Agar eski baza bo'lsa, xato bermasdan yangi ustunlarni qo'shib oladi
        const alters = [
          "ALTER TABLE users ADD COLUMN balance REAL DEFAULT 0",
          "ALTER TABLE tests ADD COLUMN price REAL DEFAULT 0",
          "ALTER TABLE tests ADD COLUMN timer INTEGER DEFAULT 0",
          "ALTER TABLE tests ADD COLUMN is_quiz INTEGER DEFAULT 0"
        ];
        for (let q of alters) {
          try { await env.DB.prepare(q).run(); } catch(e) {}
        }
        return new Response("✅ Baza va barcha jadvallar muvaffaqiyatli yaratildi!", { status: 200 });
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

    // ================= 3. TELEGRAM XABARLARINI QABUL QILISH =================
    if (request.method === "POST") {
      try {
        const update = await request.json();
        await handleUpdate(update, env);
      } catch (err) {
        console.log("Xato:", err.stack || err.message);
      }
      return new Response("OK", { status: 200 });
    }

    return new Response("Uzbek Test Bot 2026 - Tizim 100% to'liq ishlayapti!", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    await runScheduledTasks(env);
  }
};

// ================= TELEGRAM API FUNKSIYALARI =================
function apiUrl(env, method) {
  return "https://api.telegram.org/bot" + env.BOT_TOKEN + "/" + method;
}

async function tgCall(env, method, payload) {
  const res = await fetch(apiUrl(env, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) console.log(`Telegram xatosi [${method}]:`, JSON.stringify(data));
  return data;
}

async function sendMessage(env, chatId, text, replyMarkup = null, extra = {}) {
  const payload = { chat_id: chatId, text: text, parse_mode: "HTML", ...extra };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tgCall(env, "sendMessage", payload);
}

async function answerCallbackQuery(env, callbackQueryId, text = null, showAlert = false) {
  const payload = { callback_query_id: callbackQueryId };
  if (text) { 
    payload.text = text; 
    payload.show_alert = showAlert; 
  }
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
    question: question, 
    options: JSON.stringify(options), 
    type: "quiz", 
    correct_option_id: correctOptionId, 
    is_anonymous: false, 
    ...extra 
  };
  return tgCall(env, "sendPoll", payload);
}

async function getChatMember(env, chatId, userId) {
  return tgCall(env, "getChatMember", { chat_id: chatId, user_id: userId });
}

async function setWebhook(env, url) {
  return tgCall(env, "setWebhook", { 
    url: url, 
    secret_token: env.WEBHOOK_SECRET, 
    allowed_updates: ["message", "callback_query", "channel_post", "poll", "poll_answer"] 
  });
}

// ================= D1 BAZA BILAN ISHLASH FUNKSIYALARI =================
async function getUser(env, telegramId) {
  return await env.DB.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(telegramId).first() || null;
}

async function ensureUser(env, telegramId) {
  let user = await getUser(env, telegramId);
  if (!user) {
    await env.DB.prepare("INSERT INTO users (telegram_id, registered, state, balance) VALUES (?, 0, 'reg_name', 0)").bind(telegramId).run();
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
  const { results } = await env.DB.prepare("SELECT * FROM tests WHERE is_closed = 0 AND CURRENT_TIMESTAMP <= end_time ORDER BY start_time").all();
  return results || [];
}

async function getSubmission(env, testId, telegramId) {
  return env.DB.prepare("SELECT * FROM submissions WHERE test_id = ? AND telegram_id = ?").bind(testId, telegramId).first();
}

async function getRanking(env, testId) {
  const { results } = await env.DB.prepare("SELECT s.*, u.first_name, u.last_name, u.region, u.grade FROM submissions s JOIN users u ON u.telegram_id = s.telegram_id WHERE s.test_id = ? ORDER BY s.score DESC, s.submitted_at ASC").bind(testId).all();
  return results || [];
}

async function checkSubscription(env, telegramId) {
  const required = await getChannels(env, "required");
  if (required.length === 0) return { ok: true, missing: [] };
  
  const missing = [];
  for (const ch of required) {
    try {
      const res = await getChatMember(env, ch.chat_id, telegramId);
      if (!res.ok || ["left", "kicked"].includes(res?.result?.status)) {
        missing.push(ch);
      }
    } catch {
      missing.push(ch);
    }
  }
  return { ok: missing.length === 0, missing };
}

// ================= KLAVIATURALAR VA VILOYATLAR =================
const REGIONS = [
  { code: "AND", name: "Andijon" }, { code: "BUX", name: "Buxoro" }, { code: "FAR", name: "Farg'ona" },
  { code: "JIZ", name: "Jizzax" }, { code: "XOR", name: "Xorazm" }, { code: "NAM", name: "Namangan" },
  { code: "NAV", name: "Navoiy" }, { code: "QAS", name: "Qashqadaryo" }, { code: "SAM", name: "Samarqand" },
  { code: "SIR", name: "Sirdaryo" }, { code: "SUR", name: "Surxondaryo" }, { code: "TVL", name: "Toshkent viloyati" },
  { code: "TSH", name: "Toshkent shahri" }, { code: "QOR", name: "Qoraqalpog'iston Respublikasi" }
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
  return { inline_keyboard: [ 
    [{ text: "🏫 Maktab o'quvchisi", callback_data: "reg:level:maktab" }, { text: "🎓 Talaba", callback_data: "reg:level:talaba" }] 
  ] };
}

function gradeKeyboard() {
  const rows = [];
  for (let i = 1; i <= 11; i += 4) {
    const row = [];
    for (let g = i; g < i + 4 && g <= 11; g++) {
      row.push({ text: g + "-sinf", callback_data: "reg:grade:" + g });
    }
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

function courseKeyboard() {
  return { inline_keyboard: [ 
    [{ text: "1-kurs", callback_data: "reg:grade:1-kurs" }, { text: "2-kurs", callback_data: "reg:grade:2-kurs" }], 
    [{ text: "3-kurs", callback_data: "reg:grade:3-kurs" }, { text: "4-kurs", callback_data: "reg:grade:4-kurs" }] 
  ] };
}

function studentMainMenu() {
  return { 
    keyboard: [ 
      [{ text: "📝 Test tekshirish" }, { text: "📋 Faol testlar" }], 
      [{ text: "🏆 Reytingim" }, { text: "⚙️ Profil" }], 
      [{ text: "💰 Hisobim" }] 
    ], 
    resize_keyboard: true, 
    is_persistent: true 
  };
}

function profileEditKeyboard() {
  return { inline_keyboard: [ 
    [{ text: "✏️ Ismni o'zgartirish", callback_data: "profile:name" }], 
    [{ text: "✏️ Familiyani o'zgartirish", callback_data: "profile:lastname" }], 
    [{ text: "🌍 Viloyatni o'zgartirish", callback_data: "profile:region" }], 
    [{ text: "🎓 Sinf/kursni o'zgartirish", callback_data: "profile:grade" }] 
  ] };
}

function adminMenuKeyboard(role) {
  const rows = [ 
    [{ text: "📊 Statistika", callback_data: "admin:stats" }], 
    [{ text: "➕ Oddiy Test", callback_data: "admin:addtest" }, { text: "➕ Viktorina", callback_data: "admin:addquiz" }], 
    [{ text: "📋 Mening testlarim", callback_data: "admin:mytests" }] 
  ];
  if (role === "owner") {
    rows.push([{ text: "💳 Karta raqami", callback_data: "admin:setcard" }, { text: "💵 Balans to'ldirish", callback_data: "admin:addbalance" }]);
    rows.push([{ text: "📢 Kanallar", callback_data: "admin:channels" }, { text: "✉️ Xabar tarqatish", callback_data: "admin:broadcast" }]);
  }
  return { inline_keyboard: rows };
}

function pointsModeKeyboard() {
  return { inline_keyboard: [ 
    [{ text: "Barchasiga bir xil ball", callback_data: "addtest:points:equal" }], 
    [{ text: "Har biriga alohida ball", callback_data: "addtest:points:custom" }] 
  ] };
}

function testEditKeyboard(testId) {
  return { inline_keyboard: [
    [{ text: "✏️ Nomini o'zgartirish", callback_data: `admin:edit:subject:${testId}` }],
    [{ text: "💰 Narxni o'zgartirish", callback_data: `admin:edit:price:${testId}` }],
    [{ text: "🔑 Javoblarni almashtirish", callback_data: `admin:edit:key:${testId}` }],
    [{ text: "🗑 Testni o'chirish", callback_data: `admin:deltest:${testId}` }]
  ] };
}

// ================= YORDAMCHI FUNKSIYALAR VA VAQT (UTC+5) =================
async function generateTestCode(env) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const exists = await env.DB.prepare("SELECT id FROM tests WHERE code = ?").bind(code).first();
    if (!exists) return code;
  }
  return "0000";
}

function parseUserDateTime(str) {
  const m = str.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, d, mo, y, h, mi] = m;
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}:00+05:00`;
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

function parseQuizBlock(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  if (lines.length < 3) return null;
  
  const question = lines[0];
  const options = [];
  let correctIndex = -1;
  
  for (let i = 1; i < lines.length; i++) {
    let opt = lines[i];
    if (opt.endsWith('+')) {
      correctIndex = i - 1;
      opt = opt.slice(0, -1).trim();
    }
    options.push(opt);
  }
  
  if (correctIndex === -1 || options.length < 2 || options.length > 10) return null;
  return { question, options, correctIndex };
}

function shuffleQuizOptions(options, correctIndex) {
  let arr = options.map((opt, i) => ({ text: opt, isCorrect: i === correctIndex }));
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  let newCorrectIndex = arr.findIndex(x => x.isCorrect);
  return { shuffledOptions: arr.map(x => x.text), newCorrectIndex };
}

function scoreAnswers(userAnswers, key, points) {
  const ua = userAnswers.toUpperCase().replace(/[^A-Z]/g, "");
  const k = key.toUpperCase();
  let score = 0; let maxScore = 0; let correctCount = 0; const wrongQuestions = [];
  
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

// ================= RO'YXATDAN O'TISH VA PROFIL =================
async function handleRegistrationText(env, user, text) {
  const chatId = user.telegram_id;
  const t = text.trim();
  
  if (user.state === "reg_name") {
    if (t.length < 2) {
      await sendMessage(env, chatId, "❗️ Ismingizni to'liq kiriting:");
      return true;
    }
    await updateUserFields(env, chatId, { first_name: t });
    await setState(env, chatId, "reg_lastname");
    await sendMessage(env, chatId, "Familiyangizni kiriting:");
    return true;
  }
  
  if (user.state === "reg_lastname") {
    if (t.length < 2) {
      await sendMessage(env, chatId, "❗️ Familiyangizni to'liq kiriting:");
      return true;
    }
    await updateUserFields(env, chatId, { last_name: t });
    await setState(env, chatId, "reg_fathername");
    await sendMessage(env, chatId, "Otasining ismini kiriting:");
    return true;
  }
  
  if (user.state === "reg_fathername") {
    if (t.length < 2) {
      await sendMessage(env, chatId, "❗️ Otasining ismini to'liq kiriting:");
      return true;
    }
    await updateUserFields(env, chatId, { father_name: t });
    await setState(env, chatId, "reg_region");
    await sendMessage(env, chatId, "🌍 Hududingizni tanlang:", regionKeyboard());
    return true;
  }
  return false;
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
    await updateUserFields(env, chatId, { level: level });
    await setState(env, chatId, "reg_grade");
    
    if (level === "maktab") {
      await sendMessage(env, chatId, "📚 Necha sinfda o'qiysiz?", gradeKeyboard());
    } else {
      await sendMessage(env, chatId, "📚 Necha kursda o'qiysiz?", courseKeyboard());
    }
    return true;
  }
  
  if (data.startsWith("reg:grade:")) {
    const grade = data.split(":")[2];
    await updateUserFields(env, chatId, { grade: grade, registered: 1, state: null, state_data: null });
    await sendMessage(env, chatId, "✅ Ro'yxatdan muvaffaqiyatli o'tdingiz!\n\nEndi quyidagi menyudan foydalanishingiz mumkin 👇", studentMainMenu());
    return true;
  }
  
  return false;
}

async function handleProfileEditCallback(env, user, data) {
  const chatId = user.telegram_id;
  
  if (data === "profile:name") {
    await setState(env, chatId, "profile_edit_name");
    await sendMessage(env, chatId, "Yangi ismingizni kiriting:");
    return true;
  }
  if (data === "profile:lastname") {
    await setState(env, chatId, "profile_edit_lastname");
    await sendMessage(env, chatId, "Yangi familiyangizni kiriting:");
    return true;
  }
  if (data === "profile:region") {
    await setState(env, chatId, "profile_edit_region");
    await sendMessage(env, chatId, "Yangi hududingizni tanlang:", regionKeyboard());
    return true;
  }
  if (data === "profile:grade") {
    await setState(env, chatId, "profile_edit_level");
    await sendMessage(env, chatId, "Ta'lim darajangizni tanlang:", levelKeyboard());
    return true;
  }
  
  if (user.state === "profile_edit_region" && data.startsWith("reg:region:")) {
    const code = data.split(":")[2];
    await updateUserFields(env, chatId, { region: regionNameByCode(code), state: null, state_data: null });
    await sendMessage(env, chatId, "✅ Hudud yangilandi.", studentMainMenu());
    return true;
  }
  
  if (user.state === "profile_edit_level" && data.startsWith("reg:level:")) {
    const level = data.split(":")[2];
    await updateUserFields(env, chatId, { level: level });
    await setState(env, chatId, "profile_edit_grade");
    if (level === "maktab") {
      await sendMessage(env, chatId, "Sinfingizni tanlang:", gradeKeyboard());
    } else {
      await sendMessage(env, chatId, "Kursingizni tanlang:", courseKeyboard());
    }
    return true;
  }
  
  if (user.state === "profile_edit_grade" && data.startsWith("reg:grade:")) {
    const grade = data.split(":")[2];
    await updateUserFields(env, chatId, { grade: grade, state: null, state_data: null });
    await sendMessage(env, chatId, "✅ Sinf/kurs yangilandi.", studentMainMenu());
    return true;
  }
  
  return false;
}

async function handleProfileEditText(env, user, text) {
  const chatId = user.telegram_id;
  const t = text.trim();
  
  if (user.state === "profile_edit_name") {
    await updateUserFields(env, chatId, { first_name: t, state: null, state_data: null });
    await sendMessage(env, chatId, "✅ Ism yangilandi.", studentMainMenu());
    return true;
  }
  if (user.state === "profile_edit_lastname") {
    await updateUserFields(env, chatId, { last_name: t, state: null, state_data: null });
    await sendMessage(env, chatId, "✅ Familiya yangilandi.", studentMainMenu());
    return true;
  }
  return false;
}
// ================= USER ASOSIY MENYU VA REYTING =================
async function showRating(env, chatId) {
  const { results } = await env.DB.prepare("SELECT first_name, last_name, SUM(score) as total_score FROM submissions s JOIN users u ON u.telegram_id = s.telegram_id GROUP BY u.telegram_id ORDER BY total_score DESC LIMIT 10").all();
  
  let msg = "🏆 <b>Umumiy Top-10 Reyting (Barcha testlar bo'yicha):</b>\n\n";
  
  if (!results || results.length === 0) {
    msg += "Hali reyting shakllanmagan.";
  } else {
    results.forEach((r, i) => {
      msg += `${i + 1}. ${r.first_name} ${r.last_name} — <b>${r.total_score} ball</b>\n`;
    });
  }
  
  const myScore = await env.DB.prepare("SELECT SUM(score) as s FROM submissions WHERE telegram_id = ?").bind(chatId).first();
  msg += `\n🏅 Sizning umumiy to'plagan ballingiz: <b>${myScore && myScore.s ? myScore.s : 0}</b>`;
  await sendMessage(env, chatId, msg);
}

async function handleMainMenuText(env, user, text) {
  const chatId = user.telegram_id;
  const t = text.trim();

  if (t === "📝 Test tekshirish") {
    await setState(env, chatId, "waiting_test_code");
    await sendMessage(env, chatId, "🔑 Test kodini yuboring (masalan: 1234):");
    return true;
  }
  
  if (t === "📋 Faol testlar") {
    const tests = await getActiveTests(env);
    if (tests.length === 0) {
      await sendMessage(env, chatId, "Hozircha faol testlar yo'q.");
      return true;
    }
    let msg = "📋 <b>Faol testlar:</b>\n\n";
    tests.forEach((t, i) => {
      const type = t.is_quiz ? "🎮 Viktorina" : "📄 Oddiy test";
      const pText = t.price > 0 ? `(💰 ${t.price} so'm)` : "(🎁 Bepul)";
      msg += `${i + 1}. <b>${t.subject || "Test"}</b> ${pText} [${type}]\n🔑 Kodi: <b>${t.code}</b>\n⏱ Taymer: ${t.timer ? t.timer + " daqiqa" : "Yo'q"}\n⏰ Tugash: ${formatDateTime(t.end_time)}\n\n`;
    });
    await sendMessage(env, chatId, msg);
    return true;
  }
  
  if (t === "🏆 Reytingim") {
    await showRating(env, chatId);
    return true;
  }
  
  if (t === "⚙️ Profil") {
    await setState(env, chatId, "profile_menu");
    const msg = `👤 <b>Sizning profilingiz:</b>\n\nIsm: ${user.first_name || "-"}\nFamiliya: ${user.last_name || "-"}\nSinf/Kurs: ${user.grade || "-"}\n\n💳 Hisobingiz: <b>${user.balance || 0} so'm</b>\n\nNimani o'zgartiramiz?`;
    await sendMessage(env, chatId, msg, profileEditKeyboard());
    return true;
  }
  
  if (t === "💰 Hisobim") {
    const card = await getSetting(env, "admin_card") || "Kiritilmagan";
    const msg = `💳 <b>Sizning hisobingiz:</b> ${user.balance || 0} so'm\n\nHisobni to'ldirish uchun ushbu kartaga pul o'tkazing:\n<code>${card}</code>\n\nTo'lov qilganingizdan so'ng, qancha pul o'tkazganingizni yozib yuboring (faqat raqam bilan, masalan: 5000):`;
    await setState(env, chatId, "waiting_deposit_amount");
    await sendMessage(env, chatId, msg);
    return true;
  }
  
  return false;
}

// ================= TEST VA VIKTORINANI ISHLASH =================
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
  
  if (!test) {
    await sendMessage(env, chatId, "❌ Bunday kodli test topilmadi. Qaytadan urinib ko'ring:");
    return;
  }
  
  const now = new Date();
  const start = new Date(test.start_time);
  const end = new Date(test.end_time);
  
  if (test.is_closed || now > end) {
    await sendMessage(env, chatId, "⛔️ Bu testning muddati allaqachon tugagan.");
    await setState(env, chatId, null);
    return;
  }
  
  if (now < start) {
    await sendMessage(env, chatId, "⏳ Bu test hali boshlanmagan. Boshlanish vaqti: " + formatDateTime(test.start_time));
    return;
  }
  
  const existing = await getSubmission(env, test.id, chatId);
  if (existing) {
    await sendMessage(env, chatId, "⚠️ Siz bu testni allaqachon ishlagansiz.");
    await setState(env, chatId, null);
    return;
  }

  // 📢 Majburiy a'zolikni tekshirish
  const sub = await checkSubscription(env, chatId);
  if (!sub.ok) {
    const rows = sub.missing.map(ch => {
      const url = ch.chat_id.startsWith("@") ? "https://t.me/" + ch.chat_id.slice(1) : ch.chat_id;
      return [{ text: "➕ " + (ch.title || "Kanalga o'tish"), url: url }];
    });
    rows.push([{ text: "✅ A'zo bo'ldim", callback_data: "check_sub" }]);
    await sendMessage(env, chatId, "📢 Testni boshlash uchun quyidagi kanallarga a'zo bo'ling:", { inline_keyboard: rows });
    await setState(env, chatId, "waiting_test_code", { pendingCode: cleanCode });
    return;
  }
  
  // 💰 To'lovni tekshirish
  if (test.price > 0) {
    if ((user.balance || 0) < test.price) {
      await sendMessage(env, chatId, `❗️ Bu test narxi: <b>${test.price} so'm</b>.\nSizning hisobingizda <b>${user.balance || 0} so'm</b> mavjud.\n\nIltimos, "💰 Hisobim" bo'limi orqali hisobingizni to'ldiring.`);
      await setState(env, chatId, null);
      return;
    }
    // Pulni yechib olish
    await env.DB.prepare("UPDATE users SET balance = balance - ? WHERE telegram_id = ?").bind(test.price, chatId).run();
    await sendMessage(env, chatId, `💸 Hisobingizdan test uchun ${test.price} so'm yechib olindi.`);
  }

  // ⏱ Shaxsiy taymerni boshlash
  await env.DB.prepare("INSERT INTO test_sessions (test_id, telegram_id) VALUES (?, ?) ON CONFLICT(test_id, telegram_id) DO UPDATE SET started_at = CURRENT_TIMESTAMP").bind(test.id, chatId).run();

  if (test.is_quiz) {
    await sendMessage(env, chatId, `🎮 Viktorina boshlandi! ${test.timer ? "\n⏱ Sizda <b>" + test.timer + " daqiqa</b> vaqt bor." : ""}`);
    await sendNextQuizQuestion(env, chatId, test.id);
  } else {
    const caption = `📄 Sizga test taqdim etildi.\n⏱ Vaqtingiz: <b>${test.timer > 0 ? test.timer + " daqiqa" : "Cheklanmagan"}</b>.\n\n✏️ Javoblaringizni bitta xabar qilib yuboring (masalan: <code>abcdabcd...</code>)`;
    if (test.file_type === "photo") {
      await sendPhoto(env, chatId, test.file_id, caption);
    } else {
      await sendDocument(env, chatId, test.file_id, caption);
    }
    await setState(env, chatId, "waiting_answers:" + test.id);
  }
}

async function sendNextQuizQuestion(env, chatId, testId) {
  const isTimeOk = await checkTestTimer(env, testId, chatId);
  if (!isTimeOk) {
    await finishQuizTest(env, chatId, testId, true);
    return;
  }

  const questions = await env.DB.prepare("SELECT * FROM quiz_questions WHERE test_id = ? ORDER BY id ASC").bind(testId).all();
  const answered = await env.DB.prepare("SELECT question_id FROM user_polls WHERE test_id = ? AND telegram_id = ?").bind(testId, chatId).all();
  const answeredIds = (answered.results || []).map(r => r.question_id);
  
  const nextQ = (questions.results || []).find(q => !answeredIds.includes(q.id));
  
  if (!nextQ) {
    await finishQuizTest(env, chatId, testId, false);
    return;
  }

  const options = JSON.parse(nextQ.options);
  const shuffled = shuffleQuizOptions(options, nextQ.correct_index);
  const res = await sendPoll(env, chatId, nextQ.question, shuffled.shuffledOptions, shuffled.newCorrectIndex);
  
  if (res.ok) {
    await env.DB.prepare("INSERT INTO user_polls (poll_id, test_id, telegram_id, question_id, is_correct, answered) VALUES (?, ?, ?, ?, 0, 0)").bind(res.result.poll.id, testId, chatId, nextQ.id).run();
  }
}

async function handlePollAnswer(env, pollAnswer) {
  const pollId = pollAnswer.poll_id;
  const userId = pollAnswer.user.id;
  
  const pollData = await env.DB.prepare("SELECT * FROM user_polls WHERE poll_id = ?").bind(pollId).first();
  if (!pollData || pollData.answered) return;
  
  const isTimeOk = await checkTestTimer(env, pollData.test_id, userId);
  await env.DB.prepare("UPDATE user_polls SET answered = 1 WHERE poll_id = ?").bind(pollId).run();
  
  if (!isTimeOk) {
    await finishQuizTest(env, userId, pollData.test_id, true);
    return;
  }
  
  await sendNextQuizQuestion(env, userId, pollData.test_id);
}

async function finishQuizTest(env, telegramId, testId, timeout = false) {
  const existing = await getSubmission(env, testId, telegramId);
  if (existing) return;
  
  const test = await env.DB.prepare("SELECT * FROM tests WHERE id = ?").bind(testId).first();
  const points = JSON.parse(test.points || "[]");
  const maxScore = points.reduce((a, b) => a + b, 0);
  
  const msgText = timeout ? "⏰ <b>Vaqt tugadi!</b> Viktorina yakunlandi." : "🎉 <b>Viktorina yakunlandi!</b> Barcha savollarga javob berdingiz.";
  
  await env.DB.prepare("INSERT INTO submissions (test_id, telegram_id, answers, correct_count, total_count, score, max_score) VALUES (?, ?, 'QUIZ', ?, ?, ?, ?)").bind(testId, telegramId, points.length, points.length, maxScore, maxScore).run();
  
  // Kanalga natijani yuborish
  await yuborNatijaniKanalga(env, telegramId, testId, points.length, points.length, maxScore, maxScore);
  
  await sendMessage(env, telegramId, msgText, studentMainMenu());
}

async function handleAnswerSubmission(env, user, testId, answerText) {
  const chatId = user.telegram_id;
  const test = await env.DB.prepare("SELECT * FROM tests WHERE id = ?").bind(testId).first();
  if (!test) {
    await setState(env, chatId, null);
    return;
  }
  
  const isTimeOk = await checkTestTimer(env, testId, chatId);
  if (!isTimeOk) {
    await sendMessage(env, chatId, "⏰ <b>Vaqt tugadi!</b> Shaxsiy taymeringiz yakuniga yetdi. Javoblar qabul qilinmadi.", studentMainMenu());
    await setState(env, chatId, null);
    return;
  }

  const now = new Date();
  const end = new Date(test.end_time);
  if (test.is_closed || now > end) {
    await sendMessage(env, chatId, "⛔️ Afsuski, testning umumiy muddati tugagan.");
    await setState(env, chatId, null);
    return;
  }
  
  const cleaned = answerText.replace(/[^a-zA-Z]/g, "");
  if (cleaned.length === 0) {
    await sendMessage(env, chatId, "❗️ Iltimos, javoblarni harflar bilan yuboring.");
    return;
  }
  
  const points = JSON.parse(test.points || "[]");
  const result = scoreAnswers(cleaned, test.answer_key, points);
  
  await env.DB.prepare("INSERT INTO submissions (test_id, telegram_id, answers, correct_count, total_count, score, max_score) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(testId, chatId, cleaned.toUpperCase(), result.correctCount, result.total, result.score, result.maxScore).run();
  await setState(env, chatId, null);
  
  await yuborNatijaniKanalga(env, chatId, testId, result.correctCount, result.total, result.score, result.maxScore);
  
  const ranking = await getRanking(env, testId);
  const place = ranking.findIndex((r) => r.telegram_id === chatId) + 1;
  const percent = result.maxScore > 0 ? Math.round((result.score / result.maxScore) * 100) : 0;
  const wrongList = result.wrongQuestions.length > 0 ? result.wrongQuestions.join(", ") : "yo'q 🎉";
  
  await sendMessage(env, chatId, `✅ <b>Natijangiz tayyor!</b>\n\n📊 Ball: <b>${result.score} / ${result.maxScore}</b> (${percent}%)\n✔️ To'g'ri javoblar: ${result.correctCount} / ${result.total}\n❌ Xato savollar: ${wrongList}\n🏆 Reyting: <b>${place}-o'rin</b>`, studentMainMenu());
}

async function yuborNatijaniKanalga(env, telegramId, testId, correct, total, score, maxScore) {
  const user = await getUser(env, telegramId);
  const test = await env.DB.prepare("SELECT * FROM tests WHERE id = ?").bind(testId).first();
  const resultsChannels = await getChannels(env, "results");
  
  const ranking = await getRanking(env, testId);
  const place = ranking.findIndex((r) => r.telegram_id === telegramId) + 1;
  
  const channelMsg = `🆕 <b>Yangi natija</b>\n👤 ${user.first_name} ${user.last_name}\n🌍 ${user.region} | ${user.grade}\n📘 Test: ${test.subject || test.code}\n📊 Ball: ${score}/${maxScore}\n🏆 O'rin: ${place}\n🕒 ${formatDateTime(new Date().toISOString())}`;
  
  for (const ch of resultsChannels) {
    await sendMessage(env, ch.chat_id, channelMsg);
  }
}

// ================= ADMIN MANTIG'I =================
async function showAdminMenu(env, chatId, role) {
  await sendMessage(env, chatId, "👑 <b>Admin panel</b>\n\nKerakli bo'limni tanlang:", adminMenuKeyboard(role));
}

async function handleAdminCallback(env, user, data, role) {
  const chatId = user.telegram_id;
  
  if (data === "admin:back") {
    await showAdminMenu(env, chatId, role);
    return true;
  }
  
  if (data === "admin:stats") {
    const c = await env.DB.prepare("SELECT COUNT(*) as c FROM users").first();
    await sendMessage(env, chatId, `📊 Jami botdan ro'yxatdan o'tgan o'quvchilar: <b>${c.c}</b>`, adminMenuKeyboard(role));
    return true;
  }
  
  if (data === "admin:addtest" || data === "admin:addquiz") {
    const isQuiz = data === "admin:addquiz";
    if (isQuiz) {
      const code = await generateTestCode(env);
      const res = await env.DB.prepare("INSERT INTO tests (code, file_id, file_type, created_by, start_time, end_time, answer_key, points, is_quiz, is_closed) VALUES (?, '', 'quiz', ?, datetime('now'), datetime('now'), '', '[]', 1, 1)").bind(code, chatId).run();
      await setState(env, chatId, "admin_quiz_subject", { testId: res.meta.last_row_id });
      await sendMessage(env, chatId, `🎮 Yangi Viktorina yaratilmoqda. Maxsus Kod: <b>${code}</b>\n\nViktorina fani/mavzusini kiriting:`);
    } else {
      await setState(env, chatId, "admin_awaiting_file");
      await sendMessage(env, chatId, `📤 Oddiy test faylini (PDF yoki rasm) Baza kanaliga yuboring.`);
    }
    return true;
  }
  
  if (data === "admin:mytests") {
    const { results } = await env.DB.prepare("SELECT * FROM tests WHERE created_by = ? ORDER BY created_at DESC LIMIT 10").bind(chatId).all();
    if (!results || results.length === 0) {
      await sendMessage(env, chatId, "Sizda hali testlar yo'q.", adminMenuKeyboard(role));
      return true;
    }
    for (const t of results) {
      const subCount = await env.DB.prepare("SELECT COUNT(*) as c FROM submissions WHERE test_id = ?").bind(t.id).first();
      const msg = `📘 <b>${t.subject || "Test"}</b> [${t.is_quiz ? '🎮 Quiz' : '📄 Oddiy'}]\n🔑 Kodi: <b>${t.code}</b>\n💰 Narxi: ${t.price} so'm\n⏱ Taymer: ${t.timer ? t.timer + ' daqiqa' : "Yo'q"}\n✍️ Ishlaganlar: ${subCount.c}`;
      
      // TAHRIRLASH TUGMALARI
      await sendMessage(env, chatId, msg, testEditKeyboard(t.id));
    }
    return true;
  }

  // TESTNI TAHRIRLASH VA O'CHIRISH
  if (data.startsWith("admin:deltest:")) {
    const testId = data.split(":")[2];
    await env.DB.prepare("DELETE FROM tests WHERE id = ?").bind(testId).run();
    await env.DB.prepare("DELETE FROM submissions WHERE test_id = ?").bind(testId).run();
    await env.DB.prepare("DELETE FROM quiz_questions WHERE test_id = ?").bind(testId).run();
    await answerCallbackQuery(env, user.callback_query_id, "✅ Test to'liq o'chirildi!", true);
    return true;
  }
  
  if (data.startsWith("admin:edit:subject:")) {
    const testId = data.split(":")[3];
    await setState(env, chatId, `admin_edit_subject:${testId}`);
    await sendMessage(env, chatId, "Yangi fani/mavzusini kiriting:");
    return true;
  }
  
  if (data.startsWith("admin:edit:price:")) {
    const testId = data.split(":")[3];
    await setState(env, chatId, `admin_edit_price:${testId}`);
    await sendMessage(env, chatId, "Yangi narxni kiriting (Bepul bo'lsa 0):");
    return true;
  }
  
  if (data.startsWith("admin:edit:key:")) {
    const testId = data.split(":")[3];
    await setState(env, chatId, `admin_edit_key:${testId}`);
    await sendMessage(env, chatId, "Yangi javoblar kalitini kiriting (Masalan: ABCD...):");
    return true;
  }
  
  // Qolgan Admin tugmalari
  if (data.startsWith("addtest:points:")) {
    const mode = data.split(":")[2];
    const stateData = getStateData(user);
    if (mode === "equal") {
      await setState(env, chatId, "admin_test_points_equal", stateData);
      await sendMessage(env, chatId, "Bitta savol uchun necha ball bermoqchisiz (masalan: 1):");
    } else {
      await setState(env, chatId, "admin_test_points_custom", stateData);
      await sendMessage(env, chatId, "Ballarni vergul bilan kiriting (masalan: 1,2,1):");
    }
    return true;
  }
  
  if (role === "owner") {
    if (data === "admin:channels") {
      await sendMessage(env, chatId, "📢 Kanallarni boshqarish", channelsMenuKeyboard());
      return true;
    }
    if (data.startsWith("chan:add:")) {
      const type = data.split(":")[2];
      await setState(env, chatId, "admin_channel_add", { type: type });
      await sendMessage(env, chatId, "Kanal qo'shish uchun kanalning username ini yuboring (Masalan: @kanal_nomi):");
      return true;
    }
    if (data === "admin:setcard") {
      await setState(env, chatId, "admin_setcard");
      await sendMessage(env, chatId, "💳 Karta raqamini va ism-sharifni kiriting:\n(Masalan: 8600123456789012 - Palonchiyev P)");
      return true;
    }
    if (data === "admin:addbalance") {
      await setState(env, chatId, "admin_addbalance_id");
      await sendMessage(env, chatId, "💰 Pul qo'shmoqchi bo'lgan foydalanuvchi Telegram ID sini kiriting:");
      return true;
    }
    if (data === "admin:broadcast") {
      await setState(env, chatId, "admin_broadcast_waiting");
      await sendMessage(env, chatId, "✉️ Barcha foydalanuvchilarga yuboriladigan xabar matnini kiriting:");
      return true;
    }
  }
  return false;
}

function channelsMenuKeyboard() {
  return { inline_keyboard: [ 
    [{ text: "➕ Majburiy kanal", callback_data: "chan:add:required" }], 
    [{ text: "🗄 Baza kanali", callback_data: "chan:add:base" }], 
    [{ text: "🏆 Natijalar kanali", callback_data: "chan:add:results" }], 
    [{ text: "⬅️ Orqaga", callback_data: "admin:back" }] 
  ] };
}

// BARCHA MATNLI ADMIN VA TO'LOV BUYRUQLARI
async function handleAddTestText(env, user, text) {
  const chatId = user.telegram_id;
  const data = getStateData(user);
  const t = text.trim();
  
  // ==== TESTNI TAHRIRLASH MATNLARI ====
  if (user.state && user.state.startsWith("admin_edit_subject:")) {
    const testId = user.state.split(":")[1];
    await env.DB.prepare("UPDATE tests SET subject = ? WHERE id = ?").bind(t, testId).run();
    await setState(env, chatId, null);
    await sendMessage(env, chatId, "✅ Test nomi yangilandi!", adminMenuKeyboard(await isAdmin(env, chatId)));
    return true;
  }
  if (user.state && user.state.startsWith("admin_edit_price:")) {
    const testId = user.state.split(":")[1];
    const p = parseInt(t.replace(/\D/g, "")) || 0;
    await env.DB.prepare("UPDATE tests SET price = ? WHERE id = ?").bind(p, testId).run();
    await setState(env, chatId, null);
    await sendMessage(env, chatId, "✅ Test narxi yangilandi!", adminMenuKeyboard(await isAdmin(env, chatId)));
    return true;
  }
  if (user.state && user.state.startsWith("admin_edit_key:")) {
    const testId = user.state.split(":")[1];
    const key = t.replace(/[^a-zA-Z]/g, "").toUpperCase();
    await env.DB.prepare("UPDATE tests SET answer_key = ? WHERE id = ?").bind(key, testId).run();
    await setState(env, chatId, "admin_test_points_mode", { testId: testId });
    await sendMessage(env, chatId, "✅ Javoblar yangilandi. Endi yangi javoblarga ballarni belgilaymiz:", pointsModeKeyboard());
    return true;
  }

  // ==== YANGI TEST YARATISH JARAYONLARI ====
  if (user.state === "admin_test_subject" || user.state === "admin_quiz_subject") {
    await env.DB.prepare("UPDATE tests SET subject = ? WHERE id = ?").bind(t, data.testId).run();
    await setState(env, chatId, user.state.replace("subject", "start"), data);
    await sendMessage(env, chatId, "⏰ Boshlanish vaqtini kiriting (KK.OO.YYYY SS:DD):");
    return true;
  }
  
  if (user.state === "admin_test_start" || user.state === "admin_quiz_start") {
    const iso = parseUserDateTime(t);
    if (!iso) {
      await sendMessage(env, chatId, "❗️ Noto'g'ri format. KK.OO.YYYY SS:DD shaklida kiriting:");
      return true;
    }
    await env.DB.prepare("UPDATE tests SET start_time = ? WHERE id = ?").bind(iso, data.testId).run();
    await setState(env, chatId, user.state.replace("start", "end"), data);
    await sendMessage(env, chatId, "⏰ Tugash vaqtini kiriting (KK.OO.YYYY SS:DD):");
    return true;
  }
  
  if (user.state === "admin_test_end" || user.state === "admin_quiz_end") {
    const iso = parseUserDateTime(t);
    if (!iso) {
      await sendMessage(env, chatId, "❗️ Noto'g'ri format. Qayta kiriting:");
      return true;
    }
    await env.DB.prepare("UPDATE tests SET end_time = ? WHERE id = ?").bind(iso, data.testId).run();
    await setState(env, chatId, user.state.replace("end", "timer"), data);
    await sendMessage(env, chatId, "⏱ Shaxsiy Taymer qancha bo'lsin (daqiqa)?\n(Taymer kerak bo'lmasa 0 deb yozing):");
    return true;
  }
  
  if (user.state === "admin_test_timer" || user.state === "admin_quiz_timer") {
    const timer = parseInt(t) || 0;
    await env.DB.prepare("UPDATE tests SET timer = ? WHERE id = ?").bind(timer, data.testId).run();
    
    if (user.state.includes("quiz")) {
      await setState(env, chatId, "admin_quiz_questions", data);
      await sendMessage(env, chatId, "📝 Viktorina savollarini yuboring. To'g'ri javob oxiriga + qo'ying.\nBarcha savollarni yuborib bo'lgach, <b>Tugatish</b> deb yozing.");
    } else {
      await setState(env, chatId, "admin_test_key", data);
      await sendMessage(env, chatId, "🔑 Javoblar kalitini kiriting (ABCD...):");
    }
    return true;
  }
  
  if (user.state === "admin_test_key") {
    const key = t.replace(/[^a-zA-Z]/g, "").toUpperCase();
    await env.DB.prepare("UPDATE tests SET answer_key = ? WHERE id = ?").bind(key, data.testId).run();
    await setState(env, chatId, "admin_test_points_mode", data);
    await sendMessage(env, chatId, "Ballarni qanday belgilaymiz?", pointsModeKeyboard());
    return true;
  }
  
  if (user.state === "admin_test_points_equal") {
    const val = parseFloat(t.replace(",", "."));
    const test = await env.DB.prepare("SELECT answer_key FROM tests WHERE id = ?").bind(data.testId).first();
    const points = new Array(test.answer_key.length).fill(val);
    await env.DB.prepare("UPDATE tests SET points = ? WHERE id = ?").bind(JSON.stringify(points), data.testId).run();
    await setState(env, chatId, "admin_test_price", data);
    await sendMessage(env, chatId, "💰 Bu test narxi qancha?\nBepul bo'lsa 0 deb yozing:");
    return true;
  }
  
  if (user.state === "admin_quiz_questions") {
    if (t.toLowerCase() === "tugatish") {
      const qCount = await env.DB.prepare("SELECT COUNT(*) as c FROM quiz_questions WHERE test_id = ?").bind(data.testId).first();
      const points = new Array(qCount.c).fill(1); // Viktorinaga avtomat 1 balldan
      await env.DB.prepare("UPDATE tests SET points = ? WHERE id = ?").bind(JSON.stringify(points), data.testId).run();
      await setState(env, chatId, "admin_quiz_price", data);
      await sendMessage(env, chatId, `✅ Qabul qilingan savollar: ${qCount.c} ta.\n\n💰 Bu test narxi qancha? (Bepul bo'lsa 0):`);
      return true;
    }
    const qData = parseQuizBlock(t);
    if (!qData) {
      await sendMessage(env, chatId, "❌ Format xato! Yoki tugatgan bo'lsangiz Tugatish deb yozing.");
      return true;
    }
    await env.DB.prepare("INSERT INTO quiz_questions (test_id, question, options, correct_index) VALUES (?, ?, ?, ?)").bind(data.testId, qData.question, JSON.stringify(qData.options), qData.correctIndex).run();
    await sendMessage(env, chatId, "✅ Savol saqlandi. Keyingisini yuboring (yoki Tugatish):");
    return true;
  }

  // Narx kiritish
  if (user.state === "admin_test_price" || user.state === "admin_quiz_price") {
    const price = parseInt(t.replace(/\D/g, "")) || 0;
    await env.DB.prepare("UPDATE tests SET price = ?, is_closed = 0 WHERE id = ?").bind(price, data.testId).run();
    await setState(env, chatId, null);
    await sendMessage(env, chatId, `🎉 <b>Test faollashtirildi!</b>\n💰 Narxi: ${price > 0 ? price + " so'm" : "Bepul"}`, adminMenuKeyboard(await isAdmin(env, chatId)));
    return true;
  }

  // ==== SOZLAMALAR VA TO'LOVLAR ====
  if (user.state === "admin_channel_add" && t.startsWith("@")) {
    await env.DB.prepare("INSERT INTO channels (chat_id, title, type, added_by) VALUES (?, ?, ?, ?)").bind(t, t, data.type, chatId).run();
    await setState(env, chatId, null);
    await sendMessage(env, chatId, "✅ Kanal muvaffaqiyatli qo'shildi!");
    return true;
  }

  if (user.state === "admin_broadcast_waiting") {
    await setState(env, chatId, null);
    await sendMessage(env, chatId, "✅ Xabar barchaga muvaffaqiyatli jo'natildi (Simulyatsiya).");
    return true;
  }
  
  if (user.state === "admin_setcard") {
    await setSetting(env, "admin_card", t);
    await setState(env, chatId, null);
    await sendMessage(env, chatId, "✅ Karta ma'lumotlari muvaffaqiyatli saqlandi.", adminMenuKeyboard("owner"));
    return true;
  }
  
  if (user.state === "admin_addbalance_id") {
    const targetId = parseInt(t.replace(/\D/g, ""));
    await setState(env, chatId, "admin_addbalance_amount", { targetId: targetId });
    await sendMessage(env, chatId, `ID qabul qilindi. Qancha summa qo'shmoqchisiz?`);
    return true;
  }
  
  if (user.state === "admin_addbalance_amount") {
    const amount = parseInt(t.replace(/\D/g, ""));
    await env.DB.prepare("UPDATE users SET balance = balance + ? WHERE telegram_id = ?").bind(amount, data.targetId).run();
    await setState(env, chatId, null);
    await sendMessage(env, chatId, `✅ ID ${data.targetId} hisobiga ${amount} so'm qo'shildi.`, adminMenuKeyboard("owner"));
    await sendMessage(env, data.targetId, `🎉 <b>Hisobingiz to'ldirildi!</b>\n💰 Qo'shilgan summa: ${amount} so'm`);
    return true;
  }
  
  // O'quvchi pul tashlaganini bildirganda
  if (user.state === "waiting_deposit_amount") {
    await setState(env, chatId, null);
    await sendMessage(env, chatId, "⏳ So'rovingiz adminga yuborildi. To'lov tasdiqlangach hisobingiz to'ldiriladi.");
    await sendMessage(env, env.OWNER_ID, `💵 <b>Yangi to'lov xabari!</b>\n👤 Foydalanuvchi ID: <code>${chatId}</code>\n💰 Summa: <b>${parseInt(t.replace(/\D/g, ""))} so'm</b>\nIltimos, kartani tekshirib admin paneldan balansni to'ldirib qo'ying.`);
    return true;
  }
  
  return false;
}

// ================= ASOSIY EVENT ROUTER =================
async function handleUpdate(update, env) {
  // Viktorina javoblari
  if (update.poll_answer) {
    await handlePollAnswer(env, update.poll_answer);
    return;
  }
  
  // Baza kanalidan kelgan hujjat/rasm (Oddiy test fayli)
  if (update.channel_post) {
    const post = update.channel_post;
    const fileId = post.document ? post.document.file_id : (post.photo ? post.photo[post.photo.length - 1].file_id : null);
    if (!fileId) return;
    
    // Yoki forward orqali kanal qo'shish jarayoni bo'lsa
    if (update.channel_post.chat) {
       // Tekshirishlar davom etadi...
    }
    
    const { results } = await env.DB.prepare("SELECT telegram_id FROM users WHERE state = 'admin_awaiting_file' LIMIT 1").all();
    if (results && results.length > 0) {
      const waitingAdminId = results[0].telegram_id;
      const code = await generateTestCode(env);
      const fileType = post.document ? 'document' : 'photo';
      
      const res = await env.DB.prepare("INSERT INTO tests (code, file_id, file_type, created_by, start_time, end_time, answer_key, points, is_quiz, is_closed) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), '', '[]', 0, 1)").bind(code, fileId, fileType, waitingAdminId).run();
      await setState(env, waitingAdminId, "admin_test_subject", { testId: res.meta.last_row_id });
      await sendMessage(env, waitingAdminId, `✅ Oddiy test fayli qabul qilindi. Kodi: <b>${code}</b>\n\nTestning fani/mavzusini kiriting:`);
    }
    return;
  }
  
  // Tugmalar bosilganda
  if (update.callback_query) {
    const cb = update.callback_query;
    const user = await ensureUser(env, cb.from.id);
    await answerCallbackQuery(env, cb.id);
    
    if (cb.data === "check_sub") {
      const sub = await checkSubscription(env, cb.from.id);
      if (!sub.ok) {
        await answerCallbackQuery(env, cb.id, "Kanalga to'liq a'zo bo'lmagansiz!", true);
        return;
      }
      const data = getStateData(user);
      if (data.pendingCode) {
        await handleTestCode(env, user, data.pendingCode);
      } else {
        await sendMessage(env, cb.from.id, "✅ Rahmat! Test kodini qayta yuboring.");
        await setState(env, cb.from.id, "waiting_test_code");
      }
      return;
    }
    
    if (cb.data.startsWith("reg:")) {
      await handleRegistrationCallback(env, user, cb.data);
      return;
    }
    if (cb.data.startsWith("profile:") || (user.state && user.state.startsWith("profile_edit_") && cb.data.startsWith("reg:region:"))) {
      await handleProfileEditCallback(env, user, cb.data);
      return;
    }
    
    const role = await isAdmin(env, cb.from.id);
    if (role && (cb.data.startsWith("admin:") || cb.data.startsWith("addtest:") || cb.data.startsWith("chan:"))) {
      await handleAdminCallback(env, user, cb.data, role);
      return;
    }
  }

  // Shaxsiy xabarlar (Botdagi barcha chatlar)
  if (update.message && update.message.chat.type === "private") {
    const msg = update.message;
    const chatId = msg.chat.id;
    const text = msg.text || "";
    
    // Kanal qo'shish (forward qilingan xabar orqali ushlab olish)
    let user = await ensureUser(env, chatId);
    if (user.state === "admin_channel_add" && msg.forward_from_chat) {
        const title = msg.forward_from_chat.title || msg.forward_from_chat.username || String(msg.forward_from_chat.id);
        const chat_id = String(msg.forward_from_chat.id);
        const type = getStateData(user).type;
        await env.DB.prepare("INSERT INTO channels (chat_id, title, type, added_by) VALUES (?, ?, ?, ?)").bind(chat_id, title, type, chatId).run();
        await setState(env, chatId, null);
        await sendMessage(env, chatId, "✅ Kanal muvaffaqiyatli qo'shildi!");
        return;
    }
    
    if (text === "/start") {
      if (user.registered) {
        await sendMessage(env, chatId, "🏠 Bosh menyu:", studentMainMenu());
      } else {
        await setState(env, chatId, "reg_name");
        await sendMessage(env, chatId, "👋 Assalomu alaykum! Ismingizni kiriting:");
      }
      return;
    }
    
    if (text === "/admin") {
      const role = await isAdmin(env, chatId);
      if (role) {
        await showAdminMenu(env, chatId, role);
      } else {
        await sendMessage(env, chatId, "⛔️ Sizda admin huquqi yo'q.");
      }
      return;
    }
    
    // Agar asosiy menyudagi biror tugma bosilsa, har qanday kutishni to'xtatish
    if (["📝 Test tekshirish", "📋 Faol testlar", "🏆 Reytingim", "⚙️ Profil", "💰 Hisobim"].includes(text)) {
      await setState(env, chatId, null);
      user.state = null;
    }
    
    // Ro'yxatdan o'tish qadami
    if (["reg_name", "reg_lastname", "reg_fathername"].includes(user.state)) {
      await handleRegistrationText(env, user, text);
      return;
    }
    
    if (!user.registered) return;
    
    // Profilni tahrirlash (Matn yozish)
    if (user.state && user.state.startsWith("profile_edit_")) {
      await handleProfileEditText(env, user, text);
      return;
    }
    
    // Adminning matnli buyruqlari
    if ((user.state && user.state.startsWith("admin_")) || user.state === "waiting_deposit_amount") {
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
}

// ================= CRON: REJALASHTIRILGAN VAZIFALAR =================
async function runScheduledTasks(env) {
  try {
    // Vaqti tugagan testlarni yopish va Natijalar kanaliga yakuniy xabar berish
    const { results } = await env.DB.prepare("SELECT * FROM tests WHERE is_closed = 0 AND datetime('now') > end_time").all();
    
    for (const test of results || []) {
      await env.DB.prepare("UPDATE tests SET is_closed = 1 WHERE id = ?").bind(test.id).run();
      
      const ranking = await getRanking(env, test.id);
      if (ranking.length > 0) {
         let msg = `🏁 <b>"${test.subject || test.code}"</b> testi yakunlandi!\n\n🏆 <b>Yakuniy Reyting:</b>\n`;
         ranking.slice(0, 10).forEach((r, i) => {
            msg += `${i+1}. ${r.first_name} ${r.last_name} — ${r.score} ball\n`;
         });
         
         const resultsChannels = await getChannels(env, "results");
         for (const ch of resultsChannels) {
           await sendMessage(env, ch.chat_id, msg);
         }
      }
    }
  } catch (err) {
    console.log("Cron xato:", err.message);
  }
}






