/**
 * Event Bus Tests
 */

import { EventBus } from './event-bus';
import { DropEvent, EventPayload } from './event-bus.types';

describe('EventBus', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus(100);
  });

  afterEach(() => {
    eventBus.removeAllSubscribers();
    eventBus.clearHistory();
  });

  describe('publish and subscribe', () => {
    it('should call handler when event is published', done => {
      eventBus.subscribe('app:started', payload => {
        expect(payload.appId).toBe('test-app-id');
        expect(payload.name).toBe('my-app');
        expect(payload.port).toBe(3000);
        expect(payload.timestamp).toBeInstanceOf(Date);
        done();
      });

      eventBus.publish('app:started', {
        appId: 'test-app-id',
        name: 'my-app',
        port: 3000,
      });
    });

    it('should support multiple subscribers for the same event', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();

      eventBus.subscribe('app:stopped', handler1);
      eventBus.subscribe('app:stopped', handler2);

      eventBus.publish('app:stopped', {
        appId: 'test-id',
        name: 'test-app',
      });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should not call handler for different event types', () => {
      const handler = jest.fn();

      eventBus.subscribe('app:started', handler);
      eventBus.publish('app:stopped', {
        appId: 'test-id',
        name: 'test-app',
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should add timestamp automatically if not provided', done => {
      const before = new Date();

      eventBus.subscribe('platform:started', payload => {
        const after = new Date();
        expect(payload.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(payload.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
        done();
      });

      eventBus.publish('platform:started', {});
    });
  });

  describe('unsubscribe', () => {
    it('should stop receiving events after unsubscribe', () => {
      const handler = jest.fn();

      const unsubscribe = eventBus.subscribe('app:error', handler);

      eventBus.publish('app:error', {
        appId: 'test-id',
        name: 'test-app',
        error: new Error('Test error'),
      });

      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      eventBus.publish('app:error', {
        appId: 'test-id',
        name: 'test-app',
        error: new Error('Another error'),
      });

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribeOnce', () => {
    it('should only receive the first event', () => {
      const handler = jest.fn();

      eventBus.subscribeOnce('build:completed', handler);

      eventBus.publish('build:completed', {
        appId: 'test-id',
        buildId: 'build-1',
        durationMs: 1000,
      });

      eventBus.publish('build:completed', {
        appId: 'test-id',
        buildId: 'build-2',
        durationMs: 2000,
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ buildId: 'build-1' })
      );
    });
  });

  describe('subscribeAll', () => {
    it('should receive all events', () => {
      const handler = jest.fn();

      eventBus.subscribeAll(handler);

      eventBus.publish('app:started', {
        appId: 'test-id',
        name: 'app-1',
        port: 3000,
      });

      eventBus.publish('build:completed', {
        appId: 'test-id',
        buildId: 'build-1',
        durationMs: 1000,
      });

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should receive full event object with id and type', done => {
      eventBus.subscribeAll((event: DropEvent) => {
        expect(event.id).toBeDefined();
        expect(event.type).toBe('platform:starting');
        expect(event.payload).toBeDefined();
        expect(event.timestamp).toBeInstanceOf(Date);
        done();
      });

      eventBus.publish('platform:starting', {
        config: { test: true },
      });
    });

    it('should stop receiving events after unsubscribe', () => {
      const handler = jest.fn();

      const unsubscribe = eventBus.subscribeAll(handler);

      eventBus.publish('app:detected', {
        name: 'app-1',
        path: '/apps/app-1',
      });

      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      eventBus.publish('app:detected', {
        name: 'app-2',
        path: '/apps/app-2',
      });

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('event history', () => {
    it('should store events in history', () => {
      eventBus.publish('app:created', {
        appId: 'app-1',
        name: 'my-app',
        type: 'nodejs',
      });

      eventBus.publish('app:started', {
        appId: 'app-1',
        name: 'my-app',
        port: 3000,
      });

      const history = eventBus.getHistory();

      expect(history).toHaveLength(2);
      expect(history[0].type).toBe('app:created');
      expect(history[1].type).toBe('app:started');
    });

    it('should respect history limit', () => {
      const smallBus = new EventBus(5);

      for (let i = 0; i < 10; i++) {
        smallBus.publish('app:detected', {
          name: `app-${i}`,
          path: `/apps/app-${i}`,
        });
      }

      const history = smallBus.getHistory();
      expect(history).toHaveLength(5);

      const firstEvent = history[0].payload as EventPayload<'app:detected'>;
      expect(firstEvent.name).toBe('app-5');
    });

    it('should filter history by event type', () => {
      eventBus.publish('app:created', {
        appId: 'app-1',
        name: 'my-app',
        type: 'nodejs',
      });

      eventBus.publish('build:started', {
        appId: 'app-1',
        buildId: 'build-1',
      });

      eventBus.publish('app:started', {
        appId: 'app-1',
        name: 'my-app',
        port: 3000,
      });

      const history = eventBus.getHistory({ eventType: 'app:created' });

      expect(history).toHaveLength(1);
      expect(history[0].type).toBe('app:created');
    });

    it('should filter history by appId', () => {
      eventBus.publish('app:started', {
        appId: 'app-1',
        name: 'my-app-1',
        port: 3000,
      });

      eventBus.publish('app:started', {
        appId: 'app-2',
        name: 'my-app-2',
        port: 3001,
      });

      const history = eventBus.getHistory({ appId: 'app-1' });

      expect(history).toHaveLength(1);
      const payload = history[0].payload as EventPayload<'app:started'>;
      expect(payload.appId).toBe('app-1');
    });

    it('should filter history by timestamp', () => {
      eventBus.publish('app:created', {
        appId: 'app-1',
        name: 'old-app',
        type: 'nodejs',
        timestamp: new Date('2024-01-01'),
      });

      const since = new Date();

      eventBus.publish('app:created', {
        appId: 'app-2',
        name: 'new-app',
        type: 'nodejs',
      });

      const history = eventBus.getHistory({ since });

      expect(history).toHaveLength(1);
      const payload = history[0].payload as EventPayload<'app:created'>;
      expect(payload.name).toBe('new-app');
    });

    it('should clear history', () => {
      eventBus.publish('app:detected', {
        name: 'app-1',
        path: '/apps/app-1',
      });

      expect(eventBus.getHistory()).toHaveLength(1);

      eventBus.clearHistory();

      expect(eventBus.getHistory()).toHaveLength(0);
    });
  });

  describe('subscriber management', () => {
    it('should return subscriber count', () => {
      expect(eventBus.getSubscriberCount('app:started')).toBe(0);

      const unsub1 = eventBus.subscribe('app:started', () => {});
      expect(eventBus.getSubscriberCount('app:started')).toBe(1);

      const unsub2 = eventBus.subscribe('app:started', () => {});
      expect(eventBus.getSubscriberCount('app:started')).toBe(2);

      unsub1();
      expect(eventBus.getSubscriberCount('app:started')).toBe(1);

      unsub2();
      expect(eventBus.getSubscriberCount('app:started')).toBe(0);
    });

    it('should remove all subscribers for specific event', () => {
      eventBus.subscribe('app:started', () => {});
      eventBus.subscribe('app:started', () => {});
      eventBus.subscribe('app:stopped', () => {});

      eventBus.removeAllSubscribers('app:started');

      expect(eventBus.getSubscriberCount('app:started')).toBe(0);
      expect(eventBus.getSubscriberCount('app:stopped')).toBe(1);
    });

    it('should remove all subscribers', () => {
      eventBus.subscribe('app:started', () => {});
      eventBus.subscribe('app:stopped', () => {});
      eventBus.subscribeAll(() => {});

      eventBus.removeAllSubscribers();

      expect(eventBus.getSubscriberCount('app:started')).toBe(0);
      expect(eventBus.getSubscriberCount('app:stopped')).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should not throw when handler throws error', () => {
      const errorHandler = jest.fn(() => {
        throw new Error('Handler error');
      });

      const goodHandler = jest.fn();

      eventBus.subscribe('app:error', errorHandler);
      eventBus.subscribe('app:error', goodHandler);

      expect(() => {
        eventBus.publish('app:error', {
          appId: 'test-id',
          name: 'test-app',
          error: new Error('Test'),
        });
      }).not.toThrow();

      expect(goodHandler).toHaveBeenCalled();
    });

    it('should not throw when global handler throws error', () => {
      const errorHandler = jest.fn(() => {
        throw new Error('Global handler error');
      });

      eventBus.subscribeAll(errorHandler);

      expect(() => {
        eventBus.publish('platform:started', {});
      }).not.toThrow();
    });
  });

  describe('async handlers', () => {
    it('should handle async subscribers', async () => {
      const results: string[] = [];

      eventBus.subscribe('app:started', async payload => {
        await new Promise(resolve => setTimeout(resolve, 10));
        results.push(`async: ${payload.name}`);
      });

      eventBus.publish('app:started', {
        appId: 'test-id',
        name: 'test-app',
        port: 3000,
      });

      // Wait for async handler
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(results).toContain('async: test-app');
    });
  });
});
