import { DomainError } from '../shared/domain-error';

export const SHIPMENT_STATUSES = ['CREADA', 'EN_RUTA', 'ENTREGADA', 'DEVUELTA'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

const TERMINAL_STATUSES: ReadonlySet<ShipmentStatus> = new Set(['ENTREGADA', 'DEVUELTA']);

export function isTerminalStatus(status: ShipmentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function parseShipmentStatus(raw: string): ShipmentStatus {
  if (!(SHIPMENT_STATUSES as readonly string[]).includes(raw)) {
    throw new DomainError('ESTADO_INVALIDO', `estado debe ser uno de: ${SHIPMENT_STATUSES.join(', ')}`);
  }
  return raw as ShipmentStatus;
}
