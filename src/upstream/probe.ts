import { validateTargetUrl } from '../security/ssrf.js';

export interface UpstreamProbeResult {
  auth_required: boolean;
  auth_type: 'none' | 'upstream_oauth' | 'bearer' | 'basic' | 'custom';
  provider_name?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  client_id_metadata_document_supported?: boolean;
  scopes?: string[];
  description?: string;
}

export async function probeUpstream(
  upstreamUrl: string,
  blockPrivateNetworks: boolean = false
): Promise<UpstreamProbeResult> {
  // Validate SSRF
  await validateTargetUrl(upstreamUrl, blockPrivateNetworks);

  let response: Response;
  try {
    response = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream, application/json',
        'User-Agent': 'MCeption/1.0',
      },
      signal: AbortSignal.timeout(6000),
    });
  } catch (err: any) {
    throw new Error(`Failed to probe upstream URL "${upstreamUrl}": ${err.message}`);
  }

  if (response.status >= 200 && response.status < 300) {
    return {
      auth_required: false,
      auth_type: 'none',
      description: 'No authentication required.',
    };
  }

  if (response.status === 401) {
    const wwwAuth = response.headers.get('www-authenticate') || '';

    // Check for RFC 9728 resource_metadata
    const metaMatch =
      wwwAuth.match(/resource_metadata="([^"]+)"/i) ||
      wwwAuth.match(/resource_metadata=([^,\s]+)/i);

    if (metaMatch && metaMatch[1]) {
      const resourceMetadataUrl = metaMatch[1];
      try {
        await validateTargetUrl(resourceMetadataUrl, blockPrivateNetworks);

        const metaRes = await fetch(resourceMetadataUrl, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        });

        if (metaRes.ok) {
          const metaJson = (await metaRes.json()) as any;
          const resourceName = metaJson.resource_name || 'OAuth 2.1 Provider';
          const authServers = metaJson.authorization_servers;

          if (Array.isArray(authServers) && authServers.length > 0) {
            const authServer = authServers[0].replace(/\/$/, '');
            await validateTargetUrl(authServer, blockPrivateNetworks);

            // Fetch OAuth authorization server metadata (RFC 8414)
            let serverMeta: any = null;
            try {
              const serverMetaRes = await fetch(
                `${authServer}/.well-known/oauth-authorization-server`,
                {
                  headers: { Accept: 'application/json' },
                  signal: AbortSignal.timeout(5000),
                }
              );
              if (serverMetaRes.ok) {
                serverMeta = await serverMetaRes.json();
              }
            } catch {
              // Fallback to openid-configuration
            }

            if (!serverMeta) {
              try {
                const oidcRes = await fetch(
                  `${authServer}/.well-known/openid-configuration`,
                  {
                    headers: { Accept: 'application/json' },
                    signal: AbortSignal.timeout(5000),
                  }
                );
                if (oidcRes.ok) {
                  serverMeta = await oidcRes.json();
                }
              } catch {
                // Ignore fallback failure
              }
            }

            if (serverMeta && serverMeta.authorization_endpoint) {
              return {
                auth_required: true,
                auth_type: 'upstream_oauth',
                provider_name: resourceName,
                authorization_endpoint: serverMeta.authorization_endpoint,
                token_endpoint: serverMeta.token_endpoint,
                registration_endpoint: serverMeta.registration_endpoint,
                client_id_metadata_document_supported:
                  !!serverMeta.client_id_metadata_document_supported,
                scopes: serverMeta.scopes_supported || [],
                description: `Interactive OAuth with ${resourceName}`,
              };
            }
          }
        }
      } catch {
        // Fall back to standard headers parsing if metadata fetch fails
      }
    }

    if (wwwAuth.toLowerCase().includes('bearer')) {
      return {
        auth_required: true,
        auth_type: 'bearer',
        description: 'Requires a Bearer Token.',
      };
    }

    if (wwwAuth.toLowerCase().includes('basic')) {
      return {
        auth_required: true,
        auth_type: 'basic',
        description: 'Requires Basic Authentication (username & password).',
      };
    }

    return {
      auth_required: true,
      auth_type: 'custom',
      description: 'Requires authentication headers.',
    };
  }

  return {
    auth_required: true,
    auth_type: 'custom',
    description: `Upstream server returned HTTP ${response.status}`,
  };
}
