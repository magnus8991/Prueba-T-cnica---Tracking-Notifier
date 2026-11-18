# Informe de implementación — `tracking-notifier`

> Fuente de requisitos: `Prueba_Tecnica_Desarrollador_Senior (1).pdf` (Domina Entrega Total, Desarrollador Senior Backend).
> Fecha del informe: 2026-11-18. Roles aplicados: ingeniería de software, liderazgo técnico, arquitectura, análisis funcional/QA y seguridad de la información.

---

## 1. Resumen ejecutivo

`tracking-notifier` es un microservicio multi-tenant que:

1. **Recibe** eventos de cambio de estado de guías de envío (`CREADA`, `EN_RUTA`, `ENTREGADA`, `DEVUELTA`).
2. **Persiste** el historial por tenant en PostgreSQL con **idempotencia** por `eventId` y **reglas de transición** (estados terminales inmutables).
3. **Notifica** de forma **asíncrona y confiable** al webhook de cada tenant (timeout 5 s, hasta 5 intentos con backoff exponencial creciente, estado `FALLIDA` consultable).

Decisión arquitectónica central (ADR-001): **Transactional Outbox sobre PostgreSQL** + worker con `FOR UPDATE SKIP LOCKED`. El evento y su notificación se escriben en la **misma transacción**, de modo que no se pierde ninguna notificación aunque el proceso caiga entre la respuesta HTTP y el envío.

---

## 2. Análisis de lo que existe y lo que no

| Elemento | Estado inicial | Acción |
|---|---|---|
| Carpeta del proyecto | Vacía, sin repositorio git | Crear el proyecto desde cero e inicializar git |
| Node.js | v22.14.0 instalado → actualizado a 26.13.1 LTS | **Stack elegido: NestJS + TypeScript** |
| Python | No instalado | Se descarta FastAPI |
| PostgreSQL | 17.4 local → reemplazado por 18.7 | Se usa para las pruebas de integración y E2E locales |
| Docker | No instalado → se instala Docker Desktop 4.99 | `docker compose up` local, y también en el CI |
| Requisitos funcionales (RF1–RF4) | Definidos en el PDF | Se implementan todos |
| Requisitos técnicos | Definidos en el PDF | Se implementan todos |
| Opcionales (HMAC, OpenAPI, métricas, CI) | Definidos en el PDF | **Se implementan los 4** (HMAC con Standard Webhooks, OpenAPI 3.1, Prometheus, GitHub Actions) |

### 2.1 Versiones (las estables más recientes, verificadas en nodejs.org, postgresql.org y el registro npm)

Herramientas del equipo actualizadas: Node.js 22.14 → **26.13.1 LTS**, npm → **12.2.3**, Git 2.48 → **2.56.0**, PostgreSQL 17.4 → **18.7**, Docker Desktop **4.99** (instalación nueva). Las imágenes Docker usan `node:26-alpine` y `postgres:18-alpine`.

| Paquete | Versión | Nota |
|---|---|---|
| `@nestjs/*` | 12.5.1 | Última estable |
| `typescript` | 6.0.3 | Última versión compatible con el toolchain: TS 7.0 (port nativo) **no** es soportado aún por `ts-jest` (`<7`) ni por `typescript-eslint` (`<6.1`) |
| `pg` (node-postgres) | 8.23.1 | SQL explícito, sin ORM: el dominio no conoce la persistencia |
| `zod` | 4.6.7 | Validación de entradas HTTP y de variables de entorno |
| `nestjs-pino` / `pino` | 5.3.2 / 10.4.0 | Logs JSON estructurados con redacción |
| `prom-client` | 15.1.3 | Métricas Prometheus |
| `jest` / `ts-jest` / `supertest` | 30.5.2 / 29.4.15 / 7.3.2 | Unitarias, integración y E2E |
| `eslint` / `typescript-eslint` | 10.15.0 / 8.73.0 | Incluye reglas de fronteras arquitectónicas |

### 2.2 Referencias oficiales consultadas

