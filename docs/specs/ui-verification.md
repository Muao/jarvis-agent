# UI-перевірка зміни перед PR

**Статус:** draft (2026-11-08) · **Автор:** власник + Jarvis · **Стадія:** Reviewing

Воркер, перш ніж відкрити draft PR, має сам подивитися на те, що зробив: підняти застосунок,
пройти браузером сценарії з `spec.md`, зняти скриншоти і вкласти їх у тіло pull request.

## 1. Навіщо

Зараз пайплайн доводить зміну до PR на підставі тестів, лінтера і тайпчека. Для UI це слабке
свідчення: тести можуть бути зелені, а кнопка — не клікатися, сторінка — впасти на гідрації,
верстка — поїхати. Власник дізнається про це тільки тоді, коли сам відкриє PR, стягне гілку і
запустить dev-сервер. Тобто найдорожчий крок перевірки лежить на людині.

Правило WRK-10 в `agent/prompts/worker.md` уже вимагає саме цього поведінку («UI change: start the dev
server per `AGENTS.md`, open the page in a browser **if a browser tool is available**…»). Дірка не в
промпті — браузерного інструмента в системі немає, тож умова ніколи не виконується, і воркер щоразу
законно пише в PR «браузера не було».

Ця специфікація закриває дірку: дає інструмент, обмежує його і визначає, що саме вважається
перевіркою.

## 2. Межі

**Цілі**

- Воркер проходить браузером acceptance criteria зі `spec.md`, які стосуються UI, і для кожного дає
  вердикт.
- Скриншоти лежать інлайном у тілі draft PR, а не лінками, по яких треба клікати.
- UI-перевірка не може стати нескінченною: у неї є лізинг часу, стеля сценаріїв і стеля раундів
  виправлень, і всі вони нав'язані ззовні агента.
- Працює однаково на ноуті та в контейнері (`docker/runtime`), бо перший живий ран планується на сервері.

**Не цілі**

- Не пишемо постійні e2e-тести в цільовий репозиторій. UI-перевірка — це свідчення для одного PR, а не
  артефакт, що лишається в коді.
- Не робимо візуальної регресії (порівняння з baseline-скриншотом). Немає baseline — немає і сенсу.
- Не ходимо браузером у зовнішній інтернет і не логінимося в чужі сервіси.
- Не робимо галереї скриншотів у власному UI Jarvis (власник вибрав PR як місце показу). Це природне
  наступне розширення, не частина цієї версії.
- Не робимо перевірки мобільних вьюпортів, доступності (axe) і перформансу. Місце для них у
  `ui-tester` є, але не в першій версії.

**Анти-цілі** — те, що робить фічу провалом, навіть якщо технічно вона працює

- Агент сам вирішує, яку команду запустити як dev-сервер. Команда — це власницький конфіг, не вибір
  моделі.
- Витік процесів: `pnpm dev`, який лишився жити після рану і тримає порт.
- PR, у тілі якого зламані картинки.
- UI-перевірка, яка з'їдає бюджет рану і не дає воркеру дійти до PR.

## 3. Рішення власника (2026-11-08)

| Питання | Рішення |
|---|---|
| Куди скриншоти | У тіло PR через недокументований `uploads.github.com/user-attachments/assets` |
| Хто водить браузер | Субагент `ui-tester` у воркера, на стадії Reviewing |
| Критерій «працює» | Проходження UI-сценаріїв, виведених із `spec.md` |
| Де працює | І на ноуті, і в контейнері на сервері |
| Модель субагентів | `sonnet` |

## 4. Що в нас уже є

Ця фіча майже цілком складається з наявних деталей.

