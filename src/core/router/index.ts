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

export {
  validateDnsCredentials,
  generateDnsChallengeConfig,
  generateTlsDirectiveWithDns,
  requiresDnsChallenge,
  getRequiredEnvVars,
  checkProviderEnvVars,
} from './dns-challenge';

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

export type {
  DnsProvider,
  DnsProviderConfig,
  DnsChallengeConfig,
} from './dns-challenge';
