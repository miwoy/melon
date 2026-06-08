import type { WebSocket } from "@fastify/websocket";
import type { AppEvent } from "../types.js";

export class EventHub {
  private readonly clients = new Set<WebSocket>();

  add(client: WebSocket) {
    this.clients.add(client);
    client.on("close", () => this.clients.delete(client));
  }

  broadcast(event: AppEvent) {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
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
}