| Що потрібно | Де вже лежить |
|---|---|
| Канал для сторонніх MCP-серверів воркеру | `buildMcpConfig` у `engine/src/infrastructure/claude/run-files.ts` — підмішує `mcpServers` з `~/.jarvis/mcp/servers.json` і підставляє `${VAR}` із секретів; лише для ролі `worker` |
| Місце для скриншотів | `<artifactsDir>/screenshots/` — `artifacts.dirFor(task.id)`, уже передається у `workerFirstMessage` |
| Шаблон субагента | `agent/agents/reviewer.md` — frontmatter `name/description/tools/model`, контракт Input → Check → Output |
| Місце для інструментів агента | `shared/src/mcp.ts` (`toolInputSchemas`, `toolsByRole`) + `engine/src/presentation/mcp/server.ts` (ADR-0005) |
| Токен і доступ до GitHub | `GitHubCodeHost` (`@octokit/rest`) з `createRedactor` на токені |
| Межа раундів виправлень | `limits.reviewRounds` + `TRANSITIONS['Reviewing'] → 'Implementing'` із причиною `rounds_exhausted` |
| Одночасність | `limits.maxConcurrentWorkers: 1` — один воркер, отже один браузер |
| Місце для лімітів | `limits` у `shared/src/config.ts`, strict-схема, гаряче перечитування |
| Playwright як залежність | у `web/` уже є `@playwright/test@1.64.1` для наших e2e — але це наш репозиторій, не рантайм агента |

Чого немає: браузерного інструмента, керованого dev-сервера, способу покласти картинку в PR, і
браузерів у `docker/runtime/Dockerfile`.

## 5. Як це працює

### 5.1 Коли перевірка запускається

Воркер запускає UI-перевірку у стадії `Reviewing`, **після** `reviewer` і після того, як усі його
блокери закриті, і **до** `git push`. Умови — усі разом:

1. У рядку `uiCheck:` блоку «Run context» стоїть `available`. Це рішення енджина, не моделі (див. 5.2).
2. `git diff <base>...HEAD --name-only` дає хоча б один шлях, що матчить `ui.paths` із конфігу.
3. У `spec.md` є хоча б один acceptance criterion, який описує видиму поведінку.

Якщо (1) не виконано — воркер пише причину в тіло PR і в `result.md` і йде далі (це вже вимагає
WRK-10, лишаємо). Якщо (2) або (3) не виконані — зміна не UI-шна, перевірку пропускаємо без згадки.

### 5.2 Рядок `uiCheck` у Run context

`workerFirstMessage` отримує ще один рядок:

```
## Run context
taskId: T-3
branch: jarvis/T-3
artifactsDir: /home/jarvis/.jarvis/tasks/T-3
stage: Reviewing
uiCheck: available
```

Значення: `available`, або `disabled: ui.enabled is false`. Енджин обчислює це один раз на ран.
Моделі не доводиться вгадувати, чому браузер не відповідає, і вона не намагається підняти його сама.

Спершу я хотів ще й значення «браузера не встановлено», але відмовився: щоб його дати, енджин мусив
би вгадувати, де Playwright тримає Chromium, і ця перевірка брехала б щоразу, коли вгадала не той
шлях. Відсутній браузер натомість проявляється як помилка першого ж `browser_navigate`, яку промпт
трактує як `inconclusive` і виносить у PR. Чесніше, ніж окремий зелений прапорець, якому не можна
вірити.

### 5.3 Dev-сервер належить енджину

Воркер **не** запускає сервер через `Bash`. Для цього є два інструменти Jarvis MCP:

```
start_dev_server: {}                       → { baseUrl: string, expiresAt: string }
stop_dev_server:  {}
```

`start_dev_server` запускає `ui.devCommand` у ворктрі задачі-викликача, чекає, доки `ui.readyPath`
на `ui.baseUrl` відповість не-5xx (до `ui.readyTimeoutSeconds`), і віддає `baseUrl`. Далі:

- **Команда — з конфігу.** Модель не передає жодного аргументу; `start_dev_server` приймає порожній
  об'єкт. Це і є захист анти-цілі «агент сам вирішує, що запустити».
- **Лізинг.** Процес живе не довше `ui.leaseMinutes`. Енджин убиває все дерево процесів по таймауту,
  а також коли ран завершується, коли задача виходить зі стадії `Reviewing`, і на старті енджина
  (підбирає сироти після рестарту).
- **Один слот на весь енджин.** Другий `start_dev_server`, поки живе чужий, відмовляє з
  `dev_server_busy`. Один воркерський слот робить це майже неможливим, але слот воркера — це
  конфіг, а не інваріант.
- **Повторний виклик тією самою задачею** продовжує лізинг і віддає той самий `baseUrl`,
  не піднімаючи другий процес.
- `stop_dev_server` — ввічливе звільнення; воркер викликає його після UI-перевірки. Пропущений виклик
  не ламає нічого, бо є лізинг.

