import { Buffer } from 'node:buffer';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  RequestMethod,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  CUSTOM_ROUTE_ARGS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  RESPONSE_PASSTHROUGH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { parse as parseCookies, serialize as serializeCookie, type SerializeOptions } from 'cookie';
import { parse as parseQuery } from 'fast-querystring';
import FindMyWay, { type HTTPVersion } from 'find-my-way';
import { from, isObservable, lastValueFrom, type Observable } from 'rxjs';
import { v7 as uuidv7 } from 'uuid';
import { withCorrelation } from '@jobwork/observability';
import { APP_GUARD, APP_INTERCEPTOR, type Container } from './container';
import { clientAddress } from './client-address';

/**
 * Serves the controllers the container built, the way NestJS's Fastify adapter did
 * (F-CW.2): `find-my-way` routes (Fastify's router), Fastify-shaped request and reply
 * objects, global guards then interceptors then the handler, and one exception filter
 * for every throw. The entry point is a `fetch` function, so Node and a Worker share it.
 */

export const GLOBAL_PREFIX = '/api/v1';
/** Fastify's default `bodyLimit`. */
const BODY_LIMIT = 1_048_576;
const CORRELATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

type Handler = (...args: unknown[]) => unknown;
type Class = new (...args: never[]) => unknown;

export interface RuntimeRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: unknown;
  rawBody: Buffer | undefined;
  ip: string | undefined;
  params: Record<string, string | undefined>;
  query: Record<string, string | string[]>;
  cookies: Record<string, string | undefined>;
  routeOptions: { url: string | undefined };
  [attached: string]: unknown;
}

/** The parts of a Fastify reply this codebase uses. */
export class RuntimeReply {
  statusCode = 200;
  sent = false;
  private payload: unknown;
  private readonly headers = new Map<string, string>();
  private readonly cookies: string[] = [];
  private readonly started = performance.now();

  /** Milliseconds since the request arrived, as Fastify's `reply.elapsedTime`. */
  get elapsedTime(): number {
    return performance.now() - this.started;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  code(code: number): this {
    return this.status(code);
  }

  header(name: string, value: string): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  getHeader(name: string): string | undefined {
    return this.headers.get(name.toLowerCase());
  }

  setCookie(name: string, value: string, options: SerializeOptions = {}): this {
    this.cookies.push(serializeCookie(name, value, options));
    return this;
  }

  clearCookie(name: string, options: SerializeOptions = {}): this {
    return this.setCookie(name, '', { ...options, expires: new Date(0) });
  }

  send(payload?: unknown): this {
    this.payload = payload;
    this.sent = true;
    return this;
  }

  toResponse(method: string): Response {
    const headers = new Headers();
    for (const [name, value] of this.headers) headers.set(name, value);
    for (const cookie of this.cookies) headers.append('set-cookie', cookie);
    let body: ConstructorParameters<typeof Response>[0] = null;
    const payload = this.payload;
    if (payload === undefined || payload === null) {
      body = null;
    } else if (typeof payload === 'string') {
      if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
      body = payload;
    } else if (payload instanceof Uint8Array) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
      body = payload;
    } else {
      if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
      body = JSON.stringify(payload);
    }
    if (method === 'HEAD') body = null;
    return new Response(body, { status: this.statusCode, headers });
  }
}

export interface ExecutionContextLike {
  getType(): 'http';
  getClass(): Class;
  getHandler(): Handler;
  getArgs(): unknown[];
  getArgByIndex(index: number): unknown;
  switchToHttp(): { getRequest(): RuntimeRequest; getResponse(): RuntimeReply; getNext(): undefined };
}

interface Guard {
  canActivate(context: ExecutionContextLike): boolean | Promise<boolean> | Observable<boolean>;
}
interface Interceptor {
  intercept(context: ExecutionContextLike, next: { handle(): Observable<unknown> }): Observable<unknown> | Promise<Observable<unknown>>;
}
export interface ExceptionFilterLike {
  catch(exception: unknown, host: ExecutionContextLike): void;
}
type ResponseHook = (request: RuntimeRequest, reply: RuntimeReply) => void;

/** Hooks that see every finished request, as Fastify's `onResponse` did (request metrics). */
export class RuntimeAdapterHost {
  readonly hooks: ResponseHook[] = [];

  onResponse(hook: ResponseHook): void {
    this.hooks.push(hook);
  }
}

interface Route {
  controller: Class;
  instance: object;
  handler: Handler;
  url: string;
  status: number;
  args: Array<{ index: number; resolve: (ctx: ExecutionContextLike) => unknown }>;
}

