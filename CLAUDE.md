# tracking-notifier: contexto para asistentes IA

Microservicio multi-tenant (NestJS 12 + TypeScript 6 + PostgreSQL 18) que registra los eventos de estado de las guías de envío y notifica a los webhooks de los clientes mediante un Transactional Outbox.

- Antes de cualquier cambio, carga la skill `.claude/skills/tracking-notifier/SKILL.md`. Contiene las reglas de negocio, de arquitectura, de seguridad y el flujo de pruebas obligatorio.
- Al terminar, verifica con el agente `.claude/agents/qa-verifier.md`: unitarias, integración, E2E y smoke post-despliegue.
- El diseño completo está en `docs/informe-implementacion.md` y la decisión principal en `docs/adr-001.md`.

Comandos:

| Acción | Comando |
|---|---|
| Instalar | `npm ci` |
| Lint y tipos | `npm run lint && npm run typecheck` |
| Pruebas (todas, un solo comando) | `npm test` (requiere `DATABASE_URL_TEST`) |
| Solo unitarias | `npm run test:unit` |
| Levantar el stack | `docker compose up --build` |
| Smoke post-despliegue | `npm run test:smoke` |
| Migraciones | `npm run migrate` |