- RFC 9457 *Problem Details for HTTP APIs* (formato único de error, `application/problem+json`) — rfc-editor.org
- *Standard Webhooks* spec (cabeceras `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`; firma HMAC-SHA256 sobre `id.timestamp.body`) — github.com/standard-webhooks
- OWASP *SSRF Prevention Cheat Sheet* (allowlist de esquemas, bloqueo de rangos privados, validación en tiempo de conexión contra DNS rebinding, no seguir redirecciones) — cheatsheetseries.owasp.org
- PostgreSQL docs, `SELECT … FOR UPDATE SKIP LOCKED` para tablas tipo cola con múltiples consumidores — postgresql.org
- Documentación de NestJS (providers con `useFactory`, ciclo de vida `OnApplicationBootstrap`/`OnApplicationShutdown`) — docs.nestjs.com
- RFC 3339 / ISO 8601 para `fechaEvento`

---

## 3. Supuestos y decisiones funcionales (para el README)

| # | Ambigüedad del enunciado | Decisión |
|---|---|---|
| D1 | El cuerpo del evento no trae el número de guía | La guía va en la ruta: `POST /v1/guias/{numeroGuia}/eventos` |
| D2 | ¿Qué pasa con el primer evento de una guía? | La guía se crea implícitamente con su primer evento, sea cual sea el estado. No se exige `CREADA` primero, porque el enunciado solo prohíbe salir de los estados terminales |
| D3 | Transiciones válidas | Solo se prohíbe cambiar desde `ENTREGADA` o `DEVUELTA` (409 `GUIA_EN_ESTADO_TERMINAL`). Se permite repetir un estado no terminal (por ejemplo, varios escaneos `EN_RUTA`) |
| D4 | Eventos fuera de orden | El historial se ordena por `fechaEvento`, con desempate por orden de llegada. El estado actual es el del evento con `fechaEvento` más reciente, salvo que un evento terminal siempre cierra la guía |
| D5 | Alcance de la idempotencia | La clave es `(tenant, eventId)`. Si el reintento trae el mismo contenido responde **200** con el recurso original y la cabecera `Idempotent-Replayed: true`. Si trae el mismo `eventId` con otro contenido responde **409** `EVENT_ID_CONFLICTO` |
| D6 | "Hasta 5 intentos" | 5 intentos **en total** (1 inicial + 4 reintentos). Espera exponencial con jitter acotado: ~2 s, 4 s, 8 s y 16 s (configurable) |
| D7 | ¿Qué es "fallar"? | Error de red, timeout de 5 s o cualquier respuesta no 2xx. Las redirecciones **no** se siguen y cuentan como fallo, por seguridad (SSRF) |
| D8 | Tenant sin webhook configurado | La notificación se crea igual (outbox). Cada intento sin webhook cuenta como fallo `WEBHOOK_NO_CONFIGURADO`, así que tras 5 intentos queda `FALLIDA` y se puede reintentar manualmente |
| D9 | Reintento manual | Extra: `POST /v1/notificaciones/{id}/reintentar` devuelve una notificación `FALLIDA` a la cola |
| D10 | Secreto HMAC | Se genera en el servidor al crear el webhook (o al rotarlo) y **se devuelve una única vez**. Se guarda cifrado con AES-256-GCM usando una clave que viene de una variable de entorno |
| D11 | Cabecera `X-Tenant-Id` ausente o inválida | 400 `TENANT_INVALIDO`. Formato `^[A-Za-z0-9_-]{1,64}$` |
| D12 | Guía de otro tenant | Responde 404, sin distinguir entre "no existe" y "es de otro tenant", para no filtrar su existencia |
| D13 | Garantía de entrega | *At-least-once*. El receptor deduplica con `webhook-id` (que es el `eventId`) |
| D14 | Datos personales | `observacion` puede contener PII, así que **nunca se registra en logs**. Tampoco se registra la URL del webhook ni el secreto |
| D15 | `fechaEvento` en el futuro | Se rechaza (400 `FECHA_EVENTO_FUTURA`) si supera la hora de recepción en más de 5 minutos. Sin esta regla, un reloj del emisor desfasado (por ejemplo, año 9999) congelaría el estado actual de la guía |
| D16 | Operaciones concurrentes de soporte | El reintento manual usa escritura condicional (`WHERE status='FALLIDA'`): de N reintentos simultáneos solo uno responde 202 y los demás 409. El primer `PUT /webhook` usa `INSERT … ON CONFLICT DO NOTHING`: solo una petición crea y revela el secreto |

