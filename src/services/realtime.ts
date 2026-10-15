import type { Response } from 'express';
import { logger } from '../lib/logger.js';

type Client = { id: string; userId: string; res: Response };

const clients = new Map<string, Client>();

export type RealtimeEvent =
  | { type: 'notification'; payload: unknown }
  | { type: 'unread'; payload: { count: number } }
  | { type: 'invalidate'; payload: { keys: string[] } };

export const addClient = (id: string, userId: string, res: Response) => {
  clients.set(id, { id, userId, res });
  logger.debug({ userId, clients: clients.size }, 'SSE client connected');
};

export const removeClient = (id: string) => {
  clients.delete(id);
};

const write = (client: Client, event: RealtimeEvent) => {
  try {
    client.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
  } catch {
    clients.delete(client.id);
  }
};

/** Pushes an event to every open tab belonging to one user. */
export const pushToUser = (userId: string, event: RealtimeEvent) => {
  for (const client of clients.values()) if (client.userId === userId) write(client, event);
};

export const pushToUsers = (userIds: string[], event: RealtimeEvent) => {
  const set = new Set(userIds);
  for (const client of clients.values()) if (set.has(client.userId)) write(client, event);
};

export const heartbeat = () => {
  for (const client of clients.values()) {
    try {
      client.res.write(': ping\n\n');
    } catch {
      clients.delete(client.id);
    }
  }
};

export const connectedUserCount = () => new Set([...clients.values()].map((c) => c.userId)).size;