Порт у `ui.baseUrl` перед запуском перевіряється на зайнятість: зайнятий чужим процесом порт — це
відмова `port_busy`, а не тихе підключення до невідомо чого.

### 5.4 Playwright MCP

Енджин додає ще один сервер у `mcp.json` рану — поряд із `jarvis` і конекторами, лише для ролі
`worker`, і лише коли `uiCheck: available`:

```json
{
  "command": "npx",
  "args": [
    "-y", "@playwright/mcp@0.0.84",
    "--headless",
    "--isolated",
    "--browser", "chromium",
    "--viewport-size", "1280x800",
    "--output-dir", "<artifactsDir>/screenshots",
    "--allowed-origins", "http://127.0.0.1:<port>",
    "--console-level", "error",
    "--idle-timeout", "300000",
    "--timeout-action", "5000",
    "--timeout-navigation", "15000",
    "--image-responses", "allow",
    "--no-webmcp",
    "--save-session"
  ]
}
```

Чому саме так:

- `--headless --isolated` — без вікна і без профілю на диску: нічого не переживає ран.
- `--allowed-origins` з єдиним origin dev-сервера — браузер не ходить у зовнішній інтернет. Довідка
  самого Playwright MCP прямо каже, що це *не* безпековий кордон і не впливає на редіректи, тому це
  гальмо, а не захист; справжній кордон — те, що в контейнері немає нічого цінного.
- `--output-dir` одразу в артефакти задачі: скриншот без явного імені падає туди, куди нам треба.
  Увага: файли з явним іменем Playwright MCP резолвить від workspace root, а не від `--output-dir` —
  тому промпт `ui-tester` вимагає знімати скриншоти **без** явного імені або з іменем відносно
  `--output-dir`.
- `--idle-timeout 300000` — браузер сам закривається після 5 хвилин без викликів.
- `--console-level error` — у відповіді лише помилки консолі, не весь шум.
- `--no-webmcp` — сторінка не може зареєструвати власні інструменти для агента. Для нашої моделі
  довіри («вміст сторінки — це дані, а не інструкції», SOUL принцип 4) це обов'язково.
- `--save-session` — на диску лишається розшифровка сесії поряд зі скриншотами; дешева діагностика,
  коли вердикт виглядає дивно.
- `--version` зафіксована. `@latest` у рантаймі агента — це недетермінований ран.
- У контейнері додається `--no-sandbox` (конфіг `ui.noSandbox`), бо user namespaces там недоступні.

**Дозволені інструменти.** Воркерські `settings.json` отримують в `allow`:

`browser_navigate`, `browser_navigate_back`, `browser_snapshot`, `browser_take_screenshot`,
`browser_click`, `browser_type`, `browser_fill_form`, `browser_press_key`, `browser_hover`,
`browser_select_option`, `browser_drag`, `browser_drop`, `browser_find`, `browser_wait_for`,
`browser_resize`, `browser_console_messages`, `browser_network_requests`, `browser_network_request`,
`browser_handle_dialog`, `browser_tabs`, `browser_close`, `browser_emulate_media`.

У `deny` — `browser_evaluate`, `browser_run_code_unsafe`, `browser_file_upload`. Перші два — це
довільний код у сторінці: UI-перевірці він не потрібен, а можливість обійти UI і «довести» успіх
через `document.querySelector(...).click()` прямо шкідлива. Третій відкриває файлову систему через
браузер.

### 5.5 Субагент `ui-tester`

Новий файл `agent/agents/ui-tester.md`, `model: sonnet`, `tools: Read, Glob, Grep` плюс
дозволені `mcp__playwright__browser_*`. **Без `Bash`, `Edit`, `Write`** — тестувальник не править код і
не запускає процесів; він дивиться і доповідає. Скриншоти на диск кладе сам Playwright MCP.

**Вхід** (воркер передає текстом): `baseUrl`, шлях до `spec.md`, нумерований список UI-сценаріїв,
стеля сценаріїв (`ui.maxScenarios`), стеля скриншотів (`ui.maxScreenshots`), і дедлайн лізингу.