---

## 4. Arquitectura: microservicio con arquitectura hexagonal

La solución combina dos niveles de diseño:

- **Macro, el microservicio:** `tracking-notifier` es una unidad desplegable independiente con un único *bounded context* (seguimiento de guías y notificación a clientes).
- **Micro, la arquitectura hexagonal:** organiza el interior del servicio en dominio, aplicación e infraestructura.

### 4.0 Características de microservicio que se aplican

| Característica | Implementación |
|---|---|
| Responsabilidad única / bounded context | Solo gestiona eventos de guías, su historial y la entrega a webhooks. No autentica (lo hace el API Gateway) ni crea guías de negocio |
| Base de datos propia (*database per service*) | Esquema PostgreSQL exclusivo; ningún otro servicio accede a sus tablas, solo a su API |
| Contrato explícito | API REST versionada (`/v1`) documentada en OpenAPI 3.1, contrato de webhook versionado (`type`, firma `v1`) y errores RFC 9457 |
| Despliegue independiente | Imagen Docker propia, migraciones versionadas que se ejecutan al desplegar y configuración 12-factor por variables de entorno |
| Sin estado (*stateless*) y escalable horizontalmente | Ningún estado en memoria que importe. Varias réplicas pueden despachar notificaciones a la vez gracias a `SKIP LOCKED` y al *lease* |
| Comunicación asíncrona y resiliente | Outbox, reintentos con backoff, timeouts y entrega *at-least-once* idempotente (`webhook-id`) |
| Observabilidad | Logs JSON con `requestId` de correlación (propaga `X-Request-Id`), métricas Prometheus y *health checks* `live`/`ready` para el orquestador |
| Integración con plataforma | Confía en el API Gateway para la autenticación (`X-Tenant-Id`), apagado ordenado (SIGTERM: deja de reclamar trabajo y termina los envíos en curso) |

### 4.1 Hexagonal (puertos y adaptadores)

```
             ┌─────────────────────────── infrastructure ───────────────────────────┐
  HTTP  ───▶ │ http/controllers ─▶ (puertos de entrada = casos de uso)               │
             │                     ┌──────────── application ────────────┐          │
             │                     │ use-cases  ──usa──▶ ports (salida)  │          │
             │                     │      │                              │          │
             │                     │      ▼                              │          │
             │                     │  ┌──── domain ────┐                 │          │
             │                     │  │ Shipment, Event │                 │          │
             │                     │  │ Notification,   │                 │          │
             │                     │  │ RetryPolicy     │                 │          │
             │                     │  └─────────────────┘                 │          │
             │                     └──────────────────────────────────────┘          │
             │ persistence/postgres ◀─implementa─ ports    webhook/http-sender       │
             │ worker/notification-worker (polling + SKIP LOCKED)                    │
             └───────────────────────────────────────────────────────────────────────┘
```

Reglas de dependencia, verificadas por ESLint y por una prueba de arquitectura:

- `domain/` no importa nada externo: ni `@nestjs/*`, ni `pg`, ni `zod`, ni `pino`, ni `node:http`.
- `application/` importa solo `domain/` y sus propios puertos. Tampoco usa el framework.
- `infrastructure/` implementa los puertos y hace el cableado con NestJS mediante `useFactory`, de modo que los casos de uso son clases TypeScript puras sin decoradores.

### 4.2 Patrones y principios

