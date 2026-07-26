export default {
  async fetch(request, env) {
    if (request.method === "POST") {
      const payload = await request.json();
      
      if (payload.message) {
        const chatId = payload.message.chat.id;
        const text = payload.message.text;

        if (text === "/start") {
          await sendMessage(env.BOT_TOKEN, chatId, "Salom! Men Cloudflare'da muvaffaqiyatli ishga tushdim.");
        }
      }
      return new Response("OK", { status: 200 });
    }
    
    return new Response("Cloudflare Worker ishlayapti!", { status: 200 });
  }
};

async function sendMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text })
  });
}
