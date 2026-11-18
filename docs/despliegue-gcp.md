# Despliegue de referencia en Google Cloud Platform

El stack de Domina se apoya en servicios desplegados en GCP. El microservicio está preparado para correr ahí sin cambios de código:

| Necesidad | Servicio GCP | Cómo lo soporta el código |
|---|---|---|
| Cómputo *serverless* de contenedores | **Cloud Run** | Escucha en `PORT` (8080 por defecto), es *stateless*, hace apagado ordenado con SIGTERM (`enableShutdownHooks`) y expone *health checks* `/health/live` y `/health/ready` |
| Base de datos | **Cloud SQL for PostgreSQL 18** | `DATABASE_URL` admite socket Unix (`?host=/cloudsql/PROYECTO:REGION:INSTANCIA`) o IP privada con `DATABASE_SSL=true` |
| Secretos | **Secret Manager** | `DATABASE_URL` y `WEBHOOK_SECRET_ENCRYPTION_KEY` se montan como variables de entorno (`--set-secrets`); no hay nada sensible en la imagen ni en el repositorio |
| Imágenes | **Artifact Registry** | `Dockerfile` multi-stage, usuario no root |
| Logs | **Cloud Logging** | JSON a stdout con `severity`, `message` y `logging.googleapis.com/trace` (correlación con Cloud Trace usando `X-Cloud-Trace-Context`/`traceparent` cuando se define `GOOGLE_CLOUD_PROJECT`) |
| Métricas | **Managed Service for Prometheus** | `/metrics` en formato Prometheus |
| Exposición | **API Gateway / Apigee / Load Balancer** | El gateway autentica al cliente e inyecta `X-Tenant-Id`; Cloud Run con `--ingress internal-and-cloud-load-balancing` |
| Salida a internet controlada | **Serverless VPC Access + Cloud NAT** | IP de salida fija para que los clientes la pongan en su allowlist; el guard SSRF bloquea igual las redes internas y metadata (`169.254.169.254`, `metadata.google.internal`) |

## Topología recomendada (misma imagen, dos roles)

```
                ┌──────────────────────────┐
 API Gateway ─▶ │ Cloud Run: tn-api        │  APP_ROLE=api      (autoescala por tráfico, CPU por request)
                └────────────┬─────────────┘
                             │  Cloud SQL (PostgreSQL 18) ── outbox: notifications
                ┌────────────┴─────────────┐
                │ Cloud Run: tn-worker     │  APP_ROLE=worker   (--no-cpu-throttling, min-instances=1)
                └────────────┬─────────────┘
                             ▼
                  Webhooks de clientes (https)
 Cloud Run Job: tn-migrate  →  node dist/infrastructure/persistence/migrate.js  (antes de cada despliegue)
```

¿Por qué separar los roles? En Cloud Run, con facturación por request, la CPU se limita fuera de las peticiones, y un bucle de *polling* en segundo plano no avanza. El worker necesita CPU siempre asignada. La API escala con el tráfico y el worker escala aparte; `SKIP LOCKED` hace seguro tener varias instancias del worker a la vez.

## Comandos de referencia

```bash
PROJECT=mi-proyecto; REGION=us-central1; REPO=servicios; IMG=$REGION-docker.pkg.dev/$PROJECT/$REPO/tracking-notifier:$(git rev-parse --short HEAD)

# 1. Imagen
gcloud builds submit --tag "$IMG"

# 2. Secretos (una vez)
openssl rand -base64 32 | gcloud secrets create tn-webhook-key --data-file=-
printf 'postgresql://tn_app:***@/tracking_notifier?host=/cloudsql/%s:%s:tn-db' "$PROJECT" "$REGION" \
  | gcloud secrets create tn-database-url --data-file=-

COMMON=(--image "$IMG" --region "$REGION" --service-account tn-runtime@$PROJECT.iam.gserviceaccount.com
  --add-cloudsql-instances "$PROJECT:$REGION:tn-db"
  --set-secrets DATABASE_URL=tn-database-url:latest,WEBHOOK_SECRET_ENCRYPTION_KEY=tn-webhook-key:latest
  --set-env-vars GOOGLE_CLOUD_PROJECT=$PROJECT,WEBHOOK_REQUIRE_HTTPS=true,WEBHOOK_ALLOW_PRIVATE_NETWORKS=false)

# 3. Migraciones como Cloud Run Job
gcloud run jobs deploy tn-migrate "${COMMON[@]}" --command node --args dist/infrastructure/persistence/migrate.js
gcloud run jobs execute tn-migrate --region "$REGION" --wait

# 4. API y worker
gcloud run deploy tn-api    "${COMMON[@]}" --set-env-vars APP_ROLE=api    --ingress internal-and-cloud-load-balancing --no-allow-unauthenticated
gcloud run deploy tn-worker "${COMMON[@]}" --set-env-vars APP_ROLE=worker --no-cpu-throttling --min-instances 1 --ingress internal --no-allow-unauthenticated
```

La cuenta de servicio `tn-runtime` necesita solo `roles/cloudsql.client` y `roles/secretmanager.secretAccessor` sobre los dos secretos (mínimo privilegio). En CI/CD se recomienda **Workload Identity Federation** de GitHub hacia GCP (`google-github-actions/auth@v3`) en lugar de llaves JSON.

## Frontend React (referencia)

La API es un contrato OpenAPI 3.1 (`/docs/openapi.json`), así que un panel React para los clientes (historial de guías, estado de notificaciones, reintentos) puede generar un cliente tipado (por ejemplo con `openapi-typescript`). El servicio permite habilitar CORS para su origen con `CORS_ORIGINS`. En producción el panel consumiría la API a través del mismo API Gateway, que inyecta `X-Tenant-Id` a partir de la sesión del usuario.
