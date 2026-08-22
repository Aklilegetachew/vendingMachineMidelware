import { Response } from 'express';

interface SSEClient {
  id: string;
  res: Response;
}

class EventBroadcaster {
  private clients: SSEClient[] = [];

  public addClient(id: string, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    this.clients.push({ id, res });

    // Send initial connected event
    res.write(`data: ${JSON.stringify({ type: 'CONNECTED', message: 'SSE Stream Connected' })}\n\n`);

    res.on('close', () => {
      this.removeClient(id);
    });
  }

  public removeClient(id: string): void {
    this.clients = this.clients.filter((c) => c.id !== id);
  }

  public broadcast(type: string, payload: any): void {
    const data = JSON.stringify({ type, timestamp: new Date().toISOString(), payload });
    this.clients.forEach((client) => {
      client.res.write(`data: ${data}\n\n`);
    });
  }
}

export const eventBroadcaster = new EventBroadcaster();
