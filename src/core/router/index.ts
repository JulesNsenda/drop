/**
 * Router Module
 *
 * Exports the RouterService and related types.
 */

export {
  RouterService,
  createRouterService,
  getRouterService,
  resetRouterService,
} from './router';

export {
  generateCaddyfile,
  generateFullCaddyfile,
  generateRouteBlock,
  generateHttpRedirectBlock,
  parseTlsProtocols,
} from './caddy-generator';

export type {
  RouteConfig,
  Route,
  RouteStatus,
  RouterConfig,
  CaddyConfig,
  TLSConfig,
  LoadBalanceConfig,
  UpstreamConfig,
  CaddyBlock,
  CaddyDirective,
  RouterEventType,
  RouteChangePayload,
} from './router.types';