| Patrón / principio | Dónde |
|---|---|
| Aggregate root (DDD) | `Shipment` controla las transiciones; `Notification` controla su ciclo de reintentos |
| Value Objects | `TenantId`, `TrackingNumber`, `EventId`, `ShipmentStatus`, `WebhookUrl` |
| Transactional Outbox | Evento + notificación en una sola transacción |
| Competing consumers | Worker con `FOR UPDATE SKIP LOCKED` y *lease* (`locked_until`) |
| Unit of Work | Puerto `TransactionRunner` |
| Strategy | `RetryPolicy` (backoff exponencial con jitter) |
| Ports & Adapters / DIP | Repositorios, `WebhookSender`, `Clock`, `IdGenerator`, `SecretCipher`, `WorkSignal` |
| Result de dominio + errores tipados | `DomainError` con `code` estable, traducido a RFC 9457 en el adaptador HTTP |
| SOLID, fail-fast | Configuración validada al arrancar; inyección de dependencias por constructor |

### 4.3 Flujo de registro de un evento (RF1 + RF4)

```
POST /v1/guias/10000001/eventos ──▶ validar (zod) ──▶ RegisterTrackingEvent
  BEGIN
    pg_advisory_xact_lock(event:tenant:eventId)      -- orden fijo evento → guía (sin deadlocks)
    pg_advisory_xact_lock(shipment:tenant:guía)      -- serializa eventos concurrentes de la guía (incluso si aún no existe)
    SELECT event (tenant,eventId)           -- ¿repetido? → mismo contenido (campo a campo): 200 · distinto: 409
    SELECT shipment  (o Shipment.open)      -- guía nueva si es su primer evento
    shipment.apply(event)                   -- regla terminal → 409
    UPSERT shipment (estado actual)
    INSERT tracking_event                   -- PK(tenant,event_id): última defensa de idempotencia
    INSERT notification (PENDIENTE)         -- outbox, UNIQUE(tenant,event_id)
  COMMIT
  workSignal.wake()                         -- despierta al worker (latencia baja)
◀── 201 (sin esperar al webhook)
```

### 4.4 Flujo de entrega (worker)

```
loop cada POLL_INTERVAL o al recibir wake():
  UPDATE notifications SET status='ENVIANDO', attempts=attempts+1, locked_until=now()+lease
   WHERE id IN (SELECT id … WHERE (status='PENDIENTE' AND next_attempt_at<=now())
                              OR (status='ENVIANDO' AND locked_until<now() AND attempts<max)  -- recuperación ante caídas
                ORDER BY next_attempt_at LIMIT :batch FOR UPDATE SKIP LOCKED)
   RETURNING *;
  por cada una (en paralelo):
    POST firmado HMAC, timeout 5 s, sin redirecciones, IP validada al conectar (anti-SSRF)
    2xx       → ENVIADA
    fallo y attempts<5  → PENDIENTE, next_attempt_at = now()+backoff(attempts)
    fallo y attempts=5  → FALLIDA (consultable y reintentable)
    se registra cada intento en notification_attempts
  antes de reclamar: ENVIANDO con lease vencido en el último intento → FALLIDA (LEASE_EXPIRADO), sin 6.º envío
```

---

## 5. Estructura de carpetas y archivos

