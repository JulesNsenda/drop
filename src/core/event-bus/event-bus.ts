/**
 * Event Bus Implementation
 *
 * Provides a typed publish/subscribe system for loose coupling between
 * DROP components. Uses Node.js EventEmitter as the underlying mechanism.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import {
  EventType,
  EventPayload,
  EventHandler,
  GlobalEventHandler,
  Unsubscribe,
  DropEvent,
  EventHistoryOptions,
  BaseEvent,
} from './event-bus.types';

const DEFAULT_HISTORY_LIMIT = 1000;

export class EventBus {
  private readonly emitter: EventEmitter;
  private readonly history: DropEvent[] = [];
  private readonly historyLimit: number;
  private readonly globalHandlers: Set<GlobalEventHandler> = new Set();

  constructor(historyLimit: number = DEFAULT_HISTORY_LIMIT) {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100); // Allow many subscribers
    this.historyLimit = historyLimit;
  }

  /**
   * Publish an event to all subscribers
   */
  publish<T extends EventType>(
    eventType: T,
    payload: Omit<EventPayload<T>, 'timestamp'> & Partial<Pick<BaseEvent, 'timestamp'>>
  ): void {
    const timestamp = payload.timestamp ?? new Date();
    const fullPayload = { ...payload, timestamp } as EventPayload<T>;

    const event: DropEvent<T> = {
      id: randomUUID(),
      type: eventType,
      payload: fullPayload,
      timestamp,
    };

    // Add to history
    this.addToHistory(event);

    // Emit to specific event subscribers
    this.emitter.emit(eventType, fullPayload);

    // Emit to global handlers
    this.globalHandlers.forEach(handler => {
      try {
        handler(event);
      } catch (error) {
        console.error(`Error in global event handler for ${eventType}:`, error);
      }
    });

    // Debug logging in development
    if (process.env.DROP_LOG_LEVEL === 'debug') {
      console.debug(`[EventBus] ${eventType}`, JSON.stringify(fullPayload, null, 2));
    }
  }

  /**
   * Subscribe to a specific event type
   */
  subscribe<T extends EventType>(eventType: T, handler: EventHandler<T>): Unsubscribe {
    const wrappedHandler = async (payload: EventPayload<T>) => {
      try {
        await handler(payload);
      } catch (error) {
        console.error(`Error in event handler for ${eventType}:`, error);
      }
    };

    this.emitter.on(eventType, wrappedHandler);

    return () => {
      this.emitter.off(eventType, wrappedHandler);
    };
  }

  /**
   * Subscribe to an event type for a single occurrence
   */
  subscribeOnce<T extends EventType>(eventType: T, handler: EventHandler<T>): Unsubscribe {
    const wrappedHandler = async (payload: EventPayload<T>) => {
      try {
        await handler(payload);
      } catch (error) {
        console.error(`Error in event handler for ${eventType}:`, error);
      }
    };

    this.emitter.once(eventType, wrappedHandler);

    return () => {
      this.emitter.off(eventType, wrappedHandler);
    };
  }

  /**
   * Subscribe to all events
   */
  subscribeAll(handler: GlobalEventHandler): Unsubscribe {
    this.globalHandlers.add(handler);

    return () => {
      this.globalHandlers.delete(handler);
    };
  }

  /**
   * Get event history with optional filtering
   */
  getHistory(options: EventHistoryOptions = {}): DropEvent[] {
    let events = [...this.history];

    // Filter by event type
    if (options.eventType) {
      events = events.filter(e => e.type === options.eventType);
    }

    // Filter by timestamp
    if (options.since) {
      events = events.filter(e => e.timestamp >= options.since!);
    }

    // Filter by appId (check payload)
    if (options.appId) {
      events = events.filter(e => {
        const payload = e.payload as unknown as Record<string, unknown>;
        return payload.appId === options.appId;
      });
    }

    // Apply limit
    const limit = options.limit ?? this.historyLimit;
    return events.slice(-limit);
  }

  /**
   * Clear event history
   */
  clearHistory(): void {
    this.history.length = 0;
  }

  /**
   * Get the count of subscribers for an event type
   */
  getSubscriberCount(eventType: EventType): number {
    return this.emitter.listenerCount(eventType);
  }

  /**
   * Remove all subscribers for an event type
   */
  removeAllSubscribers(eventType?: EventType): void {
    if (eventType) {
      this.emitter.removeAllListeners(eventType);
    } else {
      this.emitter.removeAllListeners();
      this.globalHandlers.clear();
    }
  }

  private addToHistory(event: DropEvent): void {
    this.history.push(event);

    // Trim history if over limit
    if (this.history.length > this.historyLimit) {
      this.history.shift();
    }
  }
}

// Singleton instance for the application
export const eventBus = new EventBus();
