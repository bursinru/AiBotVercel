// Простой Telegram AI-бот как серверлес-функция Vercel

const TELEGRAM_API = "https://api.telegram.org";

// Память сессий (ограниченная и недолговечная — живет пока «теплый» инстанс функции)
// Ключ: chatId, значение: { history, model, awaitImagePrompt?, awaitImageRef?, imageRefUrl?, imageModel?, awaitVideoPrompt?, videoProvider?, videoTemplate? }
const sessions = new Map();

// Подписки: userId -> { expiresAt: number (ms), plan: string }. In-memory; для продакшена лучше Vercel KV/DB.
const subscriptions = new Map();
// Ожидающие платежи: paymentId -> { userId, plan, amount } (для вебхука ЮKassa)
const pendingPayments = new Map();

const ADMIN_TELEGRAM_ID = 114868027;

// Тарифы подписки (руб, длительность в днях)
const SUBSCRIPTION_PLANS = {
  "1m": { price: 199, days: 30, label: "1 месяц — 199 ₽" },
  "3m": { price: 499, days: 90, label: "3 месяца — 499 ₽" }
};

// Глобальные настройки (живут пока «теплый» инстанс функции).
// Менять может только админ.
const globalSettings = {
  // Дополнительные правила/стиль общения, применяются ко ВСЕМ пользователям.
  // По умолчанию — мягкий «двачер»-стайл без токсичности.
  style:
    "Пиши как ироничный двачер: можно лёгкий сленг и шуточки, но без оскорблений, жести, токсичности, угроз, дискриминации и политики."
};

const DEFAULT_MODEL = "gpt-5-mini";
const SUPPORTED_MODELS = {
  "gpt-5-mini": "Облегчённая и более дешёвая GPT‑5 модель по умолчанию.",
  "gpt-4.1-mini": "Быстрый и дешевый, подходит для большинства задач.",
  "gpt-4.1": "Более качественный, но дороже и медленнее.",
  "gpt-4o-mini": "Оптимизированный для мультимодальности, дешёвый.",
  "gpt-4o": "Флагманский мультимодальный, лучший, но дороже."
};

// Vercel KV для подписок (между api/telegram и api/yookassa). Если KV не настроен — подписки только in-memory.
let kv;
try {
  kv = require("@vercel/kv").kv;
} catch {
  kv = null;
}
async function getSubscription(userId) {
  if (!kv) return subscriptions.get(String(userId)) || null;
  const v = await kv.get(`sub:${userId}`);
  return v ? { expiresAt: v.expiresAt, plan: v.plan } : null;
}
async function setSubscription(userId, data) {
  subscriptions.set(String(userId), data);
  if (kv) await kv.set(`sub:${userId}`, data);
}
async function hasActiveSubscription(userId) {
  const sub = await getSubscription(userId);
  return sub && sub.expiresAt > Date.now();
}

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      history: [],
      model: DEFAULT_MODEL,
      egorMoscowGreeted: false
    });
  }
  return sessions.get(chatId);
}

function resetSession(chatId) {
  sessions.delete(chatId);
}

function buildSystemPrompt() {
  const base =
    "Ты дружелюбный помощник, который кратко и по делу отвечает на русском языке, может объяснять шаг за шагом и учитывать контекст прошлых сообщений." +
    "\nТакже знай и учитывай, когда это уместно: человек по имени «Егор Кузнецов» живёт в Кемерово.";
  const style = typeof globalSettings.style === "string" ? globalSettings.style.trim() : "";
  if (!style) return base;
  return `${base}\n\nДополнительный стиль общения (глобально): ${style}`;
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

function isAdminUser(userId) {
  return Number(userId) === Number(process.env.TELEGRAM_ADMIN_ID || ADMIN_TELEGRAM_ID);
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
    gpt5mini: "gpt-5-mini",
    "gpt-5-mini": "gpt-5-mini",
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

function parseStyleCommand(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/style")) return null;

  const rest = trimmed.replace(/^\/style\s*/i, "");
  if (!rest) return { action: "show" };

  if (rest.toLowerCase() === "reset") return { action: "reset" };
  if (rest.toLowerCase() === "off") return { action: "reset" };

  return { action: "set", value: rest };
}

function parseFetchCommand(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/fetch")) return null;
  const rest = trimmed.replace(/^\/fetch\s*/i, "").trim();
  if (!rest) return { action: "help" };
  return { action: "fetch", url: rest };
}

function parseCodeCommand(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/code")) return null;
  const rest = trimmed.replace(/^\/code\s*/i, "").trim();
  if (!rest) return { action: "help" };
  return { action: "gen", instruction: rest };
}

function looksLikePrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "127.0.0.1" || h === "::1") return true;
  if (h.startsWith("127.")) return true;
  if (h.startsWith("10.")) return true;
  if (h.startsWith("192.168.")) return true;
  if (h.startsWith("169.254.")) return true;
  // 172.16.0.0 — 172.31.255.255
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  return false;
}

