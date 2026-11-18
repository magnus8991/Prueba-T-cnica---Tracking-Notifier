# tracking-notifier

Microservicio que **recibe cambios de estado de guías de envío**, los **guarda por cliente (tenant)** y **notifica al sistema de cada cliente mediante un webhook**: de forma asíncrona, con reintentos y sin perder eventos.

**Stack:** Node.js 26 LTS · NestJS 12 · TypeScript 6 · PostgreSQL 18 · Docker. Listo para desplegar en Google Cloud (Cloud Run + Cloud SQL).

| Documento | Contenido |
|---|---|
| [docs/adr-001.md](docs/adr-001.md) | **ADR:** Transactional Outbox + `SKIP LOCKED` (la decisión más importante) |
| [docs/openapi.yaml](docs/openapi.yaml) | Contrato OpenAPI 3.1, también servido en `GET /docs` |
| [docs/informe-implementacion.md](docs/informe-implementacion.md) | Informe de implementación: análisis, esquema de BD, contratos, seguridad y estrategia de pruebas |
| [docs/despliegue-gcp.md](docs/despliegue-gcp.md) | Despliegue de referencia en GCP |

---

## 1. Cómo correrlo

### Con Docker (recomendado)

```bash
docker compose up --build
```

Levanta tres servicios:

| Servicio | URL | Para qué |
|---|---|---|
| `app` | http://localhost:8080 (Swagger en `/docs`) | El microservicio (aplica las migraciones al arrancar) |
| `db` | `localhost:5433` | PostgreSQL 18 |
| `webhook-receiver` | http://localhost:9090 | Webhook de prueba: imprime lo recibido y verifica la firma HMAC |

Todas las credenciales de `docker-compose.yml` son **ficticias y solo locales**. Se pueden cambiar con un `.env` (ver `.env.example`).

### Probarlo a mano

```bash
# 1) Configurar el webhook del tenant (devuelve el secreto HMAC UNA sola vez)
curl -s -X PUT localhost:8080/v1/webhook -H 'X-Tenant-Id: banco-ficticio' \
  -H 'Content-Type: application/json' -d '{"url":"http://webhook-receiver:8080/hook"}'

# 2) Registrar un evento → 201 (el envío al webhook ocurre en segundo plano)
curl -s -X POST localhost:8080/v1/guias/GUIA-0001/eventos -H 'X-Tenant-Id: banco-ficticio' \
  -H 'Content-Type: application/json' \
  -d '{"eventId":"3f6b2c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b","estado":"EN_RUTA","fechaEvento":"2026-11-18T10:15:00-05:00","observacion":"Salió del CD"}'

# 3) Ver lo que llegó al webhook (con la firma verificada si se le pasa el secreto)
docker compose logs webhook-receiver

# 4) Historial y notificaciones
curl -s localhost:8080/v1/guias/GUIA-0001 -H 'X-Tenant-Id: banco-ficticio'
curl -s localhost:8080/v1/notificaciones -H 'X-Tenant-Id: banco-ficticio'

# 5) Simular un cliente caído para ver los reintentos (5 intentos, espera creciente → FALLIDA)
curl -s -X POST localhost:9090/_config -d '{"failNext":5,"status":503}'
```

### Sin Docker

Requiere Node 24 o superior y PostgreSQL. Ajuste `.env` a partir de `.env.example`:

```bash
npm ci
npm run migrate:dev
npm run start:dev
```

## 2. Cómo probarlo

| Comando | Qué corre | Requiere |
|---|---|---|
| `npm test` | **Todo en un solo comando:** unitarias, arquitectura, integración y E2E | `DATABASE_URL_TEST` (PostgreSQL real) |
| `docker compose --profile test run --rm tests` | Lo mismo, dentro de Docker | Solo Docker |
| `npm run test:unit` | Dominio, aplicación, adaptadores y reglas de arquitectura | Nada |
| `npm run test:integration` | Repositorios, concurrencia, `SKIP LOCKED`, sender HTTP real | PostgreSQL |
| `npm run test:e2e` | API completa + PostgreSQL + servidor webhook real | PostgreSQL |
| `npm run test:smoke` | **E2E post-despliegue** contra el stack levantado con `docker compose up` | Stack en ejecución |
| `npm run test:cov` | Todas, con cobertura (umbral ≥ 90 % en `src/domain`) | PostgreSQL |

