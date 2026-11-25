// Application-owned MSAL network client for the local corporate proxy.
import { ProxyAgent, fetch } from 'undici';

export function createAzureNetworkClient() {
  const proxyUrl = process.env.AZURE_HTTPS_PROXY || process.env.HTTPS_PROXY ||
    process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxyUrl) return undefined;
  const dispatcher = new ProxyAgent(proxyUrl);
  async function request(method: string, url: string, options: {
    headers?: Record<string, string>; body?: string;
  } = {}, timeout = 15000) {
    const response = await fetch(url, {
      method, headers: options.headers, body: options.body, dispatcher,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: text ? JSON.parse(text) : {},
    };
  }
  return {
    sendGetRequestAsync: (url: string, options?: { headers?: Record<string, string> }, timeout?: number) =>
      request('GET', url, options, timeout),
    sendPostRequestAsync: (url: string, options?: { headers?: Record<string, string>; body?: string }, timeout?: number) =>
      request('POST', url, options, timeout),
    close: () => dispatcher.close(),
  };
}
