/**
 * Minimal HTTP routing primitives over `node:http` (design open-question: bare
 * node handler vs a micro-framework — we keep deps to `zod` only). A route is a
 * method + a `/`-segmented pattern where `:name` segments capture params; the
 * dispatcher matches in registration order and calls the first hit.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface HandlerCtx {
  params: Record<string, string>;
  url: URL;
  body: unknown;
  req: IncomingMessage;
  res: ServerResponse;
}

/** A handler returns a JSON result, or handles `res` itself and returns void. */
export interface HandlerResult {
  status: number;
  json?: unknown;
}

export type Handler = (ctx: HandlerCtx) => Promise<HandlerResult> | HandlerResult;

export interface Route {
  method: string;
  pattern: string;
  handler: Handler;
}

interface CompiledRoute extends Route {
  segments: string[];
}

function compile(route: Route): CompiledRoute {
  return { ...route, segments: route.pattern.split('/').filter(Boolean) };
}

/** Match a request path against a compiled pattern, capturing `:name` params. */
function matchSegments(
  segments: string[],
  pathSegments: string[],
): Record<string, string> | null {
  if (segments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const actual = pathSegments[i];
    if (seg.startsWith(':')) {
      params[seg.slice(1)] = decodeURIComponent(actual);
    } else if (seg !== actual) {
      return null;
    }
  }
  return params;
}

export interface MatchedRoute {
  route: CompiledRoute;
  params: Record<string, string>;
}

export function createRouter(routes: Route[]): {
  match(method: string, pathname: string): MatchedRoute | null;
} {
  const compiled = routes.map(compile);
  return {
    match(method, pathname) {
      const pathSegments = pathname.split('/').filter(Boolean);
      for (const route of compiled) {
        if (route.method !== method) continue;
        const params = matchSegments(route.segments, pathSegments);
        if (params) return { route, params };
      }
      return null;
    },
  };
}

/** Read and JSON-parse a request body; `undefined` for an empty body. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return undefined;
  return JSON.parse(raw) as unknown;
}

export function sendJson(res: ServerResponse, status: number, json: unknown): void {
  const body = JSON.stringify(json);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