const METHOD_NAMES: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
};

function joinPath(...parts: Array<string | undefined>): string {
  const joined = parts
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p !== '')
    .join('/');
  return `/${joined}`;
}

/** A route path in NestJS metadata: one string, several, or none. */
function paths(value: unknown): Array<string | undefined> {
  if (Array.isArray(value)) return value as string[];
  return [typeof value === 'string' ? value : undefined];
}

function routeArguments(controller: Class, handlerName: string): Route['args'] {
  const metadata = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, handlerName) ?? {}) as Record<
    string,
    { index: number; data?: unknown; factory?: (data: unknown, ctx: ExecutionContextLike) => unknown }
  >;
  return Object.entries(metadata).map(([key, meta]) => {
    const data = meta.data;
    if (key.includes(CUSTOM_ROUTE_ARGS_METADATA)) {
      const factory = meta.factory!;
      return { index: meta.index, resolve: (ctx) => factory(data, ctx) };
    }
    const type = Number(key.split(':')[0]) as RouteParamtypes;
    const pick = (source: Record<string, unknown> | undefined): unknown =>
      typeof data === 'string' ? source?.[type === RouteParamtypes.HEADERS ? data.toLowerCase() : data] : source;
    const http = (ctx: ExecutionContextLike) => ctx.switchToHttp();
    switch (type) {
      case RouteParamtypes.REQUEST:
        return { index: meta.index, resolve: (ctx) => http(ctx).getRequest() };
      case RouteParamtypes.RESPONSE:
        return { index: meta.index, resolve: (ctx) => http(ctx).getResponse() };
      case RouteParamtypes.BODY:
        return { index: meta.index, resolve: (ctx) => pick(http(ctx).getRequest().body as Record<string, unknown>) };
      case RouteParamtypes.QUERY:
        return { index: meta.index, resolve: (ctx) => pick(http(ctx).getRequest().query) };
      case RouteParamtypes.PARAM:
        return { index: meta.index, resolve: (ctx) => pick(http(ctx).getRequest().params) };
      case RouteParamtypes.HEADERS:
        return { index: meta.index, resolve: (ctx) => pick(http(ctx).getRequest().headers) };
      case RouteParamtypes.IP:
        return { index: meta.index, resolve: (ctx) => http(ctx).getRequest().ip };
      case RouteParamtypes.RAW_BODY:
        return { index: meta.index, resolve: (ctx) => http(ctx).getRequest().rawBody };
      default:
        throw new Error(`${controller.name}.${handlerName}: unsupported parameter decorator ${RouteParamtypes[type]}`);
    }
  });
}

