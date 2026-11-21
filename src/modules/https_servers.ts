import fs from "node:fs";
import tls from "node:tls";

export interface HttpsServerLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  success: (msg: string) => void;
  debug: (msg: string) => void;
}

export interface HttpsServerConfig {
  name: string;
  sslEnabled: boolean;
  httpPort: number;
  httpsPort: number;
  internalPort: number;
  internalHost?: string;
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  http3?: boolean;
  log?: HttpsServerLogger;
  filterRequest?: (req: Request, ip: string) => Response | null | Promise<Response | null>;
}

export interface HttpsServerStack {
  proxy: ReturnType<typeof Bun.serve<any, any>>;
  redirect: ReturnType<typeof Bun.serve<any, any>> | null;
  publicPort: number;
  internalUrl: string;
  sslEnabled: boolean;
}

export function getHttpProtocolOptions(sslEnabled: boolean, http3Override?: boolean): { http1: boolean; http2: boolean; http3?: boolean } {
  const http1 = process.env.WEBSRV_HTTP1 !== "false";
  const http2 = process.env.WEBSRV_HTTP2 !== "false";
  const http3 = sslEnabled && (http3Override ?? process.env.WEBSRV_HTTP3 !== "false");

  const options: { http1: boolean; http2: boolean; http3?: boolean } = { http1, http2 };
  if (http3) {
    options.http3 = true;
  }
  return options;
}

function readChain(certPath: string, caPath?: string): string {
  const cert = fs.readFileSync(certPath, "utf-8").replace(/^\uFEFF/, "").trim();
  if (caPath && fs.existsSync(caPath)) {
    return cert + "\n" + fs.readFileSync(caPath, "utf-8").replace(/^\uFEFF/, "").trim();
  }
  return cert;
}

export function isInternalTlsEnabled(certPath?: string, keyPath?: string): boolean {
  return !!certPath && !!keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath);
}

export function getInternalBaseUrl(port: number, certPath?: string, keyPath?: string, host?: string): string {
  const scheme = isInternalTlsEnabled(certPath, keyPath) ? "https" : "http";
  return `${scheme}://${host ?? "127.0.0.1"}:${port}`;
}

export function getInternalServerOptions(certPath: string, keyPath: string, caPath?: string): { http1: boolean; http2: boolean; http3?: boolean; tls?: { cert: string; key: string | Buffer } } {
  const protocols = getHttpProtocolOptions(isInternalTlsEnabled(certPath, keyPath));
  if (!isInternalTlsEnabled(certPath, keyPath)) {
    return protocols;
  }
  return {
    ...protocols,
    tls: {
      cert: readChain(certPath, caPath),
      key: fs.readFileSync(keyPath),
    },
  };
}

// Origins whose HTTP/3 support has been probed: true = h3 works, false = h2 only.
const http3Origins = new Map<string, boolean>();
const HTTP3_PROBE_TIMEOUT_MS = 2500;
const HTTP3_LOOPBACK_PROBE_TIMEOUT_MS = 250;

/** Whether a URL's host is this machine: 127.0.0.0/8, ::1 or localhost. */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

let extraCa: string[] | null = null;
function trustedCas(): string[] | undefined {
  if (extraCa === null) {
    extraCa = [];
    const caPath = process.env.TLS_CA_PATH;
    try {
      if (caPath && fs.existsSync(caPath)) extraCa = [...tls.rootCertificates, fs.readFileSync(caPath, "utf8")];
    } catch {
      extraCa = [];
    }
  }
  return extraCa.length > 0 ? extraCa : undefined;
}

export function tlsFor(url: string): { rejectUnauthorized?: boolean; ca?: string[] } {
  if (isLoopbackUrl(url)) return { rejectUnauthorized: false };
  const ca = trustedCas();
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

export function serverFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!url.startsWith("https://")) {
    return fetch(url, init);
  }

  const origin = new URL(url).origin;
  const tlsOptions = tlsFor(url);
  const known = http3Origins.get(origin);

  if (known === false) {
    return fetch(url, { ...init, protocol: "http2", tls: tlsOptions });
  }

  if (known === true) {
    return fetch(url, { ...init, protocol: "http3", tls: tlsOptions })
      .catch(() => {
        http3Origins.set(origin, false);
        return fetch(url, { ...init, protocol: "http2", tls: tlsOptions });
      });
  }

  const callerSignal = init?.signal ?? null;
  const probe = new AbortController();
  const forwardAbort = () => probe.abort();
  if (callerSignal) {
    if (callerSignal.aborted) probe.abort();
    else callerSignal.addEventListener("abort", forwardAbort, { once: true });
  }
  const timer = setTimeout(() => probe.abort(), isLoopbackUrl(url) ? HTTP3_LOOPBACK_PROBE_TIMEOUT_MS : HTTP3_PROBE_TIMEOUT_MS);

  return fetch(url, { ...init, protocol: "http3", tls: tlsOptions, signal: probe.signal })
    .then((res) => {
      http3Origins.set(origin, true);
      return res;
    })
    .catch(() => {
      http3Origins.set(origin, false);
      return fetch(url, { ...init, protocol: "http2", tls: tlsOptions });
    })
    .finally(() => {
      clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener("abort", forwardAbort);
    });
}