**Estado actual:** 218 pruebas en verde y smoke post-despliegue 12/12 contra el servicio compilado. Una auditoría QA independiente (agente `qa-verifier`) encontró 7 defectos de severidad media y baja; todos están corregidos y tienen prueba de regresión.

### Qué se prueba y por qué

| Riesgo | Prueba |
|---|---|
| Duplicar eventos o notificaciones | 20 peticiones **concurrentes** con el mismo `eventId` dejan 1 evento y 1 notificación (integración, PostgreSQL real) |
| Reabrir una guía cerrada | Unitarias de las reglas terminales, una carrera `ENTREGADA` vs `EN_RUTA` concurrente y E2E con 409 |
| Fuga entre tenants | Las consultas de un tenant nunca devuelven datos de otro (repositorios y HTTP: guías, notificaciones, webhook y reintento) |
| Perder notificaciones | El outbox se escribe en la misma transacción; recuperación de *lease* vencido (worker caído) |
| Envío duplicado entre workers | Tres workers reclamando en paralelo no se pisan (`SKIP LOCKED`) |
| Reintentos incorrectos | La propiedad "espera creciente" se verifica con 500 secuencias aleatorias; 5 intentos y luego `FALLIDA` (unitarias, E2E y smoke con los tiempos reales) |
| Bloquear la respuesta | Con un webhook lento, el `POST` responde de inmediato |
| Timeout de 5 s | El valor por defecto queda probado en la configuración y el sender corta el envío al vencer el timeout (servidor HTTP real) |
| SSRF por la URL del webhook | IPs privadas, metadata, IPv4-mapped y NAT64, *hostname* que resuelve a loopback y redirecciones 3xx |
| Firma interoperable | Vector oficial de Standard Webhooks |
| PII en logs | Se audita el log real del E2E y del smoke: ni la observación, ni el secreto, ni la URL del webhook aparecen |
| Erosión de la arquitectura | Una prueba de arquitectura y ESLint fallan si `domain/` o `application/` importan framework o infraestructura |

## 3. Arquitectura

**Microservicio** con un único *bounded context* (eventos de guías y notificación). Tiene base de datos propia, contrato `/v1` versionado, es *stateless* y escala horizontalmente. Por dentro sigue una **arquitectura hexagonal**:

```
src/
├── domain/          Reglas puras. Sin framework, ORM ni APIs de Node.
│   ├── shipment/       Shipment (agregado; regla terminal), TrackingEvent, value objects
│   ├── notification/   Notification (máquina de estados del outbox), ExponentialBackoffPolicy
│   └── webhook/        WebhookSubscription, WebhookUrl
├── application/     Casos de uso (puertos de entrada) + puertos de salida (interfaces)
│   ├── use-cases/      RegisterTrackingEvent, GetShipmentHistory, ConfigureWebhook,
│   │                   DispatchDueNotifications, List/Get/RetryNotification
│   └── ports/          Repositorios, TransactionRunner, WebhookSender, Clock, ...
└── infrastructure/  Adaptadores
    ├── http/           Controllers NestJS, validación zod, Problem Details (RFC 9457)
    ├── persistence/    PostgreSQL (pg, SQL explícito), migraciones, Unit of Work
    ├── webhook/        Sender HTTP, firma HMAC, guard SSRF
    ├── worker/         Bucle del despachador (outbox)
    ├── crypto/ observability/ config/
    └── nest/           Composition root: cableado de puertos con adaptadores (useFactory)
```

- Los casos de uso son **clases TypeScript puras**: Nest las construye con `useFactory` y no llevan decoradores.
- El dominio no conoce PostgreSQL: los repositorios traducen filas a agregados.
- Se usa SQL explícito con `pg` en lugar de un ORM, para controlar los bloqueos (`FOR UPDATE SKIP LOCKED`, `pg_advisory_xact_lock`) y para que el dominio no dependa de anotaciones de persistencia.