```
.
├── .github/workflows/ci.yml          # lint + typecheck + unit + integration + e2e (Postgres service) + build Docker
├── .claude/
│   ├── agents/qa-verifier.md         # agente de QA: funcional, integración, E2E, smoke post-despliegue
│   └── skills/tracking-notifier/SKILL.md  # skill de ingeniería para este proyecto
├── CLAUDE.md                         # contexto del proyecto para asistentes IA
├── docker/
│   ├── webhook-receiver/server.mjs   # webhook de prueba: imprime y verifica la firma; modo de fallo configurable
│   └── postgres/init/                # crea la BD de pruebas en el contenedor
├── docs/
│   ├── adr-001.md                    # Transactional Outbox + SKIP LOCKED
│   ├── informe-implementacion.md     # este documento
│   ├── despliegue-gcp.md             # despliegue de referencia en GCP
│   └── openapi.yaml                  # contrato OpenAPI 3.1
├── scripts/smoke-test.mjs            # E2E post-despliegue contra el stack levantado
├── src/
│   ├── domain/
│   │   ├── shared/domain-error.ts
│   │   ├── tenant/tenant-id.ts
│   │   ├── shipment/{shipment.ts, shipment-status.ts, tracking-event.ts, tracking-number.ts, event-id.ts}
│   │   ├── notification/{notification.ts, retry-policy.ts}
│   │   └── webhook/{webhook-subscription.ts, webhook-url.ts}
│   ├── application/
│   │   ├── ports/{repositories.ts, transaction-runner.ts, webhook-sender.ts, system.ts}
│   │   ├── errors.ts
│   │   └── use-cases/{register-tracking-event, get-shipment-history, configure-webhook,
│   │                  notification-queries, dispatch-due-notifications}.ts
│   ├── infrastructure/
│   │   ├── config/env.ts             # esquema zod de variables de entorno (fail-fast)
│   │   ├── persistence/
│   │   │   ├── migrations/001_init.sql
│   │   │   ├── migrator.ts / migrate.ts   # runner con advisory lock y tabla schema_migrations
│   │   │   ├── pg-pool.ts, pg-transaction-runner.ts
│   │   │   └── repositories/*.ts
│   │   ├── http/
│   │   │   ├── controllers/{shipments,webhook,notifications,ops}.controller.ts
│   │   │   ├── schemas.ts            # zod
│   │   │   ├── validation.ts         # ZodValidationPipe + decorador @TenantHeader
│   │   │   ├── presenters.ts         # dominio → contrato HTTP
│   │   │   └── problem-details.filter.ts   # RFC 9457
│   │   ├── webhook/{http-webhook-sender.ts, hmac-signer.ts, ssrf-guard.ts}
│   │   ├── crypto/{aes-gcm-secret-cipher.ts, system-adapters.ts}
│   │   ├── worker/notification-worker.ts
│   │   ├── observability/{logger.ts, metrics.ts}
│   │   └── nest/{app.module.ts, providers.ts, create-app.ts, tokens.ts}
│   └── main.ts
├── test/
│   ├── unit/{domain,application,infrastructure}/**/*.spec.ts
│   ├── architecture/boundaries.spec.ts
│   ├── integration/**/*.int-spec.ts  # Postgres real
│   ├── e2e/**/*.e2e-spec.ts          # app completa + Postgres real + webhook falso
│   └── support/*                     # fakes, db helpers, servidor webhook de prueba
├── .env.example, .gitignore, .dockerignore, Dockerfile, docker-compose.yml
├── jest.config.js, eslint.config.mjs, tsconfig*.json, package.json
└── README.md
```

---

## 6. Esquema de base de datos (PostgreSQL)

```sql
CREATE TABLE webhook_subscriptions (
  tenant_id          text PRIMARY KEY,
  url                text NOT NULL,
  secret_ciphertext  text NOT NULL,            -- AES-256-GCM (iv:tag:ciphertext, base64)
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipments (
  tenant_id          text NOT NULL,
  tracking_number    text NOT NULL,
  current_status     text NOT NULL CHECK (current_status IN ('CREADA','EN_RUTA','ENTREGADA','DEVUELTA')),
  current_status_at  timestamptz NOT NULL,     -- fechaEvento del evento que fija el estado
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, tracking_number)
);

CREATE TABLE tracking_events (
  tenant_id          text NOT NULL,
  event_id           uuid NOT NULL,
  tracking_number    text NOT NULL,
  status             text NOT NULL CHECK (status IN ('CREADA','EN_RUTA','ENTREGADA','DEVUELTA')),
  occurred_at        timestamptz NOT NULL,
  observation        text NULL,                -- la idempotencia compara guía, estado, fecha y observación
  received_seq       bigint GENERATED ALWAYS AS IDENTITY,   -- desempate por orden de llegada
  received_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id),           -- idempotencia a nivel BD
  FOREIGN KEY (tenant_id, tracking_number) REFERENCES shipments (tenant_id, tracking_number)
);
CREATE INDEX ix_events_history ON tracking_events (tenant_id, tracking_number, occurred_at, received_seq);

CREATE TABLE notifications (
  id                 uuid PRIMARY KEY,
  tenant_id          text NOT NULL,
  event_id           uuid NOT NULL,
  status             text NOT NULL CHECK (status IN ('PENDIENTE','ENVIANDO','ENVIADA','FALLIDA')),
  attempts           int  NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts       int  NOT NULL CHECK (max_attempts > 0),
  next_attempt_at    timestamptz NOT NULL,
  locked_until       timestamptz NULL,
  last_error         text NULL,                -- código técnico, nunca el cuerpo de la respuesta
  last_http_status   int  NULL,
  delivered_at       timestamptz NULL,
  failed_at          timestamptz NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_id),                -- una notificación por evento, sin duplicados
  FOREIGN KEY (tenant_id, event_id) REFERENCES tracking_events (tenant_id, event_id)
);
CREATE INDEX ix_notifications_due ON notifications (next_attempt_at) WHERE status IN ('PENDIENTE','ENVIANDO');
CREATE INDEX ix_notifications_tenant_status ON notifications (tenant_id, status, created_at DESC);

CREATE TABLE notification_attempts (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_id    uuid NOT NULL REFERENCES notifications (id),
  attempt_number     int  NOT NULL,
  attempted_at       timestamptz NOT NULL,
  duration_ms        int  NOT NULL,
  http_status        int  NULL,
  error_code         text NULL                 -- sin UNIQUE(notification_id, attempt_number): un reintento
);                                             -- manual reinicia el contador; el historial se ordena por id
```