/** Every handler the controllers declare, as `find-my-way` routes under the global prefix. */
function buildRouter(container: Container): FindMyWay.Instance<HTTPVersion.V1> {
  const router = FindMyWay<HTTPVersion.V1>();
  for (const controller of container.controllers) {
    const instance = container.get<object>(controller);
    const bases = paths(Reflect.getMetadata(PATH_METADATA, controller));
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const handler = proto[name];
      if (typeof handler !== 'function') continue;
      const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (requestMethod === undefined) continue;
      const method = METHOD_NAMES[requestMethod];
      if (!method) throw new Error(`${controller.name}.${name}: unsupported method ${RequestMethod[requestMethod]}`);
      const args = routeArguments(controller, name);
      // A handler that owns the reply (`@Res()` without passthrough) would bypass the result handling below.
      const ownsReply = Object.keys(Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) ?? {}).some(
        (key) => !key.includes(CUSTOM_ROUTE_ARGS_METADATA) && Number(key.split(':')[0]) === RouteParamtypes.RESPONSE,
      );
      if (ownsReply && Reflect.getMetadata(RESPONSE_PASSTHROUGH_METADATA, controller, name) !== true) {
        throw new Error(`${controller.name}.${name}: @Res() without passthrough is not supported`);
      }
      const status = (Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined) ?? (method === 'POST' ? 201 : 200);
      for (const base of bases) {
        for (const path of paths(Reflect.getMetadata(PATH_METADATA, handler))) {
          const url = joinPath(GLOBAL_PREFIX, base, path);
          const route: Route = { controller, instance, handler: handler as Handler, url, status, args };
          try {
            router.on(method as FindMyWay.HTTPMethod, url, () => undefined, route);
          } catch (err) {
            throw new Error(`${controller.name}.${name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
  }
  return router;
}

function headerRecord(headers: Headers): Record<string, string | undefined> {
  const record: Record<string, string | undefined> = {};
  headers.forEach((value, name) => {
    record[name] = name in record ? `${record[name]}, ${value}` : value;
  });
  return record;
}

/** Fastify's content parsing: JSON and plain text only, 1 MiB, an empty JSON body refused. */
async function readBody(request: Request, target: RuntimeRequest): Promise<void> {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > BODY_LIMIT) throw new PayloadTooLargeException('Request body is too large');
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.byteLength > BODY_LIMIT) throw new PayloadTooLargeException('Request body is too large');
  const contentType = request.headers.get('content-type');
  if (!contentType) {
    if (bytes.byteLength > 0) throw new UnsupportedMediaTypeException(`Unsupported Media Type`);
    return;
  }
  const mediaType = contentType.split(';')[0]!.trim().toLowerCase();
  if (mediaType === 'application/json') {
    if (bytes.byteLength === 0) throw new BadRequestException("Body cannot be empty when content-type is set to 'application/json'");
    target.rawBody = bytes;
    try {
      target.body = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new BadRequestException('Body is not valid JSON');
    }
    return;
  }
  if (mediaType === 'text/plain') {
    target.rawBody = bytes;
    target.body = bytes.toString('utf8');
    return;
  }
  throw new UnsupportedMediaTypeException(`Unsupported Media Type: ${mediaType}`);
}

function toPromise<T>(value: T | Promise<T> | Observable<T>): Promise<T> {
  return isObservable(value) ? lastValueFrom(value) : Promise.resolve(value);
}

export interface HttpOptions {
  filter: ExceptionFilterLike;
  adapterHost: RuntimeAdapterHost;
  /** `TRUST_PROXY`: which hops may name the client in `X-Forwarded-For`. */
  trustProxy: string;
}

export interface RequestInfo {
  /** The peer that opened the connection; absent behind a Worker, where the edge names the client. */
  remoteAddress?: string | undefined;
}

export type FetchHandler = (request: Request, info?: RequestInfo) => Promise<Response>;

export function createHttpHandler(container: Container, options: HttpOptions): FetchHandler {
  const router = buildRouter(container);
  const guards = container.getAll<Guard>(APP_GUARD);
  const interceptors = container.getAll<Interceptor>(APP_INTERCEPTOR);
  const trust = clientAddress.compile(options.trustProxy);

  return async (request, info = {}) => {
    const url = new URL(request.url);
    const headers = headerRecord(request.headers);
    const incoming = headers['x-correlation-id'];
    const correlationId = incoming && CORRELATION_ID.test(incoming) ? incoming : uuidv7();
    headers['x-correlation-id'] = correlationId;

    const req: RuntimeRequest = {
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers,
      body: undefined,
      rawBody: undefined,
      ip: clientAddress(info.remoteAddress, headers['x-forwarded-for'], trust),
      params: {},
      query: parseQuery(url.search.slice(1)) as Record<string, string | string[]>,
      cookies: headers['cookie'] ? parseCookies(headers['cookie']) : {},
      routeOptions: { url: undefined },
    };
    const reply = new RuntimeReply();
    let route: Route | undefined;
    const context: ExecutionContextLike = {
      getType: () => 'http',
      getClass: () => route!.controller,
      getHandler: () => route!.handler,
      getArgs: () => [req, reply],
      getArgByIndex: (index) => [req, reply][index],
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply, getNext: () => undefined }),
    };

    return withCorrelation({ correlationId }, async () => {
      try {
        const match = router.find(request.method as FindMyWay.HTTPMethod, url.pathname);
        if (!match) throw new NotFoundException(`Cannot ${request.method} ${req.url}`);
        route = match.store as Route;
        req.params = match.params;
        req.routeOptions = { url: route.url };
        await readBody(request, req);

        for (const guard of guards) {
          if (!(await toPromise(guard.canActivate(context)))) throw new ForbiddenException('Forbidden resource');
        }
        const current = route;
        // Interceptors wrap the handler in declaration order, the first outermost.
        const chain = interceptors.reduceRight<() => Promise<unknown>>(
          (next, interceptor) => async () =>
            lastValueFrom(await interceptor.intercept(context, { handle: () => from(next()) }), { defaultValue: undefined }),
          async () => {
            const args: unknown[] = [];
            for (const arg of current.args) args[arg.index] = arg.resolve(context);
            return current.handler.apply(current.instance, args);
          },
        );
        const result = await chain();
        if (!reply.sent) reply.status(current.status).send(result);
      } catch (exception) {
        options.filter.catch(exception, context);
      }
      for (const hook of options.adapterHost.hooks) hook(req, reply);
      return reply.toResponse(request.method);
    });
  };
}
