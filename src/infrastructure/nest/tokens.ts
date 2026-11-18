/** Tokens de inyección para dependencias que no son clases (o son interfaces/puertos). */
export const APP_CONFIG = Symbol('APP_CONFIG');
export const PG_POOL = Symbol('PG_POOL');
export const ROOT_LOGGER = Symbol('ROOT_LOGGER');
export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');
export const SHIPMENT_REPOSITORY = Symbol('SHIPMENT_REPOSITORY');
export const EVENT_REPOSITORY = Symbol('EVENT_REPOSITORY');
export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');
export const SUBSCRIPTION_REPOSITORY = Symbol('SUBSCRIPTION_REPOSITORY');
export const WEBHOOK_SENDER = Symbol('WEBHOOK_SENDER');
export const DESTINATION_POLICY = Symbol('DESTINATION_POLICY');
export const CLOCK = Symbol('CLOCK');
export const APP_LOGGER = Symbol('APP_LOGGER');
export const RETRY_POLICY = Symbol('RETRY_POLICY');