async function fetchTextFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Некорректный URL." };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, error: "Разрешены только http/https ссылки." };
  }
  if (looksLikePrivateHost(parsed.hostname)) {
    return { ok: false, error: "Этот хост недоступен (защита от SSRF)." };
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(parsed.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "ai-telegram-bot-vercel/1.0"
      }
    });

    if (!res.ok) {
      return { ok: false, error: `Не удалось скачать страницу (HTTP ${res.status}).` };
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text") && !contentType.includes("json") && !contentType.includes("xml") && !contentType.includes("html")) {
      return { ok: false, error: `Неподдерживаемый тип контента: ${contentType || "unknown"}` };
    }

    const text = await res.text();
    const clipped = text.slice(0, 30_000); // ограничим размер
    return { ok: true, text: clipped };
  } catch (e) {
    return { ok: false, error: "Ошибка при скачивании страницы (timeout/сеть)." };
  } finally {
    clearTimeout(t);
  }
}

// ——— Меню (inline) ———
function buildMainMenuKeyboard(isAdmin) {
  const rows = [
    [{ text: "💬 Чат с AI", callback_data: "menu_chat" }],
    [{ text: "🖼 Генерация фото", callback_data: "menu_image" }],
    [
      { text: "🎬 Видео (Sora)", callback_data: "menu_video" },
      { text: "🎬 Видео (Veo 3)", callback_data: "menu_video_veo" }
    ],
    [
      { text: "📋 Подписка", callback_data: "menu_subscription" },
      { text: "👤 Профиль", callback_data: "menu_profile" }
    ]
  ];
  if (isAdmin) rows.push([{ text: "⚙ Админка", callback_data: "menu_admin" }]);
  return { inline_keyboard: rows };
}

function buildSubscriptionKeyboard() {
  const rows = Object.entries(SUBSCRIPTION_PLANS).map(([key, plan]) => [
    { text: plan.label, callback_data: `pay_${key}` }
  ]);
  rows.push([{ text: "◀ В меню", callback_data: "menu_main" }]);
  return { inline_keyboard: rows };
}

function buildBackToMenuKeyboard() {
  return { inline_keyboard: [[{ text: "◀ В меню", callback_data: "menu_main" }]] };
}

// ——— Генерация изображений (Google Imagen / Gemini) ———
const IMAGE_MODELS = {
  "imagen-3.0-generate-002": "Imagen 3",
  "imagen-3.0-fast-generate-001": "Imagen 3 Fast"
};
const DEFAULT_IMAGE_MODEL = "imagen-3.0-generate-002";

function buildImageSubMenuKeyboard(currentModel) {
  const modelId = currentModel || DEFAULT_IMAGE_MODEL;
  const rows = [
    [{ text: "📝 Только по описанию", callback_data: "img_text_only" }],
    [{ text: "🖼 С референсом (загрузить своё фото)", callback_data: "img_with_ref" }],
    [
      {
        text: (modelId === "imagen-3.0-generate-002" ? "✓ " : "") + (IMAGE_MODELS["imagen-3.0-generate-002"] || "Imagen 3"),
        callback_data: "img_model_imagen-3.0-generate-002"
      },
      {
        text: (modelId === "imagen-3.0-fast-generate-001" ? "✓ " : "") + (IMAGE_MODELS["imagen-3.0-fast-generate-001"] || "Imagen 3 Fast"),
        callback_data: "img_model_imagen-3.0-fast-generate-001"
      }
    ],
    [{ text: "◀ В меню", callback_data: "menu_main" }]
  ];
  return { inline_keyboard: rows };
}

