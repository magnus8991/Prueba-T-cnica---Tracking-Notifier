# Guía de pruebas paso a paso: tracking-notifier

Esta guía permite verificar a mano **todos los requisitos de la prueba técnica** (RF1–RF4, reglas técnicas y opcionales), y después correr las pruebas automatizadas. Cada paso indica el comando, el resultado esperado y qué requisito valida.

Todos los comandos y resultados se ejecutaron y verificaron el 2026-11-18 contra `docker compose up` en Windows 11 con Docker Desktop 4.99. Todos los datos son **ficticios**.

---

## 0. Requisitos previos

| Herramienta | Para qué | Comprobar |
|---|---|---|
| Docker Desktop **en ejecución** | Levantar el servicio, la BD y el webhook de prueba | `docker version` (debe mostrar *Server*) |
| `curl.exe` | Llamar a la API (incluido en Windows 10/11) | `curl.exe --version` |
| Node.js 24 o superior (opcional) | Solo para `npm run test:smoke` y `npm test` fuera de Docker | `node -v` |

Los puertos **8080**, **5433** y **9090** deben estar libres.

> **Shell:** los comandos están escritos para **PowerShell** (la consola de VS Code en Windows). En Git Bash o Linux/macOS use `curl` en lugar de `curl.exe` y `export B=http://localhost:8080` en lugar de `$B = ...`.
>
> Ejecute todo **desde la raíz del repositorio**: los cuerpos de las peticiones se leen de `docs/pruebas/*.json`, lo que evita problemas de comillas entre consolas.

---

## 1. Datos de conexión y de prueba

### Servicios que levanta `docker compose`

| Servicio | URL / conexión | Uso |
|---|---|---|
| API tracking-notifier | http://localhost:8080 | El microservicio |
| Swagger (OpenAPI 3.1) | http://localhost:8080/docs | Documentación interactiva de la API |
| Métricas Prometheus | http://localhost:8080/metrics | Observabilidad |
| Health | http://localhost:8080/health/live · http://localhost:8080/health/ready | Liveness y readiness |
| Webhook de prueba (cliente simulado) | http://localhost:9090 · desde el servicio: `http://webhook-receiver:8080/hook` | Recibe las notificaciones e imprime lo que llega |
| PostgreSQL 18 | `localhost:5433` · BD `tracking_notifier` · usuario `tracking_notifier` · contraseña `local_dev_only_password` | Inspeccionar datos (credenciales ficticias, solo locales) |

### Datos de prueba (`docs/pruebas/`)

| Dato | Valor |
|---|---|
| Tenant principal | `banco-demo` |
| Tenant para probar aislamiento | `retail-demo` |
| Guía del flujo feliz | `GUIA-DEMO-001` |
| Guía para reintentos (cliente caído) | `GUIA-DEMO-002` |
| Guía para timeout (cliente lento) | `GUIA-DEMO-003` |

| Archivo | Contenido | Se usa en |
|---|---|---|
| `01-configurar-webhook.json` | URL del webhook de prueba | Paso 3 |
| `12-webhook-rotar-secreto.json` | Misma URL con `rotarSecreto: true` | Paso 4 |
| `02-evento-creada.json` | eventId `…0001`, estado `CREADA` | Pasos 5 y 6 |
| `03-evento-en-ruta.json` | eventId `…0002`, estado `EN_RUTA` | Paso 7 |
| `04-evento-entregada.json` | eventId `…0003`, estado `ENTREGADA` | Paso 9 |
| `05-evento-despues-de-entregada.json` | `EN_RUTA` sobre una guía ya entregada | Paso 10 |
| `06-evento-conflicto.json` | **Mismo eventId** que `02` con otro estado | Paso 12 |
| `07-evento-invalido.json` | UUID, estado y fecha inválidos + campo extra | Paso 13 |
| `08-evento-fecha-futura.json` | `fechaEvento` en 2099 | Paso 14 |
| `10-webhook-ssrf.json` | URL `ftp://169.254.169.254/...` | Paso 17 |
| `09-evento-guia-con-falla.json` | Evento de `GUIA-DEMO-002` | Paso 18 |
| `11-evento-guia-lenta.json` | Evento de `GUIA-DEMO-003` | Paso 20 |
| `receptor-simular-caida.json` | El webhook responde 503 las próximas 5 veces | Paso 18 |
| `receptor-simular-lentitud.json` | El webhook tarda 7 s en responder | Paso 20 |
| `receptor-normal.json` | El webhook vuelve a responder 200 de inmediato | Pasos 19 y 20 |

