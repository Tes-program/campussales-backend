import { Injectable, OnModuleDestroy } from '@nestjs/common';

export const PRESENCE_GRACE_MS = 5_000;
export const TYPING_TTL_MS = 5_000;

/**
 * In-memory presence and typing state for this instance (C1). Nothing is
 * stored in the database:
 *  - online: the user has at least one /chat socket here. When the last one
 *    closes we wait 5 s before calling them offline, so a reconnect (network
 *    blip, page reload) doesn't flash "offline".
 *  - typing: expires 5 s after the last `typing` event.
 * With several instances, each one knows its own sockets; the gateway falls
 * back to the Redis adapter (fetchSockets) where an exact answer matters.
 */
@Injectable()
export class ChatPresence implements OnModuleDestroy {
  private sockets = new Map<string, Set<string>>();
  private offlineTimers = new Map<string, NodeJS.Timeout>();
  private typing = new Map<string, NodeJS.Timeout>();
  /** Last disconnect per user, to count reconnects. */
  private lastSeen = new Map<string, number>();

  /** Returns true when the user just came online (was fully offline). */
  connect(userId: string, socketId: string): boolean {
    const pending = this.offlineTimers.get(userId);
    if (pending) {
      clearTimeout(pending);
      this.offlineTimers.delete(userId);
    }
    const set = this.sockets.get(userId) ?? new Set<string>();
    const wasOnline = set.size > 0 || !!pending;
    set.add(socketId);
    this.sockets.set(userId, set);
    return !wasOnline;
  }

  /** True when this user disconnected less than a minute ago (a reconnect). */
  isReconnect(userId: string, now = Date.now()): boolean {
    const t = this.lastSeen.get(userId);
    return t !== undefined && now - t < 60_000;
  }

  /** Calls onOffline after the grace period if no socket came back. */
  disconnect(userId: string, socketId: string, onOffline: () => void): void {
    const set = this.sockets.get(userId);
    if (!set) return;
    set.delete(socketId);
    this.lastSeen.set(userId, Date.now());
    if (this.lastSeen.size > 50_000) this.lastSeen.clear();
    if (set.size > 0) return;
    this.sockets.delete(userId);
    const timer = setTimeout(() => {
      this.offlineTimers.delete(userId);
      if (!this.sockets.has(userId)) onOffline();
    }, PRESENCE_GRACE_MS);
    timer.unref();
    this.offlineTimers.set(userId, timer);
  }

  isOnline(userId: string): boolean {
    return this.sockets.has(userId) || this.offlineTimers.has(userId);
  }

  /** Starts or refreshes a typing indicator; onExpire fires after 5 s of silence. */
  startTyping(key: string, onExpire: () => void): void {
    this.stopTyping(key);
    const t = setTimeout(() => {
      this.typing.delete(key);
      onExpire();
    }, TYPING_TTL_MS);
    t.unref();
    this.typing.set(key, t);
  }

  /** Returns true if the key was typing. */
  stopTyping(key: string): boolean {
    const t = this.typing.get(key);
    if (!t) return false;
    clearTimeout(t);
    this.typing.delete(key);
    return true;
  }

  /** Typing keys (`conversationId:userId`) for one user, e.g. on disconnect. */
  typingKeysFor(userId: string): string[] {
    return [...this.typing.keys()].filter((k) => k.endsWith(`:${userId}`));
  }

  onModuleDestroy() {
    for (const t of this.offlineTimers.values()) clearTimeout(t);
    for (const t of this.typing.values()) clearTimeout(t);
    this.offlineTimers.clear();
    this.typing.clear();
    this.sockets.clear();
  }
}
