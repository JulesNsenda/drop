/**
 * Webhook Type Definitions
 */

export type WebhookEvent =
  | 'app:created'
  | 'app:started'
  | 'app:stopped'
  | 'app:errored'
  | 'app:removed'
  | 'build:started'
  | 'build:completed'
  | 'build:failed';

export interface WebhookConfig {
  /** Unique ID */
  id: string;
  /** Display name */
  name: string;
  /** Target URL to send POST requests to */
  url: string;
  /** Events to subscribe to */
  events: WebhookEvent[];
  /** Optional secret for HMAC signing */
  secret?: string;
  /** Whether the webhook is active */
  active: boolean;
  /** Created timestamp */
  createdAt: string;
}

export interface WebhookPayload {
  /** Event type */
  event: WebhookEvent;
  /** Timestamp */
  timestamp: string;
  /** Event data */
  data: Record<string, unknown>;
}

export interface WebhookDelivery {
  /** Delivery ID */
  id: string;
  /** Webhook ID */
  webhookId: string;
  /** Event that triggered the delivery */
  event: WebhookEvent;
  /** HTTP status code of the response */
  statusCode: number | null;
  /** Whether delivery was successful */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Duration in milliseconds */
  duration: number;
  /** Timestamp */
  timestamp: string;
}
