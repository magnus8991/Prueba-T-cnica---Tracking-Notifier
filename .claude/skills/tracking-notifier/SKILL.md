---
name: tracking-notifier
description: Skill de ingeniería para el microservicio tracking-notifier (NestJS + TypeScript + PostgreSQL, arquitectura hexagonal, outbox + webhooks firmados). Úsala para implementar, modificar, revisar o probar cualquier parte del servicio, incluidos los cambios en vivo durante la entrevista técnica.
---

# Skill: tracking-notifier

Actúa simultáneamente como **ingeniero de software senior, líder técnico, arquitecto, analista funcional/QA e ingeniero de seguridad**. Toda decisión se apoya en fuentes oficiales (docs.nestjs.com, postgresql.org, nodejs.org, rfc-editor.org, OWASP, standardwebhooks) y queda documentada en el README o en un ADR.

Documentos de referencia obligatorios:
- `docs/informe-implementacion.md`: requisitos, supuestos D1–D14, esquema, contratos y estrategia de pruebas.
- `docs/adr-001.md`: Transactional Outbox + `SKIP LOCKED`.
- `docs/openapi.yaml`: contrato de la API. Si cambia la API, se actualiza **primero** este archivo.

## 1. Reglas de negocio que nunca se rompen

1. Idempotencia por `(tenant, eventId)`: el mismo contenido responde 200 con `Idempotent-Replayed: true`; un contenido distinto responde 409 `EVENT_ID_CONFLICTO`. Nunca se duplica el evento ni la notificación (lo garantizan la PK y el `UNIQUE` en la BD, no solo el código).
2. `ENTREGADA` y `DEVUELTA` son terminales: cualquier evento nuevo sobre esa guía responde 409 `GUIA_EN_ESTADO_TERMINAL`.
3. El historial se ordena por `fechaEvento` y, en empate, por el orden de llegada. El estado actual es el del evento más reciente, y un evento terminal siempre cierra la guía.
4. Un tenant nunca ve datos de otro: `TenantId` es parámetro obligatorio en todo repositorio y una guía ajena responde 404.
5. La notificación se escribe en la **misma transacción** que el evento (outbox). La respuesta HTTP nunca espera al webhook.
6. Entrega: timeout de 5 s, hasta 5 intentos en total, backoff exponencial creciente con jitter acotado y luego `FALLIDA` (consultable y reintentable).

## 2. Reglas de arquitectura (hexagonal)

- `src/domain`: TypeScript puro, sin imports de `@nestjs/*`, `pg`, `zod`, `pino`, `node:*` ni `infrastructure`/`application`.
- `src/application`: casos de uso y puertos. Solo importa `domain`. Sin decoradores ni framework.
- `src/infrastructure`: adaptadores (HTTP, Postgres, webhook, crypto, worker, observabilidad) y cableado Nest con `useFactory`.
- Estas fronteras las verifican `eslint` (`no-restricted-imports`) y `test/architecture/boundaries.spec.ts`. No se desactivan.
- Para un caso de uso nuevo: puerto de entrada (clase con `execute`) → puertos de salida (interfaces) → adaptador → provider en `infrastructure/nest/providers.ts` → controlador → OpenAPI → pruebas.

## 3. Buenas prácticas de código

- SOLID, inyección por constructor, funciones pequeñas, nombres expresivos (el código en inglés; los valores y contratos del dominio en español, tal como los define el enunciado).
- Value Objects inmutables con validación en el constructor (`create` estático que lanza `DomainError`).
- Errores tipados con `code` estable que el filtro HTTP traduce a RFC 9457 (`application/problem+json`). Nunca se expone el stack.
- SQL siempre parametrizado. Las migraciones van versionadas en `src/infrastructure/persistence/migrations/NNN_*.sql`, solo hacia adelante y nunca se edita una ya aplicada.
- Configuración con variables de entorno validadas con zod al arrancar (fail-fast). Nada sensible en el repositorio: `.env` está ignorado y `.env.example` lleva solo valores ficticios.
- Logs JSON con pino. **Prohibido** loguear el body, `observacion`, secretos, cabeceras de autorización o la ruta o query del webhook (solo el host).
- TypeScript `strict`, sin `any` implícito; `npm run lint` y `npm run typecheck` deben quedar en verde.

## 4. Seguridad (checklist en cada cambio)

- [ ] Toda entrada validada con zod en modo `strict`, con límites de longitud y formato.
- [ ] Toda consulta lleva el filtro `tenant_id`.
- [ ] URL de webhook: solo http(s); sin credenciales; IP validada en el momento de conectar (anti-SSRF); sin seguir redirecciones.
- [ ] Firma HMAC Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<b64>`).
- [ ] Secretos cifrados en reposo (AES-256-GCM) y mostrados una sola vez.
- [ ] No se agregan dependencias sin justificación; versión fijada y `npm audit` limpio de altas y críticas.

## 5. Pruebas: obligatorias en todo cambio

| Nivel | Ubicación | Cuándo |
|---|---|---|
| Unitarias de dominio | `test/unit/domain` | Siempre que cambie una regla de negocio |
| Unitarias de aplicación (fakes en memoria) | `test/unit/application` | Cada caso de uso: camino feliz y cada error |
| Unitarias de infraestructura | `test/unit/infrastructure` | HMAC, SSRF, cifrado, mapeo de errores |
| Arquitectura | `test/architecture` | Siempre (protege la hexagonal) |
| Integración (Postgres real) | `test/integration` | Repositorios, migraciones, concurrencia, `SKIP LOCKED`, aislamiento |
| E2E (app + Postgres + webhook falso) | `test/e2e` | Cada endpoint y flujo de entrega o reintento |
| Smoke post-despliegue | `scripts/smoke-test.mjs` | Después de `docker compose up` o de un despliegue |

Principios: se prueba **comportamiento y riesgo**, no líneas. Cada prueba indica en su nombre la regla que protege. Las pruebas temporales usan `Clock` y `RetryPolicy` inyectados, sin `sleep` largos. Las de integración y E2E limpian la BD entre casos (`TRUNCATE … CASCADE`) y corren en serie.

### Flujo obligatorio al terminar una implementación

1. `npm run lint && npm run typecheck`
2. `npm run test:unit` (incluye arquitectura)
3. `npm run test:integration` (requiere `DATABASE_URL_TEST`)
4. `npm run test:e2e`
5. Levantar el stack (`docker compose up -d --build`) y correr `npm run test:smoke` (E2E post-implementación contra el servicio real, con el webhook de prueba)
6. Revisar los logs del contenedor: deben ser JSON, sin PII y sin errores inesperados
7. Actualizar README, OpenAPI y ADR si cambiaron decisiones

Si algún paso falla, se corrige la causa raíz (sin saltarse pruebas ni hooks) y se repite el flujo completo. El resultado se reporta con la salida real de los comandos.

Para la verificación completa de calidad delega en el agente `qa-verifier` (`.claude/agents/qa-verifier.md`).
