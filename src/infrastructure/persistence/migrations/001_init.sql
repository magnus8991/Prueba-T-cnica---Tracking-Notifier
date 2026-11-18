-- 001_init: esquema inicial de tracking-notifier.
-- Todas las llaves incluyen tenant_id: el aislamiento por cliente se refuerza en la BD.

CREATE TABLE webhook_subscriptions (
  tenant_id          text        PRIMARY KEY,
  url                text        NOT NULL,
  secret_ciphertext  text        NOT NULL,              -- AES-256-GCM, nunca en claro
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipments (
  tenant_id          text        NOT NULL,
  tracking_number    text        NOT NULL,
  current_status     text        NOT NULL CHECK (current_status IN ('CREADA', 'EN_RUTA', 'ENTREGADA', 'DEVUELTA')),
  current_status_at  timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, tracking_number)
);

CREATE TABLE tracking_events (
  tenant_id          text        NOT NULL,
  event_id           uuid        NOT NULL,
  tracking_number    text        NOT NULL,
  status             text        NOT NULL CHECK (status IN ('CREADA', 'EN_RUTA', 'ENTREGADA', 'DEVUELTA')),
  occurred_at        timestamptz NOT NULL,
  observation        text        NULL CHECK (char_length(observation) <= 500),
  received_seq       bigint      GENERATED ALWAYS AS IDENTITY,
  received_at        timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, event_id),                      -- idempotencia garantizada por la BD
  FOREIGN KEY (tenant_id, tracking_number) REFERENCES shipments (tenant_id, tracking_number)
);
CREATE INDEX ix_tracking_events_history ON tracking_events (tenant_id, tracking_number, occurred_at, received_seq);

CREATE TABLE notifications (
  id                 uuid        PRIMARY KEY,
  tenant_id          text        NOT NULL,
  event_id           uuid        NOT NULL,
  status             text        NOT NULL CHECK (status IN ('PENDIENTE', 'ENVIANDO', 'ENVIADA', 'FALLIDA')),
  attempts           integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts       integer     NOT NULL CHECK (max_attempts > 0),
  next_attempt_at    timestamptz NOT NULL,
  locked_until       timestamptz NULL,
  last_error         text        NULL,
  last_http_status   integer     NULL,
  delivered_at       timestamptz NULL,
  failed_at          timestamptz NULL,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  CONSTRAINT uq_notifications_event UNIQUE (tenant_id, event_id),   -- una notificación por evento
  FOREIGN KEY (tenant_id, event_id) REFERENCES tracking_events (tenant_id, event_id)
);
-- Índice parcial: el worker solo escanea trabajo pendiente o en curso.
CREATE INDEX ix_notifications_due ON notifications (next_attempt_at) WHERE status IN ('PENDIENTE', 'ENVIANDO');
CREATE INDEX ix_notifications_tenant ON notifications (tenant_id, status, created_at DESC);

CREATE TABLE notification_attempts (
  id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_id    uuid        NOT NULL REFERENCES notifications (id),
  attempt_number     integer     NOT NULL,
  attempted_at       timestamptz NOT NULL,
  duration_ms        integer     NOT NULL,
  http_status        integer     NULL,
  error_code         text        NULL
);
CREATE INDEX ix_notification_attempts_notification ON notification_attempts (notification_id, id);
