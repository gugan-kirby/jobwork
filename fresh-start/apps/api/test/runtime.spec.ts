import 'reflect-metadata';
import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Optional,
  Param,
  Post,
  Query,
  Req,
  Res,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { APP_GUARD, Container, MissingProviderError } from '../src/runtime/container';
import { createHttpHandler, RuntimeAdapterHost, type ExceptionFilterLike, type RuntimeReply, type RuntimeRequest } from '../src/runtime/http';

const TOKEN = Symbol('token');
const calls: string[] = [];

@Injectable()
class Clock {
  now(): string {
    return 'tick';
  }
}

@Injectable()
class Greeter {
  constructor(
    readonly clock: Clock,
    @Inject(TOKEN) readonly label: string,
    @Optional() @Inject('absent') readonly absent?: unknown,
  ) {}
  onModuleInit(): void {
    calls.push('init');
  }
}

@Injectable()
class FirstGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    calls.push('first');
    const request = context.switchToHttp().getRequest<RuntimeRequest>();
    return request.headers['x-deny'] !== 'first';
  }
}

@Injectable()
class SecondGuard implements CanActivate {
  canActivate(): boolean {
    calls.push('second');
    return true;
  }
}

@Controller('things')
class ThingsController {
  constructor(private readonly greeter: Greeter) {}

  @Get('mine')
  mine(): unknown {
    return { route: 'static', label: this.greeter.label };
  }

  @Get(':id')
  one(@Param('id') id: string, @Query() query: Record<string, unknown>): unknown {
    return { route: 'param', id, query };
  }

  @Post()
  create(@Req() request: RuntimeRequest): unknown {
    return { body: request.body };
  }

  @Post('quiet')
  @HttpCode(204)
  quiet(): void {}

  @Post('cookie')
  cookie(@Res({ passthrough: true }) reply: RuntimeReply): unknown {
    reply.setCookie('jw', 'value', { path: '/', httpOnly: true });
    return { ok: true };
  }
}

@Module({ providers: [Clock], exports: [Clock] })
class ClockModule {}

@Module({
  imports: [ClockModule],
  controllers: [ThingsController],
  providers: [
    Greeter,
    { provide: TOKEN, useFactory: (clock: Clock) => `label-${clock.now()}`, inject: [Clock] },
    { provide: APP_GUARD, useClass: FirstGuard },
    { provide: APP_GUARD, useClass: SecondGuard },
  ],
})
class RootModule {}

const filter: ExceptionFilterLike = {
  catch(exception, host) {
    const status = typeof exception === 'object' && exception !== null && 'getStatus' in exception ? (exception as { getStatus(): number }).getStatus() : 500;
    host.switchToHttp().getResponse().status(status).send({ status, message: (exception as Error).message });
  },
};

async function boot(): Promise<{ container: Container; fetch: (path: string, init?: RequestInit) => Promise<Response> }> {
  const container = new Container(RootModule as never);
  container.instantiateAll();
  await container.init();
  const handle = createHttpHandler(container, { filter, adapterHost: new RuntimeAdapterHost(), trustProxy: 'loopback' });
  return { container, fetch: (path, init) => handle(new Request(`http://api.test${path}`, init), { remoteAddress: '127.0.0.1' }) };
}

describe('metadata runtime: container (F-CW.2)', () => {
  it('builds classes, factories, @Inject tokens and @Optional parameters, and runs onModuleInit', async () => {
    calls.length = 0;
    const { container } = await boot();
    const greeter = container.get(Greeter);
    expect(greeter.clock).toBe(container.get(Clock));
    expect(greeter.label).toBe('label-tick');
    expect(greeter.absent).toBeUndefined();
    expect(calls).toEqual(['init']);
  });

  it('names the class and path when a dependency is missing', () => {
    @Injectable()
    class Lonely {
      constructor(readonly clock: Clock) {}
    }
    @Module({ providers: [Lonely] })
    class Broken {}
    const container = new Container(Broken as never);
    expect(() => container.instantiateAll()).toThrow(MissingProviderError);
    expect(() => container.instantiateAll()).toThrow(/no provider for Clock \(needed by Lonely\)/);
  });
});

describe('metadata runtime: http (F-CW.2)', () => {
  it('prefers a static segment over a parameter, as Fastify does', async () => {
    const { fetch } = await boot();
    expect(await (await fetch('/api/v1/things/mine')).json()).toEqual({ route: 'static', label: 'label-tick' });
    expect(await (await fetch('/api/v1/things/42?a=1&a=2')).json()).toEqual({ route: 'param', id: '42', query: { a: ['1', '2'] } });
  });

  it('runs global guards in declaration order and refuses when one says no', async () => {
    const { fetch } = await boot();
    calls.length = 0;
    expect((await fetch('/api/v1/things/mine')).status).toBe(200);
    expect(calls).toEqual(['first', 'second']);
    calls.length = 0;
    const refused = await fetch('/api/v1/things/mine', { headers: { 'x-deny': 'first' } });
    expect(refused.status).toBe(403);
    expect(calls).toEqual(['first']);
  });

  it('answers POST with 201 by default, honours @HttpCode, and parses JSON', async () => {
    const { fetch } = await boot();
    const created = await fetch('/api/v1/things', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"bracket"}' });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ body: { name: 'bracket' } });
    const quiet = await fetch('/api/v1/things/quiet', { method: 'POST' });
    expect(quiet.status).toBe(204);
    expect(await quiet.text()).toBe('');
  });

  it('refuses malformed JSON and an empty JSON body with 400', async () => {
    const { fetch } = await boot();
    const json = { 'content-type': 'application/json' };
    expect((await fetch('/api/v1/things', { method: 'POST', headers: json, body: '{nope' })).status).toBe(400);
    expect((await fetch('/api/v1/things', { method: 'POST', headers: json, body: '' })).status).toBe(400);
  });

  it('sets cookies through a passthrough reply', async () => {
    const { fetch } = await boot();
    const res = await fetch('/api/v1/things/cookie', { method: 'POST' });
    expect(res.headers.get('set-cookie')).toBe('jw=value; Path=/; HttpOnly');
  });

  it('sends an unmatched route through the filter as NestJS did', async () => {
    const { fetch } = await boot();
    const res = await fetch('/api/v1/nowhere');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ status: 404, message: 'Cannot GET /api/v1/nowhere' });
  });
});
