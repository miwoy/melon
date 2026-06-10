import type { WebSocket } from "@fastify/websocket";
import type { AppEvent } from "../types.js";

export class EventHub {
  private readonly clients = new Map<WebSocket, { accountId?: string }>();

  add(client: WebSocket, options: { accountId?: string } = {}) {
    this.clients.set(client, options);
    client.on("close", () => this.clients.delete(client));
  }

  broadcast(event: AppEvent) {
    const payload = JSON.stringify(event);
    for (const client of this.clients.keys()) {
      if (client.readyState !== 1) {
        this.clients.delete(client);
        continue;
      }
      try {
        client.send(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  broadcastAccount(accountId: string, event: AppEvent) {
    const payload = JSON.stringify(event);
    for (const [client, options] of this.clients) {
      if (client.readyState !== 1) {
        this.clients.delete(client);
        continue;
      }
      if (options.accountId !== accountId) continue;
      try {
        client.send(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  subscribedAccountIds() {
    return [...new Set([...this.clients.values()].map((client) => client.accountId).filter((accountId): accountId is string => Boolean(accountId)))];
  }
}
