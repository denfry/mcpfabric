# mcpfabric

**Полное наблюдение и управление Minecraft (Fabric 1.21.8) для ИИ через MCP.**

`mcpfabric` состоит из двух частей:

1. **Fabric-мод** — встраивает внутрь Minecraft локальный HTTP-мост и даёт доступ к чтению и
   управлению игрой. Работает универсально: на клиенте управляет вашим игроком как ботом и видит
   всё, что видит клиент (включая скриншоты); на выделенном/встроенном сервере даёт режим
   администратора над миром, сущностями и всеми игроками.
2. **MCP-сервер** (TypeScript) — подключается к мосту мода по HTTP и публикует ~50 инструментов
   через [Model Context Protocol](https://modelcontextprotocol.io), чтобы любой MCP-клиент
   (Claude Desktop, Claude Code и т.д.) мог наблюдать и управлять игрой.

```
Claude / любой MCP-клиент
        │  MCP (stdio или streamable HTTP)
   mcp-server  (Node/TypeScript)
        │  HTTP  POST /rpc (JSON-RPC) + GET /events (SSE),  Bearer-токен, только 127.0.0.1
   Fabric-мод "mcpfabric"  (встроенный HttpServer внутри Minecraft)
        │  весь доступ к игре — через main-thread executor (server.execute / Minecraft.execute)
   ┌── common (env *) ─────────────┐   ┌── client (env client) ─────────────────┐
   │ info  world  entities         │   │ player  control  interact               │
   │ players  command  chat events │   │ inventory  vision  navigation  chat      │
   └───────────────────────────────┘   └──────────────────────────────────────────┘
```

Чтения реализованы через нативный API Minecraft (структурированные данные), записи
(`setblock`/`summon`/`give`/`tp`/эффекты/погода/время) — через диспетчер команд с перехватом
вывода. Управление игроком сделано через `KeyMapping` (интеграция со штатным input-пайплайном),
скриншот — через штатный `Screenshot`/`NativeImage`, навигация — собственный A\*.

---

## Требования

- **Java 21** (Minecraft 1.21.8).
- **Minecraft 1.21.8** + **Fabric Loader ≥ 0.19.3** + **Fabric API 0.136.1+1.21.8**.
- **Node.js ≥ 20** для MCP-сервера.

---

## 1. Сборка мода

```bash
# из корня репозитория
./gradlew build
# Windows:
gradlew.bat build
```

Готовый мод: `build/libs/mcpfabric-0.1.0.jar`.

> **Примечание про сеть.** Если первая сборка падает с `Remote host terminated the handshake`
> при скачивании зависимостей с `maven.fabricmc.net` (так бывает с антивирусами/файрволами,
> инспектирующими TLS), в `gradle.properties` уже включён обход: TLS 1.2 + последовательные
> загрузки. При обрыве просто перезапустите сборку — кэш скачанного сохраняется.

### Установка

Положите `mcpfabric-0.1.0.jar` вместе с **Fabric API** в папку `mods/`:

- **Клиент** (ИИ играет за вас): `mods/` вашего Fabric-инстанса (PrismLauncher/CurseForge/обычный лаунчер).
- **Сервер** (ИИ как админ): `mods/` выделенного Fabric-сервера.
- Можно ставить с обеих сторон одновременно.

При первом запуске мод создаёт `config/mcpfabric.config.json` и печатает в лог строку вида:

```
[mcpfabric] ready — bridge http://127.0.0.1:25599  token=ab12cd...
```

Скопируйте `token` — он понадобится MCP-серверу.

### Конфиг мода (`config/mcpfabric.config.json`)

```json
{
  "host": "127.0.0.1",
  "port": 25599,
  "token": "сгенерируется автоматически",
  "requireAuth": true,
  "callTimeoutMs": 8000,
  "enableWorldWrite": true,
  "enableCommands": true,
  "enablePlayerControl": true,
  "enableVision": true
}
```

Флаги `enable*` позволяют отключить опасные группы возможностей. `host` держите на `127.0.0.1`,
если только вы точно не понимаете последствий — мост даёт права уровня оператора.

---

## 2. MCP-сервер

```bash
cd mcp-server
npm install
npm run build      # компиляция в dist/
```

Запуск (обычно его запускает MCP-клиент сам, см. ниже):

```bash
MCPFABRIC_URL=http://127.0.0.1:25599 MCPFABRIC_TOKEN=<токен> node dist/index.js
```

### Переменные окружения

| Переменная             | По умолчанию              | Описание                                            |
|------------------------|---------------------------|-----------------------------------------------------|
| `MCPFABRIC_URL`        | `http://127.0.0.1:25599`  | Адрес HTTP-моста мода.                               |
| `MCPFABRIC_TOKEN`      | —                         | Bearer-токен из конфига мода (обязателен по умолчанию). |
| `MCPFABRIC_TIMEOUT_MS` | `15000`                   | Таймаут одного вызова к мосту.                      |
| `MCPFABRIC_TRANSPORT`  | `stdio`                   | `stdio` или `http`.                                 |
| `MCPFABRIC_HTTP_PORT`  | `25600`                   | Порт для транспорта `http` (`/mcp`).                |

---

## 3. Подключение к Claude

### Claude Desktop

`claude_desktop_config.json` (см. `examples/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mcpfabric": {
      "command": "node",
      "args": ["D:/Projects/mcpfabric/mcp-server/dist/index.js"],
      "env": {
        "MCPFABRIC_URL": "http://127.0.0.1:25599",
        "MCPFABRIC_TOKEN": "вставьте-токен-из-лога-мода"
      }
    }
  }
}
```

### Claude Code

Файл `.mcp.json` в корне проекта (см. `examples/mcp.json`) либо команда:

```bash
claude mcp add mcpfabric -- node D:/Projects/mcpfabric/mcp-server/dist/index.js
```

После добавления укажите `MCPFABRIC_TOKEN` в окружении сервера.

---

## Инструменты (≈50)

**info** — `get_status`, `list_capabilities`
**world (чтение)** — `get_block`, `get_blocks_region`, `find_blocks`, `get_time_and_weather`, `list_dimensions`, `raycast`
**world (запись)** — `set_block`, `fill_blocks`, `set_time`, `set_weather`
**entities** — `query_entities`, `get_entity`, `summon_entity`, `remove_entity`
**players (админ)** — `list_players`, `get_player`, `teleport_player`, `set_gamemode`, `give_item`, `apply_effect`, `message_player`, `kick_player`
**command** — `run_command` (любая команда уровня оператора с перехватом вывода)
**chat** — `send_chat`, `get_recent_chat`
**player (локальный, клиент)** — `get_self`, `get_inventory`, `get_equipment`, `get_status_effects`
**control (клиент)** — `set_movement`, `stop_movement`, `look`, `look_at`, `jump`, `start_using_item`, `stop_using_item`
**interact (клиент)** — `break_block`, `place_block`, `use_item`, `attack_entity`, `use_entity`, `drop_held_item`
**inventory (клиент)** — `select_hotbar_slot`, `drop_slot`, `swap_slots`
**vision (клиент)** — `screenshot` (PNG для vision-моделей), `describe_scene`
**navigation (клиент)** — `navigate_to` (A\*), `navigation_status`, `stop_navigation`
**events** — `poll_events` (буфер последних событий: урон, смерти, чат, спавны, вход/выход игроков)

Серверные инструменты требуют запущенного сервера (встроенного на клиенте или выделенного).
Клиентские (`control`/`interact`/`vision`/`navigation`/`player`/`inventory`) работают только на стороне клиента.
Вызовите `get_status` первым — он сообщит, на какой вы стороне и какие группы доступны.

---

## Примеры сценариев

- «Осмотрись и опиши, что вокруг» → `get_self` + `describe_scene` (+ `screenshot` для vision-модели).
- «Дойди до координат и добудь алмазы» → `find_blocks` → `navigate_to` → `break_block`.
- «Что происходит на сервере» → `list_players` + `poll_events`.
- «Построй стену» → `fill_blocks` или серия `set_block` / `run_command`.

---

## Безопасность

- Мост слушает **только `127.0.0.1`** и требует **Bearer-токен**.
- Возможности уровня оператора (`run_command`, запись мира, управление игроками) включены по
  умолчанию — это даёт ИИ полный контроль. Отключайте группы флагами `enable*`, если нужно.
- Не выставляйте `host` наружу без понимания рисков и без реверс-прокси с аутентификацией.

---

## Структура проекта

```
mcpfabric/
├─ build.gradle, settings.gradle, gradle.properties   # Fabric Loom (loom-remap), Mojmap, split source sets
├─ src/main/java/dev/mcpfabric/                        # common (env *): мост + серверные хендлеры
│  ├─ McpFabric.java, ServerHolder.java
│  ├─ bridge/      (HttpBridgeServer, RpcRouter, MainThread, SseHub, Json, ...)
│  ├─ config/      (McpConfig)
│  ├─ events/      (EventBus, GameEvent)
│  └─ handlers/    (Info/World/Entity/PlayerAdmin/Command/Chat + support/CommandRunner, Levels)
├─ src/client/java/dev/mcpfabric/client/               # client (env client): бот + клиентские хендлеры
│  ├─ McpFabricClient.java, ClientMc.java, BotController.java, ClientEvents.java
│  ├─ nav/AStarPathfinder.java
│  └─ handlers/    (LocalPlayer/Control/Interact/Inventory/Vision/Nav/ClientChat)
└─ mcp-server/                                         # MCP-сервер (TypeScript)
   ├─ src/index.ts, bridge.ts, tools.ts, config.ts
   └─ package.json, tsconfig.json
```

## Лицензия

MIT.
