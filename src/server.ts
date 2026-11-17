// server.ts — the forge's HTTP server.
//
// One Node built-in http server answers everything:
//   GET  /healthz                                  the boot probe
//   /api/v3/*                                      the GitHub REST v3 surface
//   POST /api/graphql                             GraphQL (single + batched)
//   POST /mcp                                     Model Context Protocol
//   /{owner}/{repo}.git/info/refs                 git smart-HTTP advertisements
//   /{owner}/{repo}.git/git-upload-pack           git smart-HTTP fetch / ls-refs
//   /{owner}/{repo}.git/git-receive-pack          git smart-HTTP push
//
// Every reply carries a non-empty X-GitHub-Request-Id. REST, GraphQL and MCP
// answers are application/json. The git endpoints answer the smart-HTTP
// content types the git client expects.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { Forge } from './store.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';

/** A request body larger than this is refused (packs are at most a few MB). */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

const MCP_SESSION_ID = 'forge-session';

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `forge-req-${requestSeq}`;
}

/** The bearer token the suite authenticates with (env MAKEFUN_SHOP_TOKEN). */
function configuredToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/**
 * True when the request carries the configured token. With no token configured
 * (local development) any non-empty bearer is accepted, so the server can be
 * exercised without an env var; the trial always sets one.
 */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  const token = configuredToken();
  return token === '' || presented === token;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer | string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': contentType, 'x-github-request-id': nextRequestId(), ...extraHeaders });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  send(res, status, 'application/json', JSON.stringify(value), extraHeaders);
}

function decodeSegments(segments: string[]): string[] | null {
  try {
    return segments.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

export interface ForgeServer {
  server: Server;
  forge: Forge;
}

/** Build the server (unbound); main.ts binds it. */
export function createForgeServer(): ForgeServer {
  const forge = new Forge();

  const server = createServer((req, res) => {
    void handleRequest(forge, req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } else {
        res.destroy();
      }
    });
  });

  return { server, forge };
}

async function handleRequest(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;

  // The boot probe: no auth, always 200.
  if (path === '/healthz' && method === 'GET') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  // ---------------------------------------------------------------- REST v3
  if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const rawSegments = path === '/api/v3' || path === '/api/v3/' ? [] : path.slice('/api/v3/'.length).split('/');
    const segments = decodeSegments(rawSegments);
    if (segments === null) {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    let body: unknown;
    let bodyMalformed = false;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8')) as unknown;
        } catch {
          bodyMalformed = true;
        }
      }
    }
    const request: RestRequest = { method, segments, query: url.searchParams, body, bodyMalformed, origin: `http://${req.headers.host ?? '127.0.0.1'}` };
    const outcome = handleRest(forge, request);
    if (outcome.result.body === null) {
      send(res, outcome.result.status, 'application/json', '', outcome.headers ?? {});
      return;
    }
    sendJson(res, outcome.result.status, outcome.result.body, outcome.headers ?? {});
    return;
  }

  // ---------------------------------------------------------------- GraphQL
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    sendJson(res, 200, handleGraphQL(forge, parsed));
    return;
  }

  // ---------------------------------------------------------------- MCP
  if (path === '/mcp') {
    if (method === 'DELETE') {
      // A session close: nothing is held, so there is nothing to tear down.
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, { 'mcp-session-id': MCP_SESSION_ID });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      sendJson(
        res,
        400,
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
        { 'mcp-session-id': MCP_SESSION_ID },
      );
      return;
    }
    const outcome = handleMcp(forge, parsed);
    if (outcome.body === null) {
      res.writeHead(outcome.status, { 'x-github-request-id': nextRequestId(), 'mcp-session-id': MCP_SESSION_ID });
      res.end();
      return;
    }
    sendJson(res, outcome.status, outcome.body, { 'mcp-session-id': MCP_SESSION_ID });
    return;
  }

  // ---------------------------------------------------------------- git smart HTTP
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    const segments = decodeSegments([gitMatch[1]!, gitMatch[2]!]);
    if (segments === null) {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    const [owner, repoName] = segments as [string, string];
    const service = gitMatch[3]!;
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : null;
    if (service === 'info/refs') {
      if (method !== 'GET') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const asked = url.searchParams.get('service');
      if (asked !== 'git-upload-pack' && asked !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'service is required' });
        return;
      }
      const result = handleInfoRefs(forge, owner, repoName, asked, gitProtocol);
      send(res, result.status, result.contentType, result.body);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const body = await readBody(req);
    const result =
      service === 'git-upload-pack'
        ? handleUploadPack(forge, owner, repoName, body, gitProtocol)
        : handleReceivePack(forge, owner, repoName, body);
    send(res, result.status, result.contentType, result.body);
    return;
  }

  // ---------------------------------------------------------------- unknown route
  sendJson(res, 404, { message: 'Not Found' });
}