La fuente de verdad del esquema es `src/infrastructure/persistence/migrations/001_init.sql`.

**Aislamiento por tenant:** todas las PK y FK incluyen `tenant_id`, y todos los métodos de repositorio exigen `TenantId` como parámetro obligatorio. Como defensa en profundidad para el futuro queda Row-Level Security de PostgreSQL (ver §10).

---

## 7. Contratos de API (resumen; el detalle está en `docs/openapi.yaml`)

Todas las rutas de negocio exigen la cabecera `X-Tenant-Id`. Los errores usan `application/problem+json` (RFC 9457):

```json
{ "type": "https://tracking-notifier.domina.dev/problemas/guia-en-estado-terminal",
  "title": "Conflicto con el estado del recurso", "status": 409,
  "detail": "La guía 10000001 está ENTREGADA y no admite más cambios de estado",
  "instance": "/v1/guias/10000001/eventos", "code": "GUIA_EN_ESTADO_TERMINAL",
  "requestId": "6f1c…", "errors": [ { "path": "fechaEvento", "message": "…" } ] }
```

| Método y ruta | Descripción | Respuestas |
|---|---|---|
| `POST /v1/guias/{numeroGuia}/eventos` | Registra un evento. Cuerpo: `{eventId: uuid, estado, fechaEvento: ISO 8601 con zona, observacion?: string≤500}` | **201** creado · **200** repetición idempotente · 400 validación · 409 `GUIA_EN_ESTADO_TERMINAL` · 409 `EVENT_ID_CONFLICTO` · 415 |
| `GET /v1/guias/{numeroGuia}` | Estado actual y eventos en orden cronológico | 200 · 404 |
| `PUT /v1/webhook` | Crea o actualiza la URL. Cuerpo `{url, rotarSecreto?: boolean}` | **201** creado (incluye `secreto`) · 200 actualizado (incluye `secreto` solo si se rotó) · 400 |
| `GET /v1/webhook` | Configuración actual, sin el secreto | 200 · 404 |
| `GET /v1/notificaciones?estado=&limit=` | Lista las notificaciones del tenant | 200 |
| `GET /v1/notificaciones/{id}` | Detalle de una notificación con sus intentos | 200 · 404 |
| `POST /v1/notificaciones/{id}/reintentar` | Devuelve una notificación `FALLIDA` a la cola | 202 · 404 · 409 `NOTIFICACION_NO_REINTENTABLE` |
| `GET /health/live`, `GET /health/ready` | Liveness y readiness (ping a la BD) | 200 · 503 |
| `GET /metrics` | Métricas Prometheus | 200 |
| `GET /docs` | Swagger UI sobre `openapi.yaml` | 200 |