---

## 2. Levantar el entorno

```powershell
docker compose up -d --build --wait
docker compose ps
```

**Esperado:** `app`, `db` y `webhook-receiver` en estado `Up (healthy)`. La primera vez tarda unos minutos porque construye la imagen. La app aplica las migraciones al arrancar.

Defina estas variables en la misma consola; los pasos siguientes las usan:

```powershell
$B = "http://localhost:8080"
$R = "http://localhost:9090"
$T = "banco-demo"
$J = "Content-Type: application/json"
```

> Para ver en vivo lo que recibe el "sistema del cliente", abra **otra** terminal y ejecute:
> `docker compose logs -f webhook-receiver`

---

## 3. Prueba manual paso a paso

### Paso 1: el servicio está listo

```powershell
curl.exe -s "$B/health/ready"
```

✅ `{"status":"ok","checks":{"database":"up"}}`

### Paso 2: Swagger

Abra http://localhost:8080/docs en el navegador. ✅ Se ve la API documentada (OpenAPI 3.1, requisito opcional).

### Paso 3: configurar el webhook del cliente (RF3)

```powershell
curl.exe -s -w "`nHTTP %{http_code}`n" -X PUT "$B/v1/webhook" -H "X-Tenant-Id: $T" -H $J --data-binary "@docs/pruebas/01-configurar-webhook.json"
```

✅ **HTTP 201**, con `secreto` (`whsec_…`) y `algoritmoFirma`. El secreto se muestra **solo esta vez**.

Repita el mismo comando: ✅ **HTTP 200**, ya **sin** `secreto` (actualizar no lo vuelve a revelar).

```powershell
curl.exe -s "$B/v1/webhook" -H "X-Tenant-Id: $T"
```

✅ Devuelve la URL **sin** el secreto.

### Paso 4: rotar el secreto y entregárselo al cliente simulado (firma HMAC)

Así el webhook de prueba puede verificar la firma de cada notificación:

```powershell
$hook = curl.exe -s -X PUT "$B/v1/webhook" -H "X-Tenant-Id: $T" -H $J --data-binary "@docs/pruebas/12-webhook-rotar-secreto.json" | ConvertFrom-Json
$hook.secreto
Invoke-RestMethod -Method Post -Uri "$R/_config" -Body (@{ secret = $hook.secreto } | ConvertTo-Json)
```

✅ Se imprime un secreto nuevo y el receptor responde `secretConfigured: True`.

### Paso 5: registrar un evento (RF1 y RF4)

```powershell
curl.exe -s -w "`nHTTP %{http_code} en %{time_total}s`n" -X POST "$B/v1/guias/GUIA-DEMO-001/eventos" -H "X-Tenant-Id: $T" -H $J --data-binary "@docs/pruebas/02-evento-creada.json"
```

✅ **HTTP 201** en milisegundos, con `estadoActualGuia: "CREADA"`. `fechaEvento` se normaliza a UTC (`2026-11-17T13:00:00.000Z`).

> Este evento se envía antes de que el receptor conozca el secreto (paso 4), así que en el paso 7 su `signatureValid` aparecerá vacío. Si hace el paso 4 antes del 5, también aparecerá `True`.

### Paso 6: idempotencia, enviar el MISMO evento otra vez (RF1)

```powershell
curl.exe -s -i -X POST "$B/v1/guias/GUIA-DEMO-001/eventos" -H "X-Tenant-Id: $T" -H $J --data-binary "@docs/pruebas/02-evento-creada.json" | Select-String "^HTTP|Idempotent"
```

