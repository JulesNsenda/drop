# HTTPS & SSL Setup Guide

This guide covers setting up HTTPS with automatic Let's Encrypt certificates for DROP deployments.

## Quick Start

### Basic HTTPS (HTTP-01 Challenge)

For standard deployments where your server is accessible on ports 80/443:

```bash
drop serve --domain example.com --https --acme-email admin@example.com
```

This will:
- Configure all apps at `*.example.com` (e.g., `myapp.example.com`)
- Automatically obtain Let's Encrypt certificates
- Redirect HTTP to HTTPS

### Testing with Staging Certificates

Before going to production, test with Let's Encrypt's staging environment:

```bash
drop serve --domain example.com --https --acme-email admin@example.com --acme-staging
```

Staging certificates won't be trusted by browsers but help verify your setup without hitting rate limits.

## Configuration Options

### CLI Flags

| Flag | Description | Example |
|------|-------------|---------|
| `--domain <suffix>` | Domain suffix for apps | `--domain example.com` |
| `--https` | Enable HTTPS with Let's Encrypt | `--https` |
| `--acme-email <email>` | Email for certificate notifications | `--acme-email admin@example.com` |
| `--acme-staging` | Use Let's Encrypt staging (testing) | `--acme-staging` |
| `--dns-provider <provider>` | DNS provider for wildcard certs | `--dns-provider cloudflare` |
| `--wildcard` | Use wildcard certificate | `--wildcard` |

### Environment Variables

Environment variables can be used instead of CLI flags:

```bash
# Core HTTPS settings
export DROP_DOMAIN_SUFFIX=example.com
export DROP_ENABLE_HTTPS=true
export DROP_ACME_EMAIL=admin@example.com
export DROP_ACME_STAGING=false

# DNS provider credentials (for wildcards)
export DROP_DNS_PROVIDER=cloudflare
export DROP_WILDCARD_CERT=true

# Cloudflare
export DROP_DNS_CF_API_TOKEN=your-api-token
# or use standard Cloudflare env vars
export CF_API_TOKEN=your-api-token

# AWS Route 53
export DROP_DNS_AWS_ACCESS_KEY=your-access-key
export DROP_DNS_AWS_SECRET_KEY=your-secret-key
# or use standard AWS env vars
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
```

## Wildcard Certificates

Wildcard certificates (`*.example.com`) require DNS-01 challenge, which needs access to your DNS provider's API.

### Supported DNS Providers

- **Cloudflare** (`cloudflare`)
- **AWS Route 53** (`route53`)
- **DigitalOcean** (`digitalocean`)
- **GoDaddy** (`godaddy`)

### Cloudflare Setup

1. Create an API token at [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)
2. Token needs `Zone:DNS:Edit` permission for your zone
3. Configure DROP:

```bash
export CF_API_TOKEN=your-cloudflare-api-token
drop serve --domain example.com --https --wildcard --dns-provider cloudflare
```

### AWS Route 53 Setup

1. Create an IAM user with Route 53 permissions
2. Get access key and secret key
3. Configure DROP:

```bash
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
drop serve --domain example.com --https --wildcard --dns-provider route53
```

### DigitalOcean Setup

```bash
export DO_AUTH_TOKEN=your-do-token
drop serve --domain example.com --https --wildcard --dns-provider digitalocean
```

### GoDaddy Setup

```bash
export GODADDY_API_KEY=your-api-key
export GODADDY_API_SECRET=your-api-secret
drop serve --domain example.com --https --wildcard --dns-provider godaddy
```

## Per-App Domain Configuration

Apps can specify custom domains in their `drop.yaml` file:

```yaml
# myapp/drop.yaml
name: my-app
domains:
  - myapp.com
  - www.myapp.com
  - api.myapp.com
```

### Custom TLS Certificates

For apps that need their own certificates:

```yaml
# myapp/drop.yaml
name: my-app
domains:
  - myapp.com
tls:
  certFile: /path/to/cert.pem
  keyFile: /path/to/key.pem
```

### Disable HTTPS for Specific Apps

```yaml
# myapp/drop.yaml
name: my-app
tls:
  disabled: true
```

## Certificate Management API

DROP provides a REST API for certificate management:

### List All Certificates

```bash
curl http://localhost:3000/api/v1/certs
```

### Get Certificate for Domain

```bash
curl http://localhost:3000/api/v1/certs/myapp.example.com
```

### Get Expiring Certificates

```bash
# Certificates expiring within 7 days (default)
curl http://localhost:3000/api/v1/certs/expiring

# Certificates expiring within 30 days
curl http://localhost:3000/api/v1/certs/expiring?days=30
```

### Certificate Health Check

```bash
curl http://localhost:3000/api/v1/certs/health
```

### Trigger Certificate Renewal

```bash
curl -X POST http://localhost:3000/api/v1/certs/renew
```

## DNS Requirements

### For HTTP-01 Challenge (Standard)

1. Your domain must resolve to your server's IP
2. Port 80 must be accessible from the internet
3. Caddy handles the challenge automatically

### For DNS-01 Challenge (Wildcards)

1. DNS provider API access is required
2. Ports 80/443 don't need to be publicly accessible
3. Useful for internal/private deployments

## Troubleshooting

### Domain Doesn't Resolve

DROP validates DNS resolution on startup. If you see warnings:

```
[WARN] Domain 'example.com' does not resolve via DNS
```

Check:
1. DNS A/AAAA records are configured
2. DNS propagation is complete (can take up to 48 hours)
3. Use `dig example.com` or `nslookup example.com` to verify

### Certificate Issuance Fails

Common causes:
- **Rate limits**: Let's Encrypt has [rate limits](https://letsencrypt.org/docs/rate-limits/). Use staging for testing.
- **DNS not propagated**: Wait for DNS changes to propagate
- **Port 80 blocked**: Ensure port 80 is accessible for HTTP-01 challenge
- **Firewall rules**: Check that Caddy can make outbound HTTPS connections

### Expired Certificates

DROP monitors certificate expiry and logs warnings for certs expiring within 7 days. Caddy automatically renews certificates 30 days before expiry.

If renewal fails:
1. Check the Caddy logs: `C:\drop\data\logs\caddy\` or `/var/drop/data/logs/caddy/`
2. Verify DNS provider credentials (for wildcards)
3. Manually trigger renewal: `curl -X POST http://localhost:3000/api/v1/certs/renew`

### Localhost Development

When using localhost domains (`*.localhost`), HTTPS is automatically disabled. Apps are accessible via HTTP only in development mode.

## Security Best Practices

1. **Always use HTTPS in production** - Set `--https` flag
2. **Provide ACME email** - Required for certificate expiry notifications
3. **Test with staging first** - Avoid rate limits while configuring
4. **Monitor certificate expiry** - Use the `/api/v1/certs/health` endpoint
5. **Secure API credentials** - Use environment variables, not CLI flags for secrets
6. **Keep Caddy updated** - Security patches are important

## Architecture

DROP uses [Caddy](https://caddyserver.com/) as the reverse proxy and automatic HTTPS provider:

```
Internet -> Caddy (port 80/443) -> DROP Apps (ports 3001-3999)
                 |
                 +-> Let's Encrypt ACME
```

Caddy handles:
- Automatic certificate issuance and renewal
- HTTPS termination
- HTTP to HTTPS redirects
- Reverse proxy to app ports

## Related Documentation

- [Caddy Documentation](https://caddyserver.com/docs/)
- [Let's Encrypt Documentation](https://letsencrypt.org/docs/)
- [ACME Protocol](https://tools.ietf.org/html/rfc8555)