**Робота:** для кожного сценарію — навігація, дії, `browser_snapshot` для перевірки стану,
`browser_take_screenshot` для свідчення, `browser_console_messages` і `browser_network_requests`
після сценарію. Сценарії виконуються по порядку; закінчилися стелі або час — решта позначається
`skipped`, а не вигадується.

**Вихід** — markdown рівно такої форми:

```
verdict: pass | fail | inconclusive

## Scenarios
1. <назва> — pass — критерій: <AC-id зі spec.md> — screenshot: screenshots/001-<...>.png
   <один рядок: що бачив>
2. <назва> — fail — критерій: <AC-id> — screenshot: screenshots/002-<...>.png
   <що мало статися, що сталося>
3. <назва> — skipped — причина: budget | lease expired

## Findings
- blocker — сценарій 2 — <що зламано> — <url або локатор> — <виправлення одним реченням>
- suggestion — ...

## Console
- <рівень> <текст>   (або «чисто»)

## Network
- <метод> <url> → <статус>   (або «без фейлів»)
```

`verdict: pass` — лише коли жоден сценарій не `fail` і немає `blocker`. `inconclusive` — коли сервер
не відповів, лізинг скінчився або браузер не піднявся: це **не** `pass` і **не** `fail`.

### 5.6 Що робить воркер із вердиктом

- `pass` → далі до PR. Скриншоти вкладаються, сценарії йдуть у тіло PR.
- `fail` → воркер переходить `Reviewing → Implementing`, править, і знову проходить Verifying і
  Reviewing. Цей шлях уже існує і вже обмежений: кожен такий повернення витрачає раунд із
  `limits.reviewRounds`, а коли вони закінчуються, енджин дає `rounds_exhausted`. **Нового лічильника
  не додаємо.** Якщо раунди вичерпані, а UI-блокер лишився — він іде в тіло PR під «Open questions»
  з скриншотом, а не замовчується.
- `inconclusive` → воркер не крутить браузер далі. Одна повторна спроба (новий `start_dev_server`),
  і якщо знову `inconclusive` — PR відкривається з явним рядком «UI-перевірка не вдалася: <причина>».

### 5.7 Скриншоти в PR

Новий інструмент Jarvis MCP:

```
attach_image: { path: string, alt: string }
  → { ok: true, url: string, markdown: string }
  | { ok: false, reason: string }
```

`path` — відносно `<artifactsDir>`. Енджин:

1. Резолвить шлях і відмовляє, якщо він виходить за межі каталогу артефактів задачі (`..`, симлінк,
   абсолютний шлях).
2. Перевіряє розширення (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) і розмір (≤ `ui.maxImageMb`,
   дефолт 5 МБ).
3. Бере `repository_id` цільового репозиторію задачі (`GET /repos/{owner}/{repo}` → `.id`,
   кешується на процес).
4. `POST https://uploads.github.com/user-attachments/assets?name=<file>&content_type=<mime>&repository_id=<id>`
   з `Authorization: Bearer <той самий токен, що в CodeHost>`, `Accept: application/json`, сирі байти
   в тілі. У відповіді — JSON із URL виду `https://github.com/user-attachments/assets/<uuid>`.
5. Віддає `markdown: "![<alt>](<url>)"`.

**Цей endpoint недокументований.** Офіційного API для вкладень GitHub не має: запит висить у
community discussions роками, вкладення офіційно робляться тільки drag-and-drop у браузері. Ручка
`uploads.github.com/user-attachments/assets` — та сама, якою користується веб-інтерфейс; автор
статті, що її описує, зазначає, що раніше вона приймала лише cookie, а токен почав працювати
нещодавно. Звідси три наслідки, які специфікація вимагає:

- Уся робота з нею — в **одному адаптері** за портом, із власними тестами на фейк-`fetch`. Коли ручка
  зламається, ламається одне місце.
- `{ ok: false, reason }` — нормальна відповідь, не виняток. На `401/403/404/410/5xx` воркер пише в
  тіло PR рядок `UI screenshots: upload failed (<reason>); files are in <artifactsDir>/screenshots/`
  і **список імен файлів**. PR зі зламаними картинками — анти-ціль; PR із чесним рядком — ні.