### Flujo

```
POST /eventos ─▶ [TX: lock evento→guía · idempotencia · regla terminal · INSERT evento · UPSERT guía · INSERT notificación PENDIENTE] ─▶ 201
                                                                                     │ (señal + polling)
Despachador ─▶ claim (SKIP LOCKED, lease) ─▶ POST firmado (timeout 5 s) ─▶ ENVIADA | PENDIENTE(+backoff) | FALLIDA
```

## 4. API

| Método | Ruta | Respuestas |
|---|---|---|
| POST | `/v1/guias/{numeroGuia}/eventos` | 201 · 200 (idempotente) · 400 · 409 · 413 · 415 |
| GET | `/v1/guias/{numeroGuia}` | 200 · 404 |
| PUT | `/v1/webhook` | 201 (con secreto) · 200 · 400 |
| GET | `/v1/webhook` | 200 · 404 |
| GET | `/v1/notificaciones?estado=FALLIDA&limit=50` | 200 |
| GET | `/v1/notificaciones/{id}` | 200 (con historial de intentos) · 404 |
| POST | `/v1/notificaciones/{id}/reintentar` | 202 · 404 · 409 |
| GET | `/health/live`, `/health/ready`, `/metrics`, `/docs` | Operación |

Todos los errores usan **un único formato**, RFC 9457 `application/problem+json`, con un `code` estable y el `requestId` para correlación.

**Webhook saliente** (Standard Webhooks): cabeceras `webhook-id` (= eventId, estable entre reintentos), `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256>` y `x-delivery-attempt`.

## 5. Decisiones y supuestos

| # | Duda del enunciado | Decisión |
|---|---|---|
| 1 | El cuerpo no trae el número de guía | Va en la ruta: `POST /v1/guias/{numeroGuia}/eventos` |
| 2 | ¿Hay que empezar en `CREADA`? | No. La guía se crea con su primer evento, sea cual sea el estado; el enunciado solo prohíbe salir de los estados terminales |
| 3 | Transiciones | Solo `ENTREGADA` y `DEVUELTA` son terminales (409 `GUIA_EN_ESTADO_TERMINAL`). Se permite repetir estados no terminales (varios escaneos `EN_RUTA`) |
| 4 | Eventos fuera de orden | El historial se ordena por `fechaEvento` (y por orden de llegada en empates). El estado actual es el del evento más reciente; un terminal siempre cierra la guía |
| 5 | Mismo `eventId` | La idempotencia es **por tenant**. Con el mismo contenido responde 200 y `Idempotent-Replayed: true`, sin efectos. Con distinto contenido responde 409 `EVENT_ID_CONFLICTO` |
| 6 | "Hasta 5 intentos" | 5 intentos en total. Backoff exponencial con *equal jitter*, base 2 s: ~1–2 s, 2–4 s, 4–8 s, 8–16 s (estrictamente no decreciente) |
| 7 | ¿Qué es fallar? | Error de red, timeout de 5 s o cualquier respuesta distinta de 2xx. Las redirecciones **no** se siguen (anti-SSRF) |
| 8 | Tenant sin webhook | La notificación se encola igual y no se pierde; tras 5 intentos queda `FALLIDA` (`WEBHOOK_NO_CONFIGURADO`) y se puede reintentar con `POST /reintentar` cuando el cliente configure la URL |
| 9 | Garantía de entrega | *At-least-once*: el cliente deduplica por `webhook-id` |
| 10 | `X-Tenant-Id` | Se confía en el API Gateway; aquí solo se valida su forma (`[A-Za-z0-9_-]{1,64}`). Si falta o es inválido: 400 |
| 11 | Guía de otro tenant | 404, igual que una inexistente, para no revelar su existencia |
| 12 | Secreto HMAC | Lo genera el servidor (`whsec_` + 32 bytes), **se muestra una sola vez** y se guarda cifrado (AES-256-GCM con el tenant como AAD) |
| 13 | `observacion` | Se trata como posible dato personal: se guarda y se envía al cliente, pero **nunca se registra en logs** |
| 14 | `fechaEvento` | ISO 8601 **con zona horaria obligatoria**, para evitar ambigüedad de hora local. Se rechaza si está más de 5 minutos en el futuro (`FECHA_EVENTO_FUTURA`), porque un reloj desfasado del emisor congelaría el estado de la guía |
| 15 | Concurrencia en operaciones de soporte | De N reintentos manuales simultáneos solo uno es aceptado (202) y el resto recibe 409. El primer `PUT /webhook` concurrente crea y revela un único secreto |

