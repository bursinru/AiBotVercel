// Простой Telegram AI-бот как серверлес-функция Vercel

const TELEGRAM_API = "https://api.telegram.org";

// Память сессий (ограниченная и недолговечная — живет пока «теплый» инстанс функции)
// Ключ: chatId, значение: { history: [{ role, content }], model: string }
const sessions = new Map();

const DEFAULT_MODEL = "gpt-4.1-mini";
const SUPPORTED_MODELS = {
  "gpt-4.1-mini": "Быстрый и дешевый, подходит для большинства задач.",
  "gpt-4.1": "Более качественный, но дороже и медленнее.",
  "gpt-4o-mini": "Оптимизированный для мультимодальности, дешёвый.",
  "gpt-4o": "Флагманский мультимодальный, лучший, но дороже."
};

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      history: [],
      model: DEFAULT_MODEL
    });
  }
  return sessions.get(chatId);
}

function resetSession(chatId) {
  sessions.delete(chatId);
}

function buildSystemPrompt() {
  return "Ты дружелюбный помощник, который кратко и по делу отвечает на русском языке, может объяснять шаг за шагом и учитывать контекст прошлых сообщений.";
}

async function callAi({ chatId, userContentParts }) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return `Я пока работаю в упрощённом режиме без AI. Чтобы включить полноценные ответы, задай переменную окружения OPENAI_API_KEY. Ты написал: "${userContentParts.map(p => (typeof p === "string" ? p : "[медиа]")).join(" ")}"`;
  }

  const session = getSession(chatId);
  const model = session.model || DEFAULT_MODEL;

  const messages = [
    {
      role: "system",
      content: buildSystemPrompt()
    },
    ...session.history,
    {
      role: "user",
      content: userContentParts
    }
  ];

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages
      })
    });

    if (!response.ok) {
      console.error("OpenAI API error:", await response.text());
      return "Произошла ошибка при обращении к AI. Попробуй еще раз позже.";
    }

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content?.trim() || "Не получилось сгенерировать ответ.";

    // Обновляем историю (ограничиваем длину, чтобы не раздувать контекст)
    session.history.push(
      {
        role: "user",
        content: userContentParts
      },
      {
        role: "assistant",
        content: answer
      }
    );
    if (session.history.length > 20) {
      session.history = session.history.slice(-20);
    }

    return answer;
  } catch (err) {
    console.error("OpenAI request failed:", err);
    return "Не удалось связаться с AI-сервисом.";
  }
}

async function sendTelegramMessage(token, chatId, text, extra = {}) {
  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      ...extra
    })
  });

  if (!res.ok) {
    console.error("Failed to send Telegram message:", await res.text());
  }
}

async function getFileUrl(token, fileId) {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!res.ok) {
    console.error("Failed to get file:", await res.text());
    return null;
  }
  const data = await res.json();
  const filePath = data?.result?.file_path;
  if (!filePath) return null;
  return `${TELEGRAM_API}/file/bot${token}/${filePath}`;
}

function parseModelCommand(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/model")) return null;

  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return { action: "show" };
  }

  const arg = parts[1].toLowerCase();
  if (arg === "list") {
    return { action: "list" };
  }

  return { action: "set", model: arg };
}

function normalizeModelName(input) {
  const value = input.toLowerCase();
  if (SUPPORTED_MODELS[value]) return value;

  const aliases = {
    gpt4: "gpt-4.1",
    "gpt-4": "gpt-4.1",
    gpt4mini: "gpt-4.1-mini",
    "gpt-4-mini": "gpt-4.1-mini",
    gpt4o: "gpt-4o",
    "gpt-4o-mini": "gpt-4o-mini"
  };

  if (aliases[value]) return aliases[value];

  return null;
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

  if (!chatId || !message) {
    return res.status(200).json({ ok: true });
  }

  const session = getSession(chatId);
  const text = message.text;
  const photos = message.photo;

  // Команды
  if (typeof text === "string" && text.startsWith("/")) {
    if (text.startsWith("/reset")) {
      resetSession(chatId);
      await sendTelegramMessage(token, chatId, "Память диалога очищена. Начнём заново 🙂");
      return res.status(200).json({ ok: true });
    }

    const modelCmd = parseModelCommand(text);
    if (modelCmd) {
      if (modelCmd.action === "show") {
        const current = getSession(chatId).model || DEFAULT_MODEL;
        await sendTelegramMessage(
          token,
          chatId,
          `Текущая модель: *${current}*.\nНапиши /model list, чтобы увидеть доступные варианты.`
        );
        return res.status(200).json({ ok: true });
      }

      if (modelCmd.action === "list") {
        const lines = Object.entries(SUPPORTED_MODELS).map(
          ([name, desc]) => `• *${name}* — ${desc}`
        );
        await sendTelegramMessage(
          token,
          chatId,
          `Доступные модели:\n${lines.join("\n")}\n\nЧтобы выбрать модель, напиши, например: /model gpt-4.1-mini`
        );
        return res.status(200).json({ ok: true });
      }

      if (modelCmd.action === "set") {
        const normalized = normalizeModelName(modelCmd.model);
        if (!normalized) {
          await sendTelegramMessage(
            token,
            chatId,
            "Я не знаю такую модель. Напиши /model list, чтобы увидеть доступные варианты."
          );
          return res.status(200).json({ ok: true });
        }

        const s = getSession(chatId);
        s.model = normalized;
        await sendTelegramMessage(
          token,
          chatId,
          `Модель установлена на *${normalized}*.\nОна будет использоваться для следующих сообщений.`
        );
        return res.status(200).json({ ok: true });
      }
    }
  }

  // Обработка фото
  if (Array.isArray(photos) && photos.length > 0) {
    const largestPhoto = photos[photos.length - 1];
    const fileId = largestPhoto.file_id;
    const fileUrl = await getFileUrl(token, fileId);

    if (!fileUrl) {
      await sendTelegramMessage(
        token,
        chatId,
        "Не получилось получить картинку с серверов Telegram. Попробуй ещё раз."
      );
      return res.status(200).json({ ok: true });
    }

    const caption = typeof message.caption === "string" ? message.caption : "";
    const promptText =
      caption && caption.trim().length > 0
        ? caption.trim()
        : "Опиши подробно, что изображено на этой картинке. Если есть текст, перепиши его.";

    const userContentParts = [
      {
        type: "text",
        text: promptText
      },
      {
        type: "image_url",
        image_url: {
          url: fileUrl
        }
      }
    ];

    const replyText = await callAi({ chatId, userContentParts });
    await sendTelegramMessage(token, chatId, replyText);

    return res.status(200).json({ ok: true });
  }

  // Обычный текст
  if (typeof text === "string" && text.trim().length > 0) {
    const userContentParts = [
      {
        type: "text",
        text
      }
    ];

    const replyText = await callAi({ chatId, userContentParts });
    await sendTelegramMessage(token, chatId, replyText);

    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: true });
};

