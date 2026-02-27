## Простой AI Telegram-бот на Vercel

Этот проект — минимальный пример Telegram-бота, работающего через вебхук на Vercel и использующего AI (OpenAI) для генерации ответов.

### 1. Требования

- Node.js 18+ (локально для отладки)
- Установленный `vercel` CLI (по желанию, можно деплоить через веб-интерфейс)
- Аккаунт в Telegram и созданный бот через BotFather
- (Опционально) OpenAI API key для AI-ответов

### 2. Установка зависимостей

В проекте пока нет внешних зависимостей, но перед деплоем рекомендуется установить `vercel` глобально:

```bash
npm install -g vercel
```

Инициализация (один раз, если нужно):

```bash
vercel
```

### 3. Переменные окружения

Обязательно:

- `TELEGRAM_BOT_TOKEN` — токен бота от BotFather

Опционально:

- `OPENAI_API_KEY` — ключ OpenAI для чата с AI (без него — эхо-режим).
- `GOOGLE_GENERATIVE_AI_API_KEY` — ключ [Google AI Studio](https://aistudio.google.com/apikey) для генерации фото (Imagen). Без него кнопка «Генерация фото» будет требовать подписку, но генерация не заработает без ключа.
- `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET` — для приёма оплаты подписки (ЮKassa). Без них подписку оформить нельзя.
- `YOOKASSA_RETURN_URL` — URL после оплаты (по умолчанию `https://t.me/ИМЯ_БОТА`).
- `TELEGRAM_ADMIN_ID` — Telegram ID админа (по умолчанию зашит один ID). Админ видит кнопку «Админка», команды /style, /fetch, /code и может генерировать фото/видео без подписки.
- `VIDEO_TEMPLATE_JOSEPHPEACH88_URL` — публичный URL изображения человека для шаблона Sora «@josephpeach88». Если задан, при выборе «Sora с шаблоном @josephpeach88» этот URL передаётся в Sora как `input_reference`.

Для подписок между инстансами нужен **Vercel KV**: создай KV Store в Vercel и подключи к проекту — тогда данные подписок сохраняются после вебхука ЮKassa.

Для локальной разработки можно создать файл `.env.local` (не коммить в git). На Vercel задайте переменные в настройках проекта (`Environment Variables`).

### 4. Структура проекта

- `api/telegram.js` — вебхук бота: меню, чат с AI, генерация фото (Google Imagen), подписки, админка.
- `api/yookassa.js` — вебхук ЮKassa: при успешной оплате активирует подписку и пишет пользователю в Telegram.
- `package.json` — зависимости: `@vercel/kv`, `form-data`.

### 5. Локальный запуск (через Vercel Dev)

```bash
vercel dev
```

По умолчанию функция будет доступна локально по адресу вроде:

- `http://localhost:3000/api/telegram`

### 6. Настройка Telegram вебхука

1. Создайте бота у `@BotFather` и получите `TELEGRAM_BOT_TOKEN`.
2. Задеплойте проект на Vercel и получите URL проекта, например:
   - `https://your-project-name.vercel.app`
3. Настройте вебхук (можно через браузер или `curl`):

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-project-name.vercel.app/api/telegram"}'
```

Замените:

- `<TELEGRAM_BOT_TOKEN>` на реальный токен
- `https://your-project-name.vercel.app` на реальный Vercel URL

### 7. Меню, подписки и ЮKassa

- **Меню**: по `/start` показывается inline-меню (Чат с AI, Генерация фото, Подписка, Профиль; у админа — Админка).
- **Генерация фото**: кнопка «Генерация фото» → пользователь пишет описание → бот вызывает Google Imagen API и отправляет картинку. Доступно по подписке (админ — без подписки).
- **Генерация видео**: в меню две опции — **Sora** (OpenAI) и **Veo 3** (Google). Для Sora можно выбрать «обычное видео» или «с шаблоном @josephpeach88» (референс человека): в env задаётся `VIDEO_TEMPLATE_JOSEPHPEACH88_URL` — публичный URL картинки человека, Sora использует его как `input_reference`. Veo 3 вызывается через Gemini API (`GOOGLE_GENERATIVE_AI_API_KEY`), модель `veo-3.1-generate-preview`. Доступ по подписке (админ — без подписки).
- **Подписки**: кнопка «Подписка» → выбор тарифа (1 мес / 3 мес) → создаётся платёж ЮKassa, пользователь переходит по ссылке и платит. После оплаты ЮKassa шлёт вебхук на `POST /api/yookassa`; бот активирует подписку (Vercel KV) и пишет пользователю в Telegram.
- **Вебхук ЮKassa**: в [кабинете ЮKassa](https://yookassa.ru/my/merchant/integration/http-notifications) укажи URL: `https://ВАШ-ДОМЕН.vercel.app/api/yookassa`.

### 8. Деплой на Vercel

Через CLI:

```bash
vercel --prod
```

Или через веб-интерфейс Vercel (импорт репозитория, указание переменных окружения и деплой).

После деплоя не забудьте ещё раз настроить вебхук на финальный продовый URL.

### 9. Быстрый чек

Если открыть в браузере `https://your-project-name.vercel.app/api/telegram` (GET-запрос), вы должны увидеть простой JSON:

```json
{ "ok": true, "message": "Telegram bot is running." }
```

Это значит, что функция задеплоена и готова принимать вебхуки от Telegram.