✅ `HTTP/1.1 200 OK` y `Idempotent-Replayed: true`. No se duplica ni el evento ni la notificación.

### Paso 7: la notificación llegó al cliente, firmada y una sola vez (RF4)

```powershell
curl.exe -s -o NUL -w "HTTP %{http_code}`n" -X POST "$B/v1/guias/GUIA-DEMO-001/eventos" -H "X-Tenant-Id: $T" -H $J --data-binary "@docs/pruebas/03-evento-en-ruta.json"
Invoke-RestMethod "$R/_received" | Select-Object webhookId, attempt, signatureValid, respondedWith | Format-Table
```

✅ Cada `webhookId` (= `eventId`) aparece **una sola vez**, aunque el paso 6 repitió el evento. El de `…0002` (EN_RUTA) tiene `signatureValid = True`.

En la otra terminal (`docker compose logs -f webhook-receiver`) se ve el JSON recibido: `type: guia.estado_actualizado`, `eventId`, `numeroGuia`, `estado`, `fechaEvento` y `observacion`.

### Paso 8: estado de las notificaciones (RF4)

```powershell
curl.exe -s "$B/v1/notificaciones" -H "X-Tenant-Id: $T"
```

✅ Notificaciones con `estado: "ENVIADA"`, `intentos: 1` y `ultimoHttpStatus: 200`.

### Paso 9: cerrar la guía con ENTREGADA

```powershell
curl.exe -s -o NUL -w "HTTP %{http_code}`n" -X POST "$B/v1/guias/GUIA-DEMO-001/eventos" -H "X-Tenant-Id: $T" -H $J --data-binary "@docs/pruebas/04-evento-entregada.json"
```

✅ **HTTP 201**

### Paso 10: una guía ENTREGADA ya no cambia de estado (RF1, regla terminal)

```powershell
curl.exe -s -w "`nHTTP %{http_code}`n" -X POST "$B/v1/guias/GUIA-DEMO-001/eventos" -H "X-Tenant-Id: $T" -H $J --data-binary "@docs/pruebas/05-evento-despues-de-entregada.json"
```

✅ **HTTP 409** con `code: "GUIA_EN_ESTADO_TERMINAL"`, en formato RFC 9457 (`type`, `title`, `status`, `detail`, `instance`, `requestId`).

### Paso 11: historial y estado actual (RF2)

```powershell
curl.exe -s "$B/v1/guias/GUIA-DEMO-001" -H "X-Tenant-Id: $T"
```

✅ `estadoActual: "ENTREGADA"` y `eventos` en **orden cronológico**: CREADA (13:00Z), EN_RUTA (15:30Z) y ENTREGADA (20:45Z).

### Paso 12: mismo eventId con distinto contenido (RF1)

```powershell
curl.exe -s -w "`nHTTP %{http_code}`n" -X POST "$B/v1/guias/GUIA-DEMO-001/eventos" -H "X-Tenant-Id: $T" -H $J --data-binary "@docs/pruebas/06-evento-conflicto.json"
```

✅ **HTTP 409** con `code: "EVENT_ID_CONFLICTO"`.

### Paso 13: validación de entradas (formato de error único)

```powershell
curl.exe -s -w "`nHTTP %{http_code}`n" -X POST "$B/v1/guias/GUIA-DEMO-002/eventos" -H "X-Tenant-Id: $T" -H $J --data-binary "@docs/pruebas/07-evento-invalido.json"
```

✅ **HTTP 400** con `code: "VALIDACION_FALLIDA"` y un arreglo `errors` que lista **cada** campo inválido: `eventId`, `estado`, `fechaEvento` y el campo desconocido.

### Paso 14: fecha en el futuro

```powershell
curl.exe -s -w "`nHTTP %{http_code}`n" -X POST "$B/v1/guias/GUIA-DEMO-002/eventos" -H "X-Tenant-Id: $T" -H $J --data-binary "@docs/pruebas/08-evento-fecha-futura.json"
```

✅ **HTTP 400** con `code: "FECHA_EVENTO_FUTURA"` (tolerancia de 5 minutos).

### Paso 15: falta la cabecera de tenant

```powershell
curl.exe -s -w "`nHTTP %{http_code}`n" "$B/v1/guias/GUIA-DEMO-001"
```

✅ **HTTP 400** con `code: "TENANT_INVALIDO"`.

### Paso 16: un tenant nunca ve guías de otro tenant (RF2, aislamiento)

```powershell
curl.exe -s -w "`nHTTP %{http_code}`n" "$B/v1/guias/GUIA-DEMO-001" -H "X-Tenant-Id: retail-demo"
curl.exe -s "$B/v1/notificaciones" -H "X-Tenant-Id: retail-demo"
curl.exe -s -w "`nHTTP %{http_code}`n" "$B/v1/webhook" -H "X-Tenant-Id: retail-demo"
```

✅ **404** para la guía (igual que si no existiera), `{"items":[]}` para las notificaciones y **404** para el webhook.

### Paso 17: URL de webhook peligrosa (seguridad, SSRF)

```powershell
curl.exe -s -w "`nHTTP %{http_code}`n" -X PUT "$B/v1/webhook" -H "X-Tenant-Id: $T" -H $J --data-binary "@docs/pruebas/10-webhook-ssrf.json"
```

✅ **HTTP 400** con `code: "URL_WEBHOOK_INVALIDA"`.

> En `docker compose` se permiten redes privadas (`WEBHOOK_ALLOW_PRIVATE_NETWORKS=true`) porque el webhook de prueba vive en la red interna de Docker. En producción esa variable es `false`. En ese caso `http://169.254.169.254`, `localhost`, IPs privadas, `metadata.google.internal` y sus variantes IPv6 también se rechazan; está cubierto por pruebas automatizadas (`test/unit/infrastructure/security.spec.ts`).

