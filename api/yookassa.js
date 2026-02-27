// Вебхук ЮKassa: при успешной оплате активируем подписку и уведомляем пользователя в Telegram.

const TELEGRAM_API = "https://api.telegram.org";

let kv;
try {
  kv = require("@vercel/kv").kv;
} catch {
  kv = null;
}

async function setSubscription(userId, data) {
  if (kv) await kv.set(`sub:${userId}`, data);
}

async function sendTelegramMessage(token, chatId, text) {
  await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" })
  });
}

async function getPaymentDetails(paymentId) {
  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secret = process.env.YOOKASSA_SECRET;
  if (!shopId || !secret) return null;
  const auth = Buffer.from(`${shopId}:${secret}`).toString("base64");
  const res = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  if (!res.ok) return null;
  return res.json();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: "Bot token not set" });

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const event = body.event;
  const paymentId = body.object?.id;

  if (event !== "payment.succeeded" || !paymentId) {
    return res.status(200).json({ ok: true });
  }

  const payment = await getPaymentDetails(paymentId);
  if (!payment || payment.status !== "succeeded") {
    return res.status(200).json({ ok: true });
  }

  const userId = payment.metadata?.user_id;
  const planKey = payment.metadata?.plan;
  const days = Number(payment.metadata?.days) || 30;

  if (!userId || !planKey) {
    console.error("YooKassa webhook: no user_id or plan in metadata");
    return res.status(200).json({ ok: true });
  }

  const expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
  await setSubscription(userId, { expiresAt, plan: planKey });

  const until = new Date(expiresAt).toLocaleDateString("ru-RU");
  await sendTelegramMessage(
    token,
    userId,
    `✅ Оплата получена. Подписка активна до ${until}. Можешь пользоваться генерацией фото.`
  );

  res.status(200).json({ ok: true });
};