### Seguridad

- Validación estricta con zod: tipos, formatos y longitudes; los campos desconocidos se rechazan.
- Consultas SQL siempre parametrizadas.
- Límite de 16 KB por cuerpo y respuesta 415 si no es JSON.
- Protección SSRF basada en la guía de OWASP: las IPs se validan al conectar, lo que resiste DNS rebinding. Con valores seguros por defecto (`WEBHOOK_REQUIRE_HTTPS=true`, `WEBHOOK_ALLOW_PRIVATE_NETWORKS=false`), solo `docker-compose.yml` relaja estas reglas para el receptor local.
- Secretos solo por variables de entorno (Secret Manager en GCP); `.env` está en `.gitignore` y la configuración se valida al arrancar sin imprimir valores.
- Logs JSON con `redact` y serializadores que nunca incluyen el body ni las cabeceras completas.
- Contenedor con usuario no root y sin dependencias de desarrollo. `npm audit --omit=dev` reporta 0 vulnerabilidades.
- **Riesgo aceptado:** `npm audit` completo reporta vulnerabilidades en herramientas de **desarrollo** (jest y typescript-eslint vía `picomatch`, ReDoS). `picomatch` no tiene versión parcheada publicada y estas herramientas no llegan a la imagen de producción.

## 6. Qué haría con más tiempo

- **Row-Level Security** en PostgreSQL (`SET LOCAL app.tenant_id`) como segunda barrera de aislamiento.
- **Circuit breaker por tenant** y desactivación automática de endpoints que fallan durante días, con aviso al cliente por otro canal.
- Relay del outbox hacia **Pub/Sub** cuando aparezcan más consumidores del evento.
- **OpenTelemetry** (trazas distribuidas hacia Cloud Trace) además de las métricas Prometheus.
- Rotación de la clave de cifrado con *key id* (o Cloud KMS) y doble firma durante la rotación del secreto HMAC.
- Paginación por cursor en `/v1/notificaciones`, retención y particionado de `notification_attempts`.
- Pruebas de contrato (validar las respuestas contra `openapi.yaml`) y pruebas de carga (k6).
- Despliegue continuo a Cloud Run desde GitHub Actions con Workload Identity Federation.

## 7. Uso de IA

Usé **Claude Code** (modelo Claude Opus 5.5, de Anthropic) como asistente de ingeniería para:

- Investigar en fuentes oficiales y contrastar estándares: RFC 9457, Standard Webhooks, OWASP SSRF, documentación de PostgreSQL sobre `SKIP LOCKED`, versiones de npm, Node.js y PostgreSQL.
- Redactar el informe de implementación, el ADR y este README a partir de mis decisiones.
- Generar código y pruebas de forma incremental, commit a commit, siguiendo la arquitectura hexagonal definida.
- Ejecutar y depurar las pruebas. Por ejemplo, detectó que NestJS 12 es ESM-only y que jest requiere `--experimental-vm-modules`, y el smoke test detectó una configuración local insegura.

Revisé, ajusté y entiendo todo el código entregado; puedo explicarlo y modificarlo en la entrevista. Los archivos [.claude/skills/tracking-notifier/SKILL.md](.claude/skills/tracking-notifier/SKILL.md) y [.claude/agents/qa-verifier.md](.claude/agents/qa-verifier.md) documentan las reglas y el flujo de calidad que usé con el asistente.