**Payload enviado al webhook:**

```http
POST {url}
Content-Type: application/json
webhook-id: {eventId}
webhook-timestamp: {unix seconds}
webhook-signature: v1,{base64(HMAC-SHA256(secret, id + "." + timestamp + "." + body))}
X-Delivery-Attempt: {n}

{ "type": "guia.estado_actualizado", "eventId": "…", "numeroGuia": "10000001",
  "estado": "EN_RUTA", "fechaEvento": "…", "observacion": "…", "recibidoEn": "…" }
```

---

## 8. Seguridad (OWASP ASVS / API Top 10)

| Riesgo | Control |
|---|---|
| Inyección SQL | Solo consultas parametrizadas (`$1…`) con `pg` |
| Validación de entradas | `zod` en estricto (rechaza campos desconocidos), límites de longitud, UUID, ISO 8601 con zona, límite de cuerpo de 16 KB |
| BOLA / aislamiento | `tenant_id` en todas las consultas y llaves; 404 indistinguible |
| SSRF (URL de webhook) | Solo `http`/`https` (https obligatorio cuando `WEBHOOK_REQUIRE_HTTPS=true`); sin credenciales en la URL; IP resuelta y validada **en el momento de conectar** (lookup personalizado) contra loopback, privadas, link-local, metadata, ULA, multicast y mapeadas; no se siguen redirecciones. `WEBHOOK_ALLOW_PRIVATE_NETWORKS=true` solo para el entorno local de docker compose |
| Autenticidad del webhook | HMAC-SHA256 (Standard Webhooks) con timestamp contra replay |
| Secretos | Variables de entorno; `.env` en `.gitignore`; `.env.example` sin valores reales; secreto HMAC cifrado en reposo (AES-256-GCM) |
| Datos personales en logs | Pino con `redact`; nunca se loguea el body, `observacion`, el secreto ni la ruta del webhook |
| Fuga de información en errores | El filtro de excepciones oculta el stack y devuelve 500 genérico con `requestId` |
| Cabeceras HTTP | `X-Powered-By` deshabilitado, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` |
| Contenedor | Imagen multi-stage, usuario no root (`node`), `npm ci --omit=dev`, healthcheck |
| Cadena de suministro | Versiones fijadas, `package-lock.json`, `npm audit` en el CI |

---

## 9. Estrategia de pruebas (QA)

| Nivel | Qué prueba y por qué | Herramienta |
|---|---|---|
| Unitarias de dominio | Reglas de transición (terminales), selección del estado actual con eventos fuera de orden, comparación de contenido para idempotencia, rechazo de `fechaEvento` futura, máquina de estados de `Notification` y `RetryPolicy` (espera creciente con jitter acotado, tope de 5) | Jest |
| Unitarias de aplicación | Casos de uso con *fakes* en memoria: idempotencia (200/409), aislamiento, el despacho marca ENVIADA, PENDIENTE o FALLIDA | Jest |
| Unitarias de infraestructura | Firma HMAC (vector conocido), guardia SSRF (rangos IPv4/IPv6), cifrado AES-GCM ida y vuelta, mapeo de errores a RFC 9457 | Jest |
| Arquitectura | `domain/` y `application/` no importan frameworks ni infraestructura | Jest (análisis de imports) |
| Integración (PostgreSQL real) | Migraciones; repositorios; **idempotencia bajo concurrencia** (N peticiones simultáneas con el mismo `eventId` dejan 1 evento y 1 notificación); **SKIP LOCKED** (dos workers no reclaman la misma fila); recuperación de *lease* vencido; aislamiento por tenant a nivel de consulta | Jest + `pg` |
| E2E (API completa) | Aplicación Nest real + PostgreSQL + servidor webhook falso: 201/200/409/400/404; entrega firmada y verificable; no bloquea la respuesta; webhook lento (>5 s) o con 500 → 5 intentos → `FALLIDA` → consultable → reintento manual; aislamiento entre tenants por HTTP | Jest + supertest |
| Smoke post-despliegue | Contra el stack de `docker compose up`: health, configurar webhook, registrar evento, ver la notificación `ENVIADA`, idempotencia, transición terminal rechazada | `scripts/smoke-test.mjs` |

Comandos:

- `npm test` corre todo (unit + arquitectura + integración + E2E) en un solo comando; necesita `DATABASE_URL_TEST`.
- `npm run test:unit` no requiere base de datos.
- `docker compose --profile test run --rm tests` corre todo dentro de Docker.
- `npm run test:smoke` es el E2E post-despliegue.

**Criterios de aceptación (Definition of Done):** lint y typecheck limpios; todas las suites en verde; cobertura del dominio ≥ 90 %; smoke post-despliegue en verde; README y ADR actualizados.

---

## 9.1 Alineación con el stack de Domina (Node.js, React, GCP)

- **Node.js** es el runtime del servicio (Node 26 LTS + NestJS 12).
- **GCP:** el servicio está listo para Cloud Run:
  - Escucha en `PORT`, es *stateless*, hace apagado ordenado con SIGTERM y expone *health checks*.
  - Usa Cloud SQL for PostgreSQL, por socket `/cloudsql` o IP privada con TLS, y Secret Manager para `DATABASE_URL` y la clave de cifrado.
  - Sus logs son JSON compatibles con Cloud Logging (`severity`, `message`, `logging.googleapis.com/trace`) y sus métricas, Prometheus (Managed Service for Prometheus).
  - `APP_ROLE=api|worker|all` permite desplegar la misma imagen como dos servicios: la API con autoescalado y el worker con `--no-cpu-throttling`. El detalle está en `docs/despliegue-gcp.md`.
- **React:** el contrato OpenAPI 3.1 permite generar un cliente tipado para un panel de clientes; `CORS_ORIGINS` habilita su origen.

## 10. Consideraciones adicionales y trabajo futuro

- **Escalabilidad:** el worker es seguro con N réplicas (SKIP LOCKED + lease). A gran escala se podría migrar el outbox a un broker (Kafka/SQS) con un relay o CDC (Debezium).
- **Row-Level Security** en PostgreSQL con `SET LOCAL app.tenant_id` como segunda barrera de aislamiento.
- **Circuit breaker por tenant**, para no consumir intentos contra endpoints caídos de forma prolongada, y deshabilitar automáticamente un endpoint (lo sugiere Standard Webhooks).
- **Particionado/retención** de `tracking_events` y `notification_attempts` por fecha.
- **OpenTelemetry** (trazas distribuidas) además de las métricas Prometheus.
- **Autenticación real:** hoy se confía en `X-Tenant-Id` porque el enunciado supone que el API Gateway ya lo validó. En producción se validaría un JWT o mTLS entre el gateway y el servicio.
- **Rotación de la clave de cifrado** con identificador de clave (*key id*) en el texto cifrado.

---

## 11. Plan de ejecución (commits que cuentan la historia)

Convención: `<tipo>: <VERBO> <qué>`, sin líneas de autoría. Por ejemplo `feat: ADD …`, `refactor: MODIFY …`, `fix: REPAIR …`, `test: ADD …`, `docs: ADD …`, `build: ADD …`, `ci: ADD …`.

1. `docs: ADD informe de implementacion, skill y agente QA`
2. `build: ADD proyecto base NestJS TypeScript con lint y jest`
3. `feat: ADD dominio de guias con regla de estados terminales`
4. `feat: ADD dominio de notificaciones y politica de reintentos`
5. `feat: ADD casos de uso y puertos de aplicacion`
6. `feat: ADD persistencia PostgreSQL con migraciones y repositorios`
7. `feat: ADD API HTTP con validacion y problem details`
8. `feat: ADD worker outbox con envio HMAC y proteccion SSRF`
9. `feat: ADD logs estructurados, metricas y health checks`
10. `test: ADD pruebas de integracion y end to end`
11. `build: ADD docker compose con webhook de prueba y smoke test`
12. `ci: ADD pipeline de GitHub Actions`
13. `docs: ADD README, ADR-001 y OpenAPI`