- Перша жива перевірка ручки — окремий крок плану (8.6), на справжньому PR у sandbox-репозиторії.
  Токен у `~/.jarvis/.env` наразі віддає `Bad credentials` (STATUS.md, пункт 5), а новий токен
  планується fine-grained; чи приймає ця ручка fine-grained PAT — не перевірено ніде, і це єдиний
  справжній ризик фічі.

**Тіло PR.** У `pr-body.md` з'являється секція між «Checks» і «Open questions»:

```markdown
## UI verification

`chromium 1280x800`, dev server `http://127.0.0.1:5173`, verdict **pass**

| # | Сценарій | Критерій | Результат |
|---|----------|----------|-----------|
| 1 | Створення задачі з чату | AC-3 | pass |
| 2 | Банер бюджету при 90% | AC-7 | pass |

![Створення задачі з чату](https://github.com/user-attachments/assets/…)
![Банер бюджету при 90%](https://github.com/user-attachments/assets/…)
```

### 5.8 Захист від петлі — повний список

| Межа | Значення | Хто нав'язує |
|---|---|---|
| Один браузер одночасно | `limits.maxConcurrentWorkers: 1` + слот dev-сервера | енджин |
| Життя dev-сервера | `ui.leaseMinutes` (дефолт 15) | енджин убиває дерево процесів |
| Життя браузера без викликів | `--idle-timeout 300000` | Playwright MCP |
| Кількість сценаріїв | `ui.maxScenarios` (дефолт 8) | промпт + воркер ріже список |
| Кількість скриншотів | `ui.maxScreenshots` (дефолт 12) | `attach_image` відмовляє після стелі |
| Повторні UI-раунди | `limits.reviewRounds` (3) | машина станів, `rounds_exhausted` |
| Повтор після `inconclusive` | один | промпт воркера |
| Турни й бюджет рану | `maxTurnsPerRun` 120, `maxBudgetUsdPerRun` $10 | `--max-turns`, `--max-budget-usd` |
| Життя задачі | `taskTimeoutMinutes` 120 | таймер supervision |
| Куди може ходити браузер | `--allowed-origins` = origin dev-сервера | Playwright MCP (гальмо, не кордон) |

Головне тут: **жодна з цих меж не залежить від того, чи послухається модель.** Промптові межі
(сценарії, повтор) — верхній, ввічливий шар; під ними лежать лізинг, слот, лічильник раундів і
ліміти CLI, які відрубають інструмент незалежно від бажань агента.

## 6. Конфіг

Новий блок у `JarvisConfigSchema` (`shared/src/config.ts`), strict, усі поля з дефолтами:

```jsonc
"ui": {
  "enabled": false,                 // фіча вимкнена, доки власник не ввімкне
  "devCommand": "pnpm dev",         // виконується у ворктрі задачі; тільки власник
  "baseUrl": "http://127.0.0.1:5173",
  "readyPath": "/",
  "readyTimeoutSeconds": 90,
  "leaseMinutes": 15,
  "maxScenarios": 8,
  "maxScreenshots": 12,
  "maxImageMb": 5,
  "attachToPr": true,               // false → у PR лишаються лише імена файлів
  "noSandbox": false,               // true в контейнері
  "paths": ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.css", "**/*.scss", "**/*.html"]
}
```

`baseUrl` обмежений тим самим правилом, що `telemetry.otlpEndpoint`: http(s) на `127.0.0.1` або
`localhost`. Dev-сервер агента, доступний не з лупбека, — це не фіча, це дірка.

`devCommand` **не** входить до `update_config`-дозволеного (ADR-0020 вже забороняє патчі в
`repo.*`, `engine.*`; додаємо `ui.devCommand`, `ui.noSandbox` і `ui.paths` до того ж списку).
Диспетчер не має права змінити команду, яку енджин потім виконає.

Усі значення — у `jarvis.config.example.json`.

**Відома межа:** `ui.devCommand` глобальний, а задача може мати власний `targetRepo` (ADR-0019). Це та
сама межа, що й у `allowlist.autoAllowedCommands`, і свідомо не закривається тут. Якщо цільовий
репозиторій піднімається іншою командою — власник править конфіг.

## 7. Контейнер і сервер

`docker/runtime/Dockerfile`:

- До `USER jarvis`, під root: `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` і
  `npx playwright@<pin> install --with-deps chromium`. Каталог читабельний для `jarvis`.
- `ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` для рантайму.
- `ui.noSandbox: true` у конфігу контейнера.

`PLAYWRIGHT_BROWSERS_PATH` додається у `child-env.ts`, бо Playwright MCP — онук енджина (енджин →
`claude` → MCP-сервер), і без цього він шукатиме браузер у `$HOME/.cache`.

Образ важчає приблизно на 400 МБ. Це ціна того, що фіча працює там, де система насправді живе.
Провіженінг VPS (`docs/architecture/deployment.md`) отримує той самий крок.

## 8. Критерії приймання

**Конфіг**

- AC-1. Якщо `ui` відсутній у `jarvis.config.json`, то конфіг валідний, `ui.enabled` є `false`, і
  UI-перевірка не запускається.
- AC-2. Якщо `ui.baseUrl` вказує на не-лупбек хост, то завантаження конфігу падає з повідомленням
  про лупбек.
- AC-3. Якщо `update_config` містить патч до `ui.devCommand`, `ui.noSandbox` або `ui.paths`, то
  інструмент відмовляє і конфіг не змінюється.

**Run context і mcp.json**

- AC-4. Якщо `ui.enabled` є `true` і браузер установлений, то `uiCheck: available` у першому
  повідомленні воркерського рану, а `mcp.json` рану містить сервер `playwright` із
  `--headless`, `--isolated`, `--output-dir <artifactsDir>/screenshots` і `--allowed-origins` рівним
  origin `ui.baseUrl`.
- AC-5. Якщо `ui.enabled` є `false`, то `uiCheck: disabled: ui.enabled is false`, і в `mcp.json`
  немає сервера `playwright`.
- AC-6. Для ролі `dispatcher` сервера `playwright` у `mcp.json` немає за жодних налаштувань.
- AC-7. `settings.json` воркерського рану містить `browser_*` з 5.4 в `allow`, а `browser_evaluate`,
  `browser_run_code_unsafe`, `browser_file_upload` — у `deny`.

**Dev-сервер**

- AC-8. Якщо воркер викликає `start_dev_server`, то енджин запускає `ui.devCommand` у ворктрі саме
  тієї задачі, яку назвав run-токен, і віддає `baseUrl` лише після того, як `readyPath` відповів
  не-5xx.
- AC-9. Якщо сервер не піднявся за `ui.readyTimeoutSeconds`, то інструмент відмовляє з
  `dev_server_not_ready`, а процес убитий.
- AC-10. Якщо `start_dev_server` викликає задача, поки живе лізинг іншої задачі, то відмова
  `dev_server_busy`, і наявний процес не зачеплений.
- AC-11. Якщо той самий воркер викликає `start_dev_server` повторно, то другого процесу не
  з'являється, лізинг продовжується, `baseUrl` той самий.
- AC-12. Якщо лізинг спливає, то енджин убиває все дерево процесів і пише подію в журнал задачі.
- AC-13. Якщо ран завершується (успіхом, фейлом або скасуванням) з живим лізингом, то процес убитий
  до того, як задача змінить стадію.
- AC-14. Якщо енджин стартує і знаходить записаний лізинг без живого процесу, то запис прибирається;
  якщо процес живий — убивається.
- AC-15. Якщо порт `ui.baseUrl` зайнятий стороннім процесом, то `start_dev_server` відмовляє з
  `port_busy` і нічого не запускає.

**Вкладення**

- AC-16. Якщо `attach_image` отримує шлях за межі `<artifactsDir>` (у тому числі через `..` або
  симлінк), то відмова, і жодного запиту до GitHub не йде.
- AC-17. Якщо файл більший за `ui.maxImageMb` або має недозволене розширення, то відмова до запиту.
- AC-18. Якщо GitHub віддає 2xx, то інструмент повертає `{ ok: true, url, markdown }`, де `markdown`
  є `![alt](url)`.
- AC-19. Якщо GitHub віддає 401, 403, 404, 410 або 5xx, то інструмент повертає `{ ok: false, reason }`
  без винятку, і `reason` не містить токена.
- AC-20. Якщо за задачу вже вкладено `ui.maxScreenshots` файлів, то наступний виклик відмовляє з
  `screenshot_limit_reached`.
- AC-21. Якщо `ui.attachToPr` є `false`, то `attach_image` відмовляє з `attachments_disabled`.

**Перевірка і PR**

- AC-22. Якщо `uiCheck: available`, діфф торкається `ui.paths`, і у `spec.md` є видимий criterion, то
  воркер викликає `ui-tester` рівно один раз за стадію Reviewing, після закриття блокерів `reviewer`.
- AC-23. Якщо `ui-tester` вертає `verdict: fail` із блокером, то воркер не пушить гілку і переходить
  у `Implementing`.
- AC-24. Якщо раунди `limits.reviewRounds` вичерпані, а UI-блокер лишився, то PR відкривається, і цей
  блокер стоїть у «Open questions» тіла PR зі скриншотом.
- AC-25. Якщо `verdict` є `pass`, то тіло PR містить секцію «UI verification» з таблицею сценаріїв і
  вкладеними картинками, по одній на сценарій зі скриншотом.
- AC-26. Якщо вкладення не вдалося, то тіло PR містить рядок про невдачу з причиною і список імен
  файлів, і жодного markdown-посилання на картинку.
- AC-27. Якщо `uiCheck` є `disabled`, то тіло PR і `result.md` містять рядок із причиною (вимога
  WRK-10 лишається в силі).
- AC-28. Якщо `verdict` є `inconclusive` двічі підряд, то воркер не робить третьої спроби і відкриває
  PR із явним рядком про невдалу перевірку.

## 9. Межові випадки

- **Застосунок вимагає логіну.** `ui-tester` не має куди взяти пароль і не повинен його шукати.
  Сценарій позначається `skipped — auth required`, і це йде в «Open questions» PR. Логін через
  `--storage-state` — наступна версія, не ця.
- **Сторінка пише в консоль помилки, але сценарій проходить.** Це `suggestion`, не `blocker`, і воно
  в секції «Console» PR. Не всі помилки консолі — регресія цього діффа.
- **Dev-сервер із HMR падає посеред сценарію.** `browser_navigate` дає помилку → сценарій `fail` із
  причиною `dev server died`, вердикт `inconclusive`, а не `fail`: ми не знаємо, чи винна зміна.
- **Скриншот вийшов 0 байт.** `attach_image` відмовляє (розмір), сценарій лишається з текстовим
  свідченням.
- **Діфф торкається лише CSS-змінної в токенах дизайну.** Правило 5.1 дає `available`, але виразного
  сценарію зі `spec.md` може не бути. Воркер усе одно викликає `ui-tester` — з одним сценарієм
  «відкрити сторінку X, перевірити, що вона рендериться без помилок консолі, зняти скриншот». Один
  сценарій — теж сценарій; порожнього виклику не буває.
- **Два PR на ту саму задачу.** `attach_image` не прив'язаний до PR (GitHub-ручка приймає
  `repository_id`, а не номер PR), тож URL живуть незалежно від PR і переживають його перестворення.
- **Задача з `targetRepo`, відмінним від дефолтного.** `repository_id` береться з репозиторію задачі,
  не з `repo` конфігу. Дев-команда — глобальна (див. 6).

## 10. Відкриті питання

1. **Чи приймає `uploads.github.com/user-attachments/assets` fine-grained PAT?** Невідомо. Статті
   описують токен із `gh auth token` (OAuth-токен користувача), а STATUS.md планує fine-grained PAT,
   звужений до одного репозиторію. Перевіряється кроком 11.6; якщо ні — власник вирішує між classic
   PAT і `ui.attachToPr: false`.
2. **Чи потрібен `--caps vision`?** Без нього модель працює зі `browser_snapshot`
   (текстовим деревом доступності) і бачить картинку лише у відповіді `browser_take_screenshot`.
   Для «чи поїхала верстка» цього може не вистачати. Рішення — після першого живого рану.
3. **`npx -y` на кожен ран** тягне пакет із реєстру (або з кешу). У контейнері без мережі до npm це
   фейл. Варіант — зафіксувати `@playwright/mcp` як залежність репозиторію і запускати локальний
   бінарник. Схиляюся до другого, але це рішення про залежність і потребує рядка в ADR-0022.

## 11. План реалізації

Порядок такий, що кожен крок перевіряється сам по собі.

1. **Конфіг.** Блок `ui` у `shared/src/config.ts`, лупбек-правило для `baseUrl`, заборонені патчі в
   `update_config`, `jarvis.config.example.json`. Тести: `shared/src/config.test.ts`,
   `engine/.../update-config`.
2. **Порт і адаптер dev-сервера.** `application/ports/dev-server.ts` (`start`, `stop`, `status`),
   адаптер на `node:child_process` із убиванням групи процесів, лізингом і підбором сиріт на старті.
   Юніт-тести на фейк-спавні; `port_busy` і `dev_server_not_ready` — окремими тестами.
3. **Інструменти `start_dev_server` / `stop_dev_server`.** Схеми в `shared/src/mcp.ts`, `toolsByRole`,
   роут у `presentation/http/routes/agent-tools.ts`, реєстрація в `presentation/mcp/server.ts`.
4. **Порт і адаптер вкладень.** `uploadAttachment` у `CodeHost` + реалізація в `GitHubCodeHost` на
   інжектованому `fetch`, із редактором токена. Тести на фейк-`fetch`: 2xx, 401, 404, 5xx.
5. **Інструмент `attach_image`.** Схема, перевірки шляху/розміру/розширення, лічильник скриншотів на
   задачу, `{ ok: false, reason }` замість винятку.
6. **Run context і `mcp.json`.** Рядок `uiCheck` у `workerFirstMessage`; сервер `playwright` у
   `buildMcpConfig` з флагами 5.4; `browser_*` у `allow`/`deny` в `buildWorkerSettings`;
   `PLAYWRIGHT_BROWSERS_PATH` у `child-env.ts`. Тести — наявні `run-files.test.ts`,
   `run-prompt`-тести.
7. **Агент.** `agent/agents/ui-tester.md`; переписаний розділ WRK-10 у `agent/prompts/worker.md`
   (коли, кого кликати, що з вердиктом, що в PR); секція «UI verification» у шаблоні `pr-body`.
8. **Контейнер.** Chromium із `--with-deps` у `docker/runtime/Dockerfile`, `PLAYWRIGHT_BROWSERS_PATH`,
   крок у `docs/architecture/deployment.md`.
9. **ADR.** `0022-ui-verification-with-playwright-mcp.md` — один запис на все: інструмент, субагент,
   dev-сервер за лізингом, пін версії, а також скриншоти в PR (недокументована ручка, чому вона,
   фолбек, що робити, коли зламається).
10. **e2e.** Сценарій у `web/e2e` на фейковому `claude`: задача доходить до PR Open, і в `result.md`
    є секція UI-перевірки. Сам браузер тут не піднімається — перевіряється пайплайн, не Playwright.
11. **Жива перевірка.** На `burnjohn/jarvis-sandbox`: (а) `attach_image` на справжньому PR із новим
    токеном — відповідь на питання 10.1; (б) один UI-таск від початку до кінця, у контейнері.

Крок 11 — єдиний, який не можна зробити з коду, і єдиний, що відповідає на головний ризик фічі.

## Джерела

- `agent/prompts/worker.md` — WRK-10, стадії Reviewing і PR
- `engine/src/infrastructure/claude/run-files.ts` — `buildMcpConfig`, `buildWorkerSettings`
- `engine/src/application/runs/run-prompt.ts` — блок «Run context»
- `shared/src/config.ts`, `shared/src/mcp.ts` — конфіг і контракти інструментів
- `engine/src/domain/task.ts` — `TRANSITIONS`, `reviewRounds`, `rounds_exhausted`
- ADR-0004 (тільки CLI), ADR-0005 (інструменти як MCP-сервер енджина), ADR-0006 (ліміти в конфігу),
  ADR-0011 (агент як плагін), ADR-0017 (рантайм-образ), ADR-0019 (per-task repo), ADR-0020 (межі
  `update_config`)
- `npx @playwright/mcp@0.0.84 --help` і `tools/list`, перевірено локально 2026-11-08
- [Programmatically upload attachments to GitHub Issues, Pull Requests, and Comments](https://island94.org/2026/08/programmatically-upload-attachments-to-github-issues-pull-requests-comments)
- [Comment API for uploading images/attachments · community discussion #28219](https://github.com/orgs/community/discussions/28219)
- [Playwright MCP configuration options](https://playwright.dev/mcp/configuration/options)
