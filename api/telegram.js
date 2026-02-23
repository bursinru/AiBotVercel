// Простой Telegram AI-бот как серверлес-функция Vercel

const TELEGRAM_API = "https://api.telegram.org";

async function callAi(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    // Если ключа нет, просто эхо-ответ
    return `Ты написал: "${prompt}". Чтобы включить AI-ответы, задай переменную окружения OPENAI_API_KEY.`;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content: "Ты дружелюбный помощник, который кратко отвечает на русском языке."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      console.error("OpenAI API error:", await response.text());
      return "Произошла ошибка при обращении к AI. Попробуй еще раз позже.";
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || "Не получилось сгенерировать ответ.";
  } catch (err) {
    console.error("OpenAI request failed:", err);
    return "Не удалось связаться с AI-сервисом.";
  }
}

async function sendTelegramMessage(token, chatId, text) {
  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown"
    })
  });

  if (!res.ok) {
    console.error("Failed to send Telegram message:", await res.text());
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, message: "Telegram bot is running." });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set");
    return res.status(500).json({ ok: false, error: "Bot token is not configured" });
  }

  const update = req.body;

  const message = update?.message;
  const chatId = message?.chat?.id;
  const text = message?.text;

  if (!chatId || !text) {
    return res.status(200).json({ ok: true });
  }

  const replyText = await callAi(text);

  await sendTelegramMessage(token, chatId, replyText);

  // Telegram требует быстрый 200 OK
  res.status(200).json({ ok: true });
};

