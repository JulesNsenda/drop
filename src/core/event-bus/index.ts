/**
 * Event Bus Module
 *
 * Exports the EventBus class, singleton instance, and all related types.
 */

export { EventBus, eventBus } from './event-bus';

export type {
  // Event type unions
  EventType,
  PlatformEventType,
  AppEventType,
  BuildEventType,
  DeploymentEventType,
  WatcherEventType,

  // Base types
  BaseEvent,
  DropEvent,

  // Payload types
  EventPayload,
  EventPayloadMap,
  PlatformStartingPayload,
  PlatformStartedPayload,
  PlatformStoppingPayload,
  PlatformStoppedPayload,
  PlatformErrorPayload,
  AppDetectedPayload,
  AppCreatedPayload,
  AppUpdatedPayload,
  AppRemovedPayload,
  AppDeletedPayload,
  AppStartingPayload,
  AppStartedPayload,
  AppStoppingPayload,
  AppStoppedPayload,
  AppErrorPayload,
  BuildQueuedPayload,
  BuildStartedPayload,
  BuildProgressPayload,
  BuildCompletedPayload,
  BuildFailedPayload,
  DeploymentStartedPayload,
  DeploymentCompletedPayload,
  DeploymentFailedPayload,
  DeploymentRolledbackPayload,
  WatcherStartedPayload,
  WatcherStoppedPayload,
  WatcherChangePayload,

  // Handler types
  EventHandler,
  GlobalEventHandler,
  Unsubscribe,

  // Query options
  EventHistoryOptions,
} from './event-bus.types';
