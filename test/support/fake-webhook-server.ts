import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import { AddressInfo } from 'node:net';

export interface ReceivedWebhook {
  headers: IncomingHttpHeaders;
  body: string;
  receivedAt: number;
}

export type Responder = (request: ReceivedWebhook, index: number) => { status: number; delayMs?: number; headers?: Record<string, string> };

/** Servidor webhook falso para pruebas: registra lo recibido y responde según un guion. */
export class FakeWebhookServer {
  readonly received: ReceivedWebhook[] = [];
  private server: Server | null = null;
  responder: Responder = () => ({ status: 200 });

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const request = { headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), receivedAt: Date.now() };
        this.received.push(request);
        const { status, delayMs = 0, headers = {} } = this.responder(request, this.received.length - 1);
        setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(status, headers).end('ok');
        }, delayMs);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/hook`;
  }

  async waitFor(count: number, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.received.length < count) {
      if (Date.now() > deadline) throw new Error(`Se esperaban ${count} webhooks, llegaron ${this.received.length}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}