async function generateImageWithGoogle(prompt, modelId, referenceImageUrl) {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) return { ok: false, error: "GOOGLE_GENERATIVE_AI_API_KEY не задан." };
  const model = modelId || DEFAULT_IMAGE_MODEL;

  if (referenceImageUrl) {
    try {
      const imageRes = await fetch(referenceImageUrl);
      if (!imageRes.ok) return { ok: false, error: "Не удалось загрузить референс." };
      const imageBytes = await imageRes.arrayBuffer();
      const imageB64 = Buffer.from(imageBytes).toString("base64");
      const mimeType = imageRes.headers.get("content-type") || "image/jpeg";
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  { inlineData: { mimeType, data: imageB64 } },
                  { text: `Создай новое изображение по описанию, используя это фото как референс (стиль/объект): ${prompt}` }
                ]
              }
            ],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
          })
        }
      );
      if (!geminiRes.ok) {
        const err = await geminiRes.text();
        console.error("Gemini image gen error:", err);
        return { ok: false, error: "Ошибка генерации по референсу. Попробуй без референса или другую модель." };
      }
      const data = await geminiRes.json();
      const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      const b64 = part?.inlineData?.data;
      if (!b64) return { ok: false, error: "Нет изображения в ответе." };
      return { ok: true, buffer: Buffer.from(b64, "base64") };
    } catch (e) {
      console.error("Gemini ref image failed:", e);
      return { ok: false, error: "Ошибка при генерации по референсу." };
    }
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: "1:1"
        }
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Google Imagen API error:", errText);
      return { ok: false, error: "Ошибка генерации изображения. Проверь ключ и квоты." };
    }

    const data = await res.json();
    const b64 = data?.predictions?.[0]?.bytesBase64Encoded ?? data?.predictions?.[0]?.image?.bytesBase64Encoded;
    if (!b64) return { ok: false, error: "Нет изображения в ответе API." };
    return { ok: true, buffer: Buffer.from(b64, "base64") };
  } catch (e) {
    console.error("Google Imagen request failed:", e);
    return { ok: false, error: "Сеть или таймаут при генерации." };
  }
}

async function sendTelegramPhoto(token, chatId, buffer, caption) {
  const FormData = require("form-data");
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", buffer, { filename: "image.png" });
  if (caption) form.append("caption", caption);
  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendPhoto`, {
    method: "POST",
    body: form,
    headers: form.getHeaders()
  });
  if (!res.ok) console.error("Failed to send photo:", await res.text());
}

// Шаблоны людей для Sora: референс-картинка по ключу (URL задаётся в env).
const VIDEO_TEMPLATES = {
  josephpeach88: process.env.VIDEO_TEMPLATE_JOSEPHPEACH88_URL || ""
};

function buildVideoSubMenuKeyboard() {
  const rows = [
    [{ text: "Sora — обычное видео", callback_data: "video_sora" }],
    [{ text: "Sora с шаблоном @josephpeach88", callback_data: "video_sora_josephpeach88" }],
    [{ text: "◀ Назад", callback_data: "menu_main" }]
  ];
  return { inline_keyboard: rows };
}

// ——— Генерация видео (OpenAI Sora) ———
const SORA_MODEL = "sora-2";
const SORA_POLL_INTERVAL_MS = 5000;
const SORA_POLL_ATTEMPTS = 12; // до ~60 сек

async function createSoraVideo(prompt, inputReferenceUrl) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "OPENAI_API_KEY не задан." };
  const body = {
    model: SORA_MODEL,
    prompt: prompt.slice(0, 2000),
    seconds: "8",
    size: "1280x720"
  };
  if (inputReferenceUrl && inputReferenceUrl.startsWith("http")) {
    body.input_reference = inputReferenceUrl;
  }
  try {
    const res = await fetch("https://api.openai.com/v1/videos", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("Sora create error:", err);
      return { ok: false, error: "Ошибка создания видео. Проверь ключ и квоты Sora." };
    }
    const data = await res.json();
    return { ok: true, videoId: data.id };
  } catch (e) {
    console.error("Sora create failed:", e);
    return { ok: false, error: "Сеть или таймаут при создании видео." };
  }
}

async function getSoraVideoStatus(videoId) {
  const apiKey = process.env.OPENAI_API_KEY;
  const res = await fetch(`https://api.openai.com/v1/videos/${videoId}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.status; // queued | in_progress | completed | failed
}

