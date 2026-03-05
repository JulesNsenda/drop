/**
 * Webhook Manager
 *
 * Manages webhook registrations and dispatches events to registered URLs.
 * Subscribes to the EventBus and sends HTTP POST notifications.
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { eventBus, Unsubscribe } from '../event-bus';
import {
  WebhookConfig,
  WebhookEvent,
  WebhookPayload,
  WebhookDelivery,
} from './webhook.types';

const WEBHOOK_EVENTS: WebhookEvent[] = [
  'app:created',
  'app:started',
  'app:stopped',
  'app:errored',
  'app:removed',
  'build:started',
  'build:completed',
  'build:failed',
];

const MAX_DELIVERY_HISTORY = 100;
const DELIVERY_TIMEOUT_MS = 10_000;

export interface WebhookManagerConfig {
  /** Path to persist webhook registrations */
  storePath: string;
}

export class WebhookManager {
  private readonly config: WebhookManagerConfig;
  private webhooks: Map<string, WebhookConfig> = new Map();
  private deliveries: WebhookDelivery[] = [];
  private subscriptions: Unsubscribe[] = [];
  private initialized = false;

  constructor(config: WebhookManagerConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await fs.mkdir(path.dirname(this.config.storePath), { recursive: true });
    await this.loadWebhooks();
    this.subscribeToEvents();
    this.initialized = true;
  }

  async close(): Promise<void> {
    for (const unsub of this.subscriptions) {
      unsub();
    }
    this.subscriptions = [];
    this.initialized = false;
  }

  // ============ CRUD ============

  async register(config: Omit<WebhookConfig, 'id' | 'createdAt'>): Promise<WebhookConfig> {
    const webhook: WebhookConfig = {
      ...config,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };

    this.webhooks.set(webhook.id, webhook);
    await this.saveWebhooks();
    return webhook;
  }

  async update(id: string, updates: Partial<Omit<WebhookConfig, 'id' | 'createdAt'>>): Promise<WebhookConfig | null> {
    const webhook = this.webhooks.get(id);
    if (!webhook) return null;

    const updated = { ...webhook, ...updates };
    this.webhooks.set(id, updated);
    await this.saveWebhooks();
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    const deleted = this.webhooks.delete(id);
    if (deleted) {
      await this.saveWebhooks();
    }
    return deleted;
  }

  get(id: string): WebhookConfig | undefined {
    return this.webhooks.get(id);
  }

  getAll(): WebhookConfig[] {
    return Array.from(this.webhooks.values());
  }

  getDeliveries(webhookId?: string, limit: number = 20): WebhookDelivery[] {
    let results = this.deliveries;
    if (webhookId) {
      results = results.filter(d => d.webhookId === webhookId);
    }
    return results.slice(-limit);
  }

  // ============ Event Dispatch ============

  private subscribeToEvents(): void {
    for (const event of WEBHOOK_EVENTS) {
      const unsub = eventBus.subscribe(event as any, (payload: unknown) => {
        this.dispatch(event, payload as Record<string, unknown>);
      });
      this.subscriptions.push(unsub);
    }
  }

  private async dispatch(event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
    const activeWebhooks = Array.from(this.webhooks.values()).filter(
      w => w.active && w.events.includes(event)
    );

    // Fire-and-forget for each webhook
    for (const webhook of activeWebhooks) {
      this.deliver(webhook, event, data).catch(() => {
        // Errors are recorded in delivery history
      });
    }
  }

  private async deliver(
    webhook: WebhookConfig,
    event: WebhookEvent,
    data: Record<string, unknown>
  ): Promise<void> {
    const payload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      data,
    };

    const body = JSON.stringify(payload);
    const deliveryId = crypto.randomUUID();
    const start = Date.now();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'DROP-Webhook/1.0',
      'X-DROP-Event': event,
      'X-DROP-Delivery': deliveryId,
    };

    // HMAC signature if secret is configured
    if (webhook.secret) {
      const signature = crypto
        .createHmac('sha256', webhook.secret)
        .update(body)
        .digest('hex');
      headers['X-DROP-Signature'] = `sha256=${signature}`;
    }

    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });

      this.recordDelivery({
        id: deliveryId,
        webhookId: webhook.id,
        event,
        statusCode: response.status,
        success: response.ok,
        error: response.ok ? undefined : `HTTP ${response.status}`,
        duration: Date.now() - start,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      this.recordDelivery({
        id: deliveryId,
        webhookId: webhook.id,
        event,
        statusCode: null,
        success: false,
        error: err instanceof Error ? err.message : 'Delivery failed',
        duration: Date.now() - start,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private recordDelivery(delivery: WebhookDelivery): void {
    this.deliveries.push(delivery);
    if (this.deliveries.length > MAX_DELIVERY_HISTORY) {
      this.deliveries = this.deliveries.slice(-MAX_DELIVERY_HISTORY);
    }
  }

  // ============ Persistence ============

  private async loadWebhooks(): Promise<void> {
    try {
      const data = await fs.readFile(this.config.storePath, 'utf-8');
      const parsed = JSON.parse(data) as { webhooks: WebhookConfig[] };
      this.webhooks.clear();
      for (const wh of parsed.webhooks || []) {
        this.webhooks.set(wh.id, wh);
      }
    } catch {
      // No file or invalid - start fresh
    }
  }

  private async saveWebhooks(): Promise<void> {
    const data = {
      version: 1,
      webhooks: Array.from(this.webhooks.values()),
    };
    await fs.writeFile(this.config.storePath, JSON.stringify(data, null, 2));
  }
}

// Singleton
let instance: WebhookManager | null = null;

export function getWebhookManager(config?: WebhookManagerConfig): WebhookManager {
  if (!instance) {
    if (!config) throw new Error('WebhookManager config required on first call');
    instance = new WebhookManager(config);
  }
  return instance;
}

export function resetWebhookManager(): void {
  if (instance) {
    instance.close();
  }
  instance = null;
}
