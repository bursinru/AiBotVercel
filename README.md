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

Необходимо задать как минимум один токен:

- `TELEGRAM_BOT_TOKEN` — токен бота от BotFather
- `OPENAI_API_KEY` — (опционально) ключ OpenAI. Если его не задать, бот будет делать простой эхо-ответ с подсказкой.

Для локальной разработки можно создать файл `.env.local` (не коммить в git):

```bash
TELEGRAM_BOT_TOKEN=ваш_telegram_токен
OPENAI_API_KEY=ваш_openai_ключ
```

На Vercel задайте переменные окружения в настройках проекта (`Environment Variables`).

### 4. Структура проекта

- `api/telegram.js` — серверлес-функция, которую вызывает Telegram (вебхук).
- `vercel.json` — конфигурация функций Vercel (runtime Node.js 18).
- `package.json` — базовый пакетный файл проекта.

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

### 7. Как это работает

1. Пользователь пишет сообщение боту в Telegram.
2. Telegram отправляет `POST` запрос на ваш вебхук `/api/telegram`.
3. Функция из `api/telegram.js`:
   - Парсит апдейт и извлекает `chat_id` и `text`.
   - Вызывает `callAi(text)`, который:
     - Если задан `OPENAI_API_KEY`, обращается к OpenAI Chat Completions (`gpt-4.1-mini`).
     - Если ключа нет — возвращает простой эхо-текст.
   - Отправляет ответ обратно в чат с помощью `sendMessage`.

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