const consoleLogger: HttpsServerLogger = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
  success: (msg: string) => console.log(msg),
  debug: (msg: string) => console.debug(msg),
};

function tryParseURL(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function startHttpsServers(config: HttpsServerConfig): HttpsServerStack {
  const log = config.log ?? consoleLogger;

  const filesOk = !!config.certPath && !!config.keyPath && fs.existsSync(config.certPath) && fs.existsSync(config.keyPath);
  const sslEnabled = config.sslEnabled && filesOk;

  if (config.sslEnabled && !filesOk) {
    log.error(`[${config.name}] SSL requested but certificates not found.`);
    log.error(`  Cert path: ${config.certPath || "(TLS_CERT_PATH not set)"} (exists: ${!!config.certPath && fs.existsSync(config.certPath)})`);
    log.error(`  Key path:  ${config.keyPath || "(TLS_KEY_PATH not set)"} (exists: ${!!config.keyPath && fs.existsSync(config.keyPath)})`);
  }

  const publicPort = sslEnabled ? config.httpsPort : config.httpPort;
  const internalUrl = getInternalBaseUrl(config.internalPort, config.certPath, config.keyPath, config.internalHost);

  const tlsOptions = sslEnabled
    ? {
        tls: {
          cert: readChain(config.certPath!, config.caPath),
          key: fs.readFileSync(config.keyPath!),
        },
      }
    : {};

  const proxy = Bun.serve({
    hostname: "0.0.0.0",
    port: publicPort,
    development: false,
    reusePort: true,
    ...getHttpProtocolOptions(sslEnabled, config.http3),
    async fetch(req: Request, server: any) {
      const url = tryParseURL(req.url);
      if (!url) {
        return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
      }

      const ip = server.requestIP(req)?.address;
      if (!ip) {
        return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
      }

      if (config.filterRequest) {
        const blocked = await config.filterRequest(req, ip);
        if (blocked) {
          return blocked;
        }
      }

      const headers = new Headers(req.headers);
      headers.delete("X-Real-Client-IP");
      headers.set("X-Real-Client-IP", ip);
      headers.set("X-Forwarded-For", ip);
      headers.set("X-Forwarded-Proto", sslEnabled ? "https" : "http");
      headers.set("Accept-Encoding", "identity");

      try {
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        return await serverFetch(`${internalUrl}${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          body: hasBody ? await req.arrayBuffer() : undefined,
          redirect: "manual",
        });
      } catch (error) {
        log.error(`[${config.name}] Failed to proxy request: ${error}`);
        return new Response(JSON.stringify({ message: "Bad gateway" }), { status: 502 });
      }
    },
    ...tlsOptions,
  });

  let redirect: ReturnType<typeof Bun.serve<any, any>> | null = null;
  if (sslEnabled) {
    redirect = Bun.serve({
      hostname: "0.0.0.0",
      port: config.httpPort,
      development: false,
      reusePort: true,
      ...getHttpProtocolOptions(false),
      fetch(req: Request) {
        const url = tryParseURL(req.url);
        if (!url) {
          return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
        }
        // If the HTTPS port is 443, don't include it in the redirect
        const port = config.httpsPort === 443 ? "" : `:${config.httpsPort}`;
        return Response.redirect(`https://${url.hostname}${port}${url.pathname}${url.search}`, 301);
      },
    });
  }

  log.success(
    `[${config.name}] ${sslEnabled ? "HTTPS" : "HTTP"} proxy started on port ${publicPort} forwarding to ${internalUrl}` +
    (sslEnabled ? ` (HTTP->HTTPS redirect on port ${config.httpPort})` : "")
  );

  return { proxy, redirect, publicPort, internalUrl, sslEnabled };
}