async function getSoraVideoContent(videoId) {
  const apiKey = process.env.OPENAI_API_KEY;
  const res = await fetch(`https://api.openai.com/v1/videos/${videoId}/content`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

// ——— Генерация видео (Google Veo 3) ———
const VEO_POLL_INTERVAL_MS = 6000;
const VEO_POLL_ATTEMPTS = 15;

async function createVeo3Video(prompt) {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) return { ok: false, error: "GOOGLE_GENERATIVE_AI_API_KEY не задан." };
  const model = "veo-3.1-generate-preview";
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateVideos`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          prompt: prompt.slice(0, 2000),
          aspectRatio: "16:9",
          durationSeconds: 8,
          sampleCount: 1
        })
      }
    );
    if (!res.ok) {
      const err = await res.text();
      console.error("Veo create error:", err);
      return { ok: false, error: "Ошибка Veo 3. Проверь ключ и доступ к модели." };
    }
    const data = await res.json();
    const opName = data.name || data.operation?.name;
    if (!opName) return { ok: false, error: "Нет operation в ответе Veo." };
    return { ok: true, operationName: opName };
  } catch (e) {
    console.error("Veo create failed:", e);
    return { ok: false, error: "Сеть или таймаут при создании видео Veo." };
  }
}

async function pollVeo3Operation(operationName) {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const base = "https://generativelanguage.googleapis.com/v1beta";
  const url = operationName.startsWith("http") ? operationName : `${base}/${operationName}`;
  const res = await fetch(url, { headers: { "x-goog-api-key": apiKey } });
  if (!res.ok) return { done: false };
  const data = await res.json();
  const done = data.done === true;
  const videoUri = data.response?.video?.uri || data.response?.uri;
  const videoBase64 = data.response?.video?.bytesBase64Encoded;
  return {
    done,
    videoUri: typeof videoUri === "string" ? videoUri : null,
    videoBase64: typeof videoBase64 === "string" ? videoBase64 : null
  };
}

async function getVeo3VideoContent(videoUri, videoBase64) {
  if (videoBase64) return Buffer.from(videoBase64, "base64");
  if (!videoUri) return null;
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const sep = videoUri.includes("?") ? "&" : "?";
  const res = await fetch(videoUri + sep + "key=" + encodeURIComponent(apiKey));
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function sendTelegramVideo(token, chatId, buffer, caption) {
  const FormData = require("form-data");
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("video", buffer, { filename: "video.mp4" });
  if (caption) form.append("caption", caption);
  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendVideo`, {
    method: "POST",
    body: form,
    headers: form.getHeaders()
  });
  if (!res.ok) console.error("Failed to send video:", await res.text());
}

async function answerCallbackQuery(token, callbackQueryId, text) {
  await fetch(`${TELEGRAM_API}/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text: text || undefined })
  });
}

async function editMessageText(token, chatId, messageId, text, replyMarkup) {
  await fetch(`${TELEGRAM_API}/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "Markdown",
      reply_markup: replyMarkup
    })
  });
}