---

## 4. Resiliencia: reintentos, fallos y timeout (RF4)

### Paso 18: el cliente se cae, 5 intentos con espera creciente y luego FALLIDA

```powershell
curl.exe -s -X POST "$R/_config" -H $J --data-binary "@docs/pruebas/receptor-simular-caida.json"
curl.exe -s -o NUL -w "HTTP %{http_code} en %{time_total}s`n" -X POST "$B/v1/guias/GUIA-DEMO-002/eventos" -H "X-Tenant-Id: $T" -H $J --data-binary "@docs/pruebas/09-evento-guia-con-falla.json"
```

✅ El POST responde **201 en milisegundos**: el envío no bloquea la respuesta.

Espere **unos 30 segundos** y consulte las fallidas:

```powershell
$fallida = (curl.exe -s "$B/v1/notificaciones?estado=FALLIDA" -H "X-Tenant-Id: $T" | ConvertFrom-Json).items[0]
curl.exe -s "$B/v1/notificaciones/$($fallida.id)" -H "X-Tenant-Id: $T"
```

✅ Resultado verificado: `estado: "FALLIDA"`, `intentos: 5`, `ultimoHttpStatus: 503` y `historialIntentos` con 5 entradas. Las esperas entre intentos fueron de ~2 s, 3 s, 5 s y 12 s, **crecientes** (backoff exponencial con jitter). La notificación quedó FALLIDA a los ~24 s.

> Si la lista sale vacía, espere unos segundos más: el jitter hace que el tiempo total varíe entre ~15 y ~30 s.

### Paso 19: reintento manual cuando el cliente se recupera

```powershell
curl.exe -s -X POST "$R/_config" -H $J --data-binary "@docs/pruebas/receptor-normal.json"
curl.exe -s -w "`nHTTP %{http_code}`n" -X POST "$B/v1/notificaciones/$($fallida.id)/reintentar" -H "X-Tenant-Id: $T"
Start-Sleep -Seconds 2
curl.exe -s "$B/v1/notificaciones/$($fallida.id)" -H "X-Tenant-Id: $T"
```

✅ **HTTP 202** (vuelve a la cola) y, segundos después, `estado: "ENVIADA"`.

Ejecute otra vez el `reintentar`: ✅ **HTTP 409** con `NOTIFICACION_NO_REINTENTABLE`, porque solo se reintentan las FALLIDA.

### Paso 20: el cliente no responde en 5 segundos (timeout)

```powershell
curl.exe -s -X POST "$R/_config" -H $J --data-binary "@docs/pruebas/receptor-simular-lentitud.json"
curl.exe -s -o NUL -w "HTTP %{http_code} en %{time_total}s`n" -X POST "$B/v1/guias/GUIA-DEMO-003/eventos" -H "X-Tenant-Id: $T" -H $J --data-binary "@docs/pruebas/11-evento-guia-lenta.json"
Start-Sleep -Seconds 7
curl.exe -s -X POST "$R/_config" -H $J --data-binary "@docs/pruebas/receptor-normal.json"
Start-Sleep -Seconds 15
$lenta = (curl.exe -s "$B/v1/notificaciones" -H "X-Tenant-Id: $T" | ConvertFrom-Json).items | Where-Object eventId -eq "a1b2c3d4-0003-4000-8000-000000000001"
curl.exe -s "$B/v1/notificaciones/$($lenta.id)" -H "X-Tenant-Id: $T"
```

✅ Resultado verificado: los primeros intentos muestran `error: "TIMEOUT"` con `duracionMs ≈ 5002` (se cortan a los 5 s). Cuando el cliente se normaliza, el siguiente intento la deja en `estado: "ENVIADA"`.

---

## 5. Seguridad y observabilidad

### Paso 21: los logs son JSON y no contienen datos personales ni secretos

```powershell
docker compose logs --no-color app | Select-Object -Last 5
(docker compose logs --no-color app | Select-String "Juan|whsec_").Count
```

✅ Después del prefijo `app-1 |` que agrega Docker, cada línea es JSON con `severity` (formato de Google Cloud Logging) y `message`. Las de peticiones HTTP incluyen `req.id` (el mismo `requestId` de las respuestas de error) y las del despachador incluyen `tenantId`, `notificationId`, `attempt` y `outcome`. El conteo es **0**: la observación "Recibido por Juan Pérez…" y los secretos nunca llegan al log.

### Paso 22: el secreto HMAC está cifrado en la base de datos

```powershell
docker compose exec -T db psql -U tracking_notifier -d tracking_notifier -c "SELECT tenant_id, left(secret_ciphertext, 30) AS secreto_cifrado FROM webhook_subscriptions;"
docker compose exec -T db psql -U tracking_notifier -d tracking_notifier -c "SELECT tenant_id, tracking_number, current_status FROM shipments ORDER BY 2;"
docker compose exec -T db psql -U tracking_notifier -d tracking_notifier -c "SELECT status, count(*) FROM notifications GROUP BY 1;"
```

✅ El secreto aparece como `v1.<iv>.<tag>…` (AES-256-GCM), nunca como `whsec_…`. Las guías quedan con sus estados actuales y las notificaciones en `ENVIADA`.

También puede conectarse con un cliente gráfico (DBeaver, pgAdmin, la extensión PostgreSQL de VS Code) usando los datos de la sección 1.

### Paso 23: métricas

```powershell
curl.exe -s "$B/metrics" | Select-String "^webhook_deliveries_total|^tracking_events_total"
```

✅ Contadores coherentes con lo ejecutado: entregas `ENVIADA`, `REINTENTO_PROGRAMADO` y `FALLIDA`, y eventos `creado` y `repetido`.

---

## 6. Pruebas automatizadas

| Qué | Comando | Resultado verificado |
|---|---|---|
| **Todas las pruebas dentro de Docker** (unitarias + arquitectura + integración + E2E contra PostgreSQL real) | `docker compose --profile test run --rm --build tests` | 15 suites, **218 pruebas OK** |
| **Smoke / E2E post-despliegue** contra el stack levantado (12 escenarios, incluido el de reintentos con los tiempos reales) | `npm run test:smoke` *(requiere Node; antes, `npm ci` una vez)* | **SMOKE OK (12 pasos)** |
| Todas las pruebas sin Docker | `npm test` *(requiere `DATABASE_URL_TEST` hacia un PostgreSQL; ver `.env.example`)* | 218 OK |
| Solo unitarias y de arquitectura (sin BD) | `npm run test:unit` | OK |
| Cobertura | `npm run test:cov` | ~95 % global, ~100 % en dominio y aplicación |

El pipeline de GitHub Actions (`.github/workflows/ci.yml`) corre lo mismo en cada push: lint, tipos, auditoría, las 218 pruebas, `docker compose up` y el smoke.

---

## 7. Reiniciar los datos y apagar

```powershell
docker compose down -v      # detiene y BORRA los datos (volumen de la BD)
docker compose up -d --wait # entorno limpio otra vez
```

Para repetir la guía desde cero después de `down -v`, los datos de `docs/pruebas/` sirven tal cual. Sin borrar los datos, los pasos con eventos ya registrados responden 200 (idempotente) o 409 (guía cerrada), que también es el comportamiento correcto.

```powershell
docker compose down         # solo detener, conservando los datos
```

---

## 8. Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| `failed to connect to the docker API … dockerDesktopLinuxEngine` | Docker Desktop no está abierto | Abrirlo y esperar a que muestre "Engine running" |
| `port is already allocated` (8080, 5433 o 9090) | Otro proceso usa el puerto | Cerrarlo, o cambiar el puerto: `$env:APP_PORT=8081; docker compose up -d` (también `DB_PORT` y `RECEIVER_PORT`) |
| `curl: (26) Failed to open/read local data` | La consola no está en la raíz del repositorio | `cd` a la carpeta del proyecto |
| En PowerShell, `curl` muestra algo distinto a curl | En PowerShell 5.1, `curl` es un alias de `Invoke-WebRequest` | Usar `curl.exe` |
| El paso 18 no muestra FALLIDA | El jitter hace variar el tiempo total | Esperar 10 s más y repetir la consulta |
| `signatureValid` vacío en el receptor | Al receptor no se le pasó el secreto | Repetir el paso 4 |
| Respuestas 200 o 409 donde la guía dice 201 | Los datos ya existían de una ejecución anterior | `docker compose down -v` y empezar de nuevo |

---

## 9. Lista de verificación

| # | Requisito del PDF | Pasos | ✔ |
|---|---|---|---|
| RF1 | Registrar evento (eventId, estado, fechaEvento ISO 8601, observación opcional; tenant por `X-Tenant-Id`) | 5, 13, 15 | ☐ |
| RF1 | El mismo eventId no duplica evento ni notificación | 6, 7, 12 | ☐ |
| RF1 | ENTREGADA o DEVUELTA ya no cambian de estado | 9, 10 | ☐ |
| RF2 | Estado actual y eventos en orden cronológico | 11 | ☐ |
| RF2 | Un tenant nunca ve guías de otro tenant | 16 | ☐ |
| RF3 | Guardar la URL del webhook por tenant | 3, 4 | ☐ |
| RF4 | POST al webhook por cada evento aceptado, sin bloquear la respuesta | 5, 7, 8, 18 | ☐ |
| RF4 | Fallo o más de 5 s: reintentos con espera creciente, hasta 5, y luego FALLIDA consultable | 18, 19, 20 | ☐ |
| Técnico | Validación y formato de error único con códigos HTTP coherentes | 10, 12–17 | ☐ |
| Técnico | Logs estructurados JSON sin datos personales | 21 | ☐ |
| Técnico | Secretos por entorno, nada sensible en el repositorio; secreto cifrado | 22 | ☐ |
| Técnico | `docker compose up` levanta servicio, BD y webhook de prueba | 2 | ☐ |
| Técnico | Pruebas unitarias y de integración contra PostgreSQL real con un solo comando | sección 6 | ☐ |
| Opcional | Firma HMAC del cuerpo enviado | 4, 7 | ☐ |
| Opcional | OpenAPI | 2 | ☐ |
| Opcional | Métricas | 23 | ☐ |
| Opcional | CI que corre las pruebas | sección 6 | ☐ |