async function createYooKassaPayment(userId, planKey, plan) {
  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secret = process.env.YOOKASSA_SECRET;
  if (!shopId || !secret) return null;

  const idempotenceKey = `ai-bot-${userId}-${planKey}-${Date.now()}`;
  const amount = plan.price.toFixed(2);
  const returnUrl = process.env.YOOKASSA_RETURN_URL || `https://t.me/${process.env.BOT_USERNAME || "bot"}`;

  const auth = Buffer.from(`${shopId}:${secret}`).toString("base64");
  const res = await fetch("https://api.yookassa.ru/v3/payments", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotence-Key": idempotenceKey,
      Authorization: `Basic ${auth}`
    },
    body: JSON.stringify({
      amount: { value: amount, currency: "RUB" },
      confirmation: { type: "redirect", return_url: returnUrl },
      capture: true,
      description: `Подписка AI-бот: ${plan.label}`,
      metadata: { user_id: String(userId), plan: planKey, days: plan.days }
    })
  });

  if (!res.ok) {
    console.error("YooKassa create payment error:", await res.text());
    return null;
  }
  const data = await res.json();
  return data.confirmation?.confirmation_url || null;
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

  // ——— Обработка callback (меню, подписка, админка) ———
  const callbackQuery = update?.callback_query;
  if (callbackQuery) {
    const cbData = callbackQuery.data;
    const chatId = callbackQuery.message?.chat?.id;
    const messageId = callbackQuery.message?.message_id;
    const fromUserId = callbackQuery.from?.id;
    const isAdmin = isAdminUser(fromUserId);

    await answerCallbackQuery(token, callbackQuery.id);

    if (cbData === "menu_main" || cbData === "menu_chat") {
      await editMessageText(
        token,
        chatId,
        messageId,
        "Главное меню. Пиши сюда для чата с AI или выбери действие ниже.",
        buildMainMenuKeyboard(isAdmin)
      );
      return res.status(200).json({ ok: true });
    }

    if (cbData === "menu_image") {
      const session = getSession(chatId);
      const modelId = session.imageModel || DEFAULT_IMAGE_MODEL;
      await editMessageText(
        token,
        chatId,
        messageId,
        `🖼 *Генерация фото*\nТип: только описание или с референсом. Модель: *${IMAGE_MODELS[modelId] || modelId}*.`,
        buildImageSubMenuKeyboard(modelId)
      );
      return res.status(200).json({ ok: true });
    }

    if (cbData === "img_text_only") {
      getSession(chatId).awaitImagePrompt = true;
      getSession(chatId).awaitImageRef = false;
      getSession(chatId).imageRefUrl = undefined;
      const modelId = getSession(chatId).imageModel || DEFAULT_IMAGE_MODEL;
      await editMessageText(
        token,
        chatId,
        messageId,
        `📝 Напиши описание картинки. Модель: *${IMAGE_MODELS[modelId] || modelId}*.`,
        buildBackToMenuKeyboard()
      );
      return res.status(200).json({ ok: true });
    }

    if (cbData === "img_with_ref") {
      getSession(chatId).awaitImageRef = true;
      getSession(chatId).awaitImagePrompt = false;
      getSession(chatId).imageRefUrl = undefined;
      await editMessageText(
        token,
        chatId,
        messageId,
        "🖼 Сначала отправь *одно фото* как референс (стиль или объект). Потом напишешь описание.",
        buildBackToMenuKeyboard()
      );
      return res.status(200).json({ ok: true });
    }

    if (cbData && cbData.startsWith("img_model_")) {
      const modelId = cbData.replace("img_model_", "");
      if (IMAGE_MODELS[modelId]) {
        getSession(chatId).imageModel = modelId;
        await editMessageText(
          token,
          chatId,
          messageId,
          `Модель: *${IMAGE_MODELS[modelId]}*. Выбери тип генерации выше или напиши описание.`,
          buildImageSubMenuKeyboard(modelId)
        );
      }
      return res.status(200).json({ ok: true });
    }

    if (cbData === "menu_video") {
      await editMessageText(
        token,
        chatId,
        messageId,
        "🎬 *Видео (Sora)*\nВыбери тип: обычное видео или с шаблоном человека.",
        buildVideoSubMenuKeyboard()
      );
      return res.status(200).json({ ok: true });
    }

    if (cbData === "video_sora" || cbData === "video_sora_josephpeach88") {
      const session = getSession(chatId);
      session.awaitVideoPrompt = true;
      session.videoProvider = "sora";
      session.videoTemplate = cbData === "video_sora_josephpeach88" ? "josephpeach88" : "";
      const templateNote =
        session.videoTemplate && VIDEO_TEMPLATES[session.videoTemplate]
          ? "\nИспользуется шаблон @josephpeach88 (референс человека)."
          : session.videoTemplate
            ? "\nШаблон @josephpeach88 не настроен (нет VIDEO_TEMPLATE_JOSEPHPEACH88_URL)."
            : "";
      await editMessageText(
        token,
        chatId,
        messageId,
        "🎬 *Sora*\nНапиши описание сцены — создам видео (8 сек)." + templateNote,
        buildBackToMenuKeyboard()
      );
      return res.status(200).json({ ok: true });
    }

    if (cbData === "menu_video_veo") {
      getSession(chatId).awaitVideoPrompt = true;
      getSession(chatId).videoProvider = "veo3";
      getSession(chatId).videoTemplate = "";
      await editMessageText(
        token,
        chatId,
        messageId,
        "🎬 *Veo 3* (Google)\nНапиши описание сцены — создам видео (8 сек, 16:9).",
        buildBackToMenuKeyboard()
      );
      return res.status(200).json({ ok: true });
    }

    if (cbData === "menu_subscription") {
      const sub = await getSubscription(fromUserId);
      const hasSub = sub && sub.expiresAt > Date.now();
      const text = hasSub
        ? `Подписка активна до ${new Date(sub.expiresAt).toLocaleDateString("ru-RU")}.`
        : "Оформи подписку, чтобы пользоваться генерацией фото без ограничений.";
      await editMessageText(token, chatId, messageId, text, buildSubscriptionKeyboard());
      return res.status(200).json({ ok: true });
    }

    if (cbData === "menu_profile") {
      const sub = await getSubscription(fromUserId);
      const hasSub = sub && sub.expiresAt > Date.now();
      const profileText = hasSub
        ? `👤 Профиль\nПодписка: до ${new Date(sub.expiresAt).toLocaleDateString("ru-RU")}`
        : "👤 Профиль\nПодписка не оформлена. Нажми «Подписка» в меню.";
      await editMessageText(token, chatId, messageId, profileText, buildBackToMenuKeyboard());
      return res.status(200).json({ ok: true });
    }

    if (cbData === "menu_admin") {
      if (!isAdmin) {
        await sendTelegramMessage(token, chatId, "Доступ только у админа.");
        return res.status(200).json({ ok: true });
      }
      await editMessageText(
        token,
        chatId,
        messageId,
        "Админка: /admin, /style, /fetch, /code",
        buildBackToMenuKeyboard()
      );
      return res.status(200).json({ ok: true });
    }

    if (cbData && cbData.startsWith("pay_")) {
      const planKey = cbData.replace("pay_", "");
      const plan = SUBSCRIPTION_PLANS[planKey];
      if (!plan) return res.status(200).json({ ok: true });

      const payUrl = await createYooKassaPayment(fromUserId, planKey, plan);
      if (!payUrl) {
        await editMessageText(
          token,
          chatId,
          messageId,
          "Оплата временно недоступна. Проверь настройки YOOKASSA_* в Vercel.",
          buildSubscriptionKeyboard()
        );
        return res.status(200).json({ ok: true });
      }
      await editMessageText(
        token,
        chatId,
        messageId,
        `Оплата: *${plan.label}*\n\n[Перейти к оплате](${payUrl})\n\nПосле оплаты подписка активируется автоматически.`,
        buildSubscriptionKeyboard()
      );
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  }

  const message = update?.message;
  const fromUserId = message?.from?.id;
  const chatId = message?.chat?.id;

  if (!chatId || !message) {
    return res.status(200).json({ ok: true });
  }

  const isAdmin = isAdminUser(fromUserId);
  const session = getSession(chatId);
  const text = message.text;
  const photos = message.photo;

  // Персональное приветствие для пользователя с ID 69878827
  if (Number(fromUserId) === 69878827 && !session.egorMoscowGreeted) {
    session.egorMoscowGreeted = true;
    await sendTelegramMessage(token, chatId, "Я знаю, что ты Егор Кузнецов из Москвы.");
    return res.status(200).json({ ok: true });
  }

  // ——— Режим «референс»: пользователь отправил фото как референс ———
  if (session.awaitImageRef && Array.isArray(photos) && photos.length > 0) {
    const largestPhoto = photos[photos.length - 1];
    const fileUrl = await getFileUrl(token, largestPhoto.file_id);
    if (fileUrl) {
      session.imageRefUrl = fileUrl;
      session.awaitImageRef = false;
      session.awaitImagePrompt = true;
      const modelId = session.imageModel || DEFAULT_IMAGE_MODEL;
      await sendTelegramMessage(
        token,
        chatId,
        `Референс сохранён. Напиши описание картинки (в стиле этого фото или с этим объектом). Модель: *${IMAGE_MODELS[modelId] || modelId}*.`,
        { reply_markup: buildBackToMenuKeyboard() }
      );
    } else {
      await sendTelegramMessage(token, chatId, "Не получилось загрузить фото. Попробуй ещё раз.");
    }
    return res.status(200).json({ ok: true });
  }

  // ——— Генерация фото по запросу (после выбора типа и/или референса) ———
  if (session.awaitImagePrompt && typeof text === "string" && text.trim()) {
    const modelId = session.imageModel || DEFAULT_IMAGE_MODEL;
    const refUrl = session.imageRefUrl;
    session.awaitImagePrompt = false;
    session.imageRefUrl = undefined;
    const hasSub = (await hasActiveSubscription(fromUserId)) || isAdmin;
    if (!hasSub) {
      await sendTelegramMessage(
        token,
        chatId,
        "Генерация фото доступна по подписке. Нажми меню → Подписка.",
        { reply_markup: buildBackToMenuKeyboard() }
      );
      return res.status(200).json({ ok: true });
    }
    await sendTelegramMessage(
      token,
      chatId,
      refUrl ? "Генерирую картинку по референсу…" : "Генерирую картинку…"
    );
    const result = await generateImageWithGoogle(text.trim(), modelId, refUrl);
    if (!result.ok) {
      await sendTelegramMessage(token, chatId, `Ошибка: ${result.error}`);
      return res.status(200).json({ ok: true });
    }
    await sendTelegramPhoto(token, chatId, result.buffer, text.trim());
    return res.status(200).json({ ok: true });
  }

  if (session.awaitVideoPrompt && typeof text === "string" && text.trim()) {
    const provider = session.videoProvider || "sora";
    const templateKey = session.videoTemplate || "";
    session.awaitVideoPrompt = false;
    session.videoProvider = undefined;
    session.videoTemplate = undefined;

    const hasSub = (await hasActiveSubscription(fromUserId)) || isAdmin;
    if (!hasSub) {
      await sendTelegramMessage(
        token,
        chatId,
        "Генерация видео доступна по подписке. Нажми меню → Подписка.",
        { reply_markup: buildBackToMenuKeyboard() }
      );
      return res.status(200).json({ ok: true });
    }

    if (provider === "veo3") {
      await sendTelegramMessage(token, chatId, "Ставлю видео в очередь (Veo 3). Жду готовности…");
      const created = await createVeo3Video(text.trim());
      if (!created.ok) {
        await sendTelegramMessage(token, chatId, `Ошибка: ${created.error}`);
        return res.status(200).json({ ok: true });
      }
      let result = await pollVeo3Operation(created.operationName);
      for (let i = 0; i < VEO_POLL_ATTEMPTS && !result.done; i++) {
        await new Promise((r) => setTimeout(r, VEO_POLL_INTERVAL_MS));
        result = await pollVeo3Operation(created.operationName);
      }
      if (!result.done || (!result.videoUri && !result.videoBase64)) {
        await sendTelegramMessage(
          token,
          chatId,
          "Veo 3 ещё рендерится или формат ответа изменился. Попробуй позже."
        );
        return res.status(200).json({ ok: true });
      }
      const videoBuffer = await getVeo3VideoContent(result.videoUri, result.videoBase64);
      if (!videoBuffer || videoBuffer.length === 0) {
        await sendTelegramMessage(token, chatId, "Не удалось скачать видео Veo.");
        return res.status(200).json({ ok: true });
      }
      await sendTelegramVideo(token, chatId, videoBuffer, text.trim());
      return res.status(200).json({ ok: true });
    }

    // Sora
    const inputRef = templateKey && VIDEO_TEMPLATES[templateKey] ? VIDEO_TEMPLATES[templateKey] : null;
    await sendTelegramMessage(token, chatId, "Ставлю видео в очередь (Sora). Жду готовности…");
    const created = await createSoraVideo(text.trim(), inputRef || undefined);
    if (!created.ok) {
      await sendTelegramMessage(token, chatId, `Ошибка: ${created.error}`);
      return res.status(200).json({ ok: true });
    }
    let status = await getSoraVideoStatus(created.videoId);
    for (let i = 0; i < SORA_POLL_ATTEMPTS && status !== "completed" && status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, SORA_POLL_INTERVAL_MS));
      status = await getSoraVideoStatus(created.videoId);
    }
    if (status === "failed") {
      await sendTelegramMessage(token, chatId, "Генерация видео не прошла. Попробуй другой текст.");
      return res.status(200).json({ ok: true });
    }
    if (status !== "completed") {
      await sendTelegramMessage(
        token,
        chatId,
        "Видео ещё рендерится. Попробуй через минуту снова (меню → Видео)."
      );
      return res.status(200).json({ ok: true });
    }
    const videoBuffer = await getSoraVideoContent(created.videoId);
    if (!videoBuffer || videoBuffer.length === 0) {
      await sendTelegramMessage(token, chatId, "Не удалось скачать видео.");
      return res.status(200).json({ ok: true });
    }
    await sendTelegramVideo(token, chatId, videoBuffer, text.trim());
    return res.status(200).json({ ok: true });
  }

  // Команды
  if (typeof text === "string" && text.startsWith("/")) {
    if (text.startsWith("/start")) {
      const name = message.from?.first_name || "друг";
      await sendTelegramMessage(
        token,
        chatId,
        `Привет, ${name}. Выбери действие в меню ниже.`,
        { reply_markup: buildMainMenuKeyboard(isAdmin) }
      );
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith("/help")) {
      const baseHelp =
        "Команды:\n" +
        "• /reset — очистить память диалога (только для этого чата)\n" +
        "• /model — показать текущую модель\n" +
        "• /model list — список моделей\n" +
        "• /model <name> — выбрать модель\n";
      const adminHelp =
        "\nАдмин:\n" +
        "• /admin — админ-меню\n" +
        "• /style — показать глобальный стиль\n" +
        "• /style <текст> — задать глобальный стиль для всех\n" +
        "• /style reset — сбросить глобальный стиль\n" +
        "• /fetch <url> — скачать страницу и кратко пересказать\n" +
        "• /code <задача> — сгенерировать патч/инструкции по коду (без авто-применения)\n";

      await sendTelegramMessage(token, chatId, isAdmin ? baseHelp + adminHelp : baseHelp);
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith("/reset")) {
      resetSession(chatId);
      await sendTelegramMessage(token, chatId, "Память диалога очищена. Начнём заново 🙂");
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith("/admin")) {
      if (!isAdmin) {
        await sendTelegramMessage(token, chatId, "Команда доступна только админу.");
        return res.status(200).json({ ok: true });
      }
      const style = globalSettings.style ? `\nТекущий стиль: ${globalSettings.style}` : "\nСтиль: (не задан)";
      await sendTelegramMessage(
        token,
        chatId,
        "Админка:\n" +
          "• /style — посмотреть стиль\n" +
          "• /style <текст> — задать стиль\n" +
          "• /style reset — сбросить стиль\n" +
          "• /fetch <url> — пересказать страницу\n" +
          "• /code <задача> — сгенерировать патч/инструкции\n" +
          style
      );
      return res.status(200).json({ ok: true });
    }

    const styleCmd = parseStyleCommand(text);
    if (styleCmd) {
      if (!isAdmin) {
        await sendTelegramMessage(token, chatId, "Команда доступна только админу.");
        return res.status(200).json({ ok: true });
      }

      if (styleCmd.action === "show") {
        await sendTelegramMessage(
          token,
          chatId,
          globalSettings.style ? `Глобальный стиль: ${globalSettings.style}` : "Глобальный стиль не задан."
        );
        return res.status(200).json({ ok: true });
      }

      if (styleCmd.action === "reset") {
        globalSettings.style = "";
        await sendTelegramMessage(token, chatId, "Глобальный стиль сброшен.");
        return res.status(200).json({ ok: true });
      }

      if (styleCmd.action === "set") {
        globalSettings.style = String(styleCmd.value).slice(0, 600);
        await sendTelegramMessage(token, chatId, "Глобальный стиль сохранён и применяется ко всем пользователям.");
        return res.status(200).json({ ok: true });
      }
    }

    const fetchCmd = parseFetchCommand(text);
    if (fetchCmd) {
      if (!isAdmin) {
        await sendTelegramMessage(token, chatId, "Команда доступна только админу.");
        return res.status(200).json({ ok: true });
      }
      if (fetchCmd.action === "help") {
        await sendTelegramMessage(token, chatId, "Использование: /fetch https://example.com");
        return res.status(200).json({ ok: true });
      }

      const r = await fetchTextFromUrl(fetchCmd.url);
      if (!r.ok) {
        await sendTelegramMessage(token, chatId, `Не получилось: ${r.error}`);
        return res.status(200).json({ ok: true });
      }

      const userContentParts = [
        {
          type: "text",
          text:
            "Кратко перескажи содержимое страницы и выпиши ключевые пункты списком. Если это статья — добавь TL;DR.\n\n" +
            `URL: ${fetchCmd.url}\n\n` +
            `Текст страницы (обрезан):\n${r.text}`
        }
      ];
      const replyText = await callAi({ chatId, userContentParts });
      await sendTelegramMessage(token, chatId, replyText);
      return res.status(200).json({ ok: true });
    }

    const codeCmd = parseCodeCommand(text);
    if (codeCmd) {
      if (!isAdmin) {
        await sendTelegramMessage(token, chatId, "Команда доступна только админу.");
        return res.status(200).json({ ok: true });
      }
      if (codeCmd.action === "help") {
        await sendTelegramMessage(token, chatId, "Использование: /code <что нужно изменить/добавить в коде>");
        return res.status(200).json({ ok: true });
      }

      const userContentParts = [
        {
          type: "text",
          text:
            "Ты помогаешь вносить изменения в проект Telegram-бота на Vercel. " +
            "Сгенерируй план и патч в формате unified diff (без применения). " +
            "Если не хватает контекста — перечисли, какие файлы/фрагменты нужны.\n\n" +
            `Задача: ${codeCmd.instruction}`
        }
      ];
      const replyText = await callAi({ chatId, userContentParts });
      await sendTelegramMessage(
        token,
        chatId,
        replyText.length > 3500 ? replyText.slice(0, 3500) + "\n\n(обрезано)" : replyText
      );
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

