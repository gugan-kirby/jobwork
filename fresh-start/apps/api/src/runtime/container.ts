import 'reflect-metadata';
import {
  MODULE_METADATA,
  OPTIONAL_DEPS_METADATA,
  PARAMTYPES_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from '@nestjs/common/constants';

/**
 * The object graph the `@Module` declarations describe, built without NestJS's bootstrap
 * (F-CW.2, ADR-0009). A Worker must be ready inside its startup budget and answer inside
 * 10 ms of CPU, so construction is synchronous and happens once per isolate.
 *
 * Every provider is a singleton visible to every module. NestJS scopes providers by
 * module exports; this codebase never provides one token twice, so one namespace
 * resolves exactly what NestJS resolved.
 */

export type Token = string | symbol | (abstract new (...args: never[]) => unknown);
type Class = new (...args: unknown[]) => unknown;

/** The multi-providers NestJS collects across modules (`@nestjs/core` `APP_GUARD`, `APP_INTERCEPTOR`). */
export const APP_GUARD = 'APP_GUARD';
export const APP_INTERCEPTOR = 'APP_INTERCEPTOR';
const MULTI = new Set<string>([APP_GUARD, APP_INTERCEPTOR]);

type ProviderDef =
  | { kind: 'class'; useClass: Class }
  | { kind: 'existing'; useExisting: Token }
  | { kind: 'factory'; useFactory: (...args: unknown[]) => unknown; inject: Token[] }
  | { kind: 'value'; useValue: unknown };

interface LifecycleHooks {
  onModuleInit?(): unknown;
  onApplicationBootstrap?(): unknown;
  onModuleDestroy?(): unknown;
  onApplicationShutdown?(): unknown;
}

export class MissingProviderError extends Error {
  constructor(token: Token, path: readonly string[]) {
    super(`no provider for ${tokenName(token)}${path.length ? ` (needed by ${path.join(' → ')})` : ''}`);
    this.name = 'MissingProviderError';
  }
}

function tokenName(token: Token): string {
  return typeof token === 'function' ? token.name : String(token);
}

function isClass(value: unknown): value is Class {
  return typeof value === 'function';
}

export class Container {
  private readonly defs = new Map<Token, ProviderDef>();
  private readonly multi = new Map<string, ProviderDef[]>();
  private readonly instances = new Map<Token, unknown>();
  private readonly multiInstances = new Map<string, unknown[]>();
  private readonly order: unknown[] = [];
  readonly controllers: Class[] = [];

  constructor(root: Class, values: ReadonlyMap<Token, unknown> = new Map()) {
    for (const [token, value] of values) this.instances.set(token, value);
    this.collect(root, new Set());
  }

  /** Builds every provider and controller now, so a wiring defect fails the start, not a request. */
  instantiateAll(): void {
    for (const token of this.defs.keys()) this.get(token);
    for (const key of this.multi.keys()) this.getAll(key);
    for (const controller of this.controllers) this.get(controller);
  }

  get<T>(token: abstract new (...args: never[]) => T): T;
  get<T = unknown>(token: Token): T;
  get(token: Token): unknown {
    return this.resolve(token, []);
  }

  /** The instances behind a multi-provider token, in declaration order. */
  getAll<T>(key: string): T[] {
    let list = this.multiInstances.get(key);
    if (!list) {
      list = (this.multi.get(key) ?? []).map((def) => this.build(def, [key]));
      this.multiInstances.set(key, list);
    }
    return list as T[];
  }

  async init(): Promise<void> {
    for (const instance of this.order) await (instance as LifecycleHooks).onModuleInit?.();
    for (const instance of this.order) await (instance as LifecycleHooks).onApplicationBootstrap?.();
  }

  async close(): Promise<void> {
    for (const instance of [...this.order].reverse()) await (instance as LifecycleHooks).onModuleDestroy?.();
    for (const instance of [...this.order].reverse()) await (instance as LifecycleHooks).onApplicationShutdown?.();
  }

  private collect(module: Class, seen: Set<Class>): void {
    if (seen.has(module)) return;
    seen.add(module);
    const meta = (key: string): unknown[] => (Reflect.getMetadata(key, module) as unknown[] | undefined) ?? [];
    for (const imported of meta(MODULE_METADATA.IMPORTS)) {
      if (isClass(imported)) this.collect(imported, seen);
      else throw new Error(`dynamic module imports are not supported (${module.name})`);
    }
    for (const provider of meta(MODULE_METADATA.PROVIDERS)) this.register(provider, module);
    for (const controller of meta(MODULE_METADATA.CONTROLLERS)) this.controllers.push(controller as Class);
  }

  private register(provider: unknown, module: Class): void {
    if (isClass(provider)) {
      this.add(provider, { kind: 'class', useClass: provider });
      return;
    }
    const p = provider as {
      provide: Token;
      useClass?: Class;
      useExisting?: Token;
      useFactory?: (...args: unknown[]) => unknown;
      inject?: Token[];
      useValue?: unknown;
    };
    if (p.useClass) this.add(p.provide, { kind: 'class', useClass: p.useClass });
    else if (p.useExisting) this.add(p.provide, { kind: 'existing', useExisting: p.useExisting });
    else if (p.useFactory) this.add(p.provide, { kind: 'factory', useFactory: p.useFactory, inject: p.inject ?? [] });
    else if ('useValue' in p) this.add(p.provide, { kind: 'value', useValue: p.useValue });
    else throw new Error(`unsupported provider for ${tokenName(p.provide)} in ${module.name}`);
  }

  private add(token: Token, def: ProviderDef): void {
    if (typeof token === 'string' && MULTI.has(token)) {
      this.multi.set(token, [...(this.multi.get(token) ?? []), def]);
      return;
    }
    if (this.defs.has(token)) throw new Error(`${tokenName(token)} is provided twice`);
    this.defs.set(token, def);
  }

  private resolve(token: Token, path: string[]): unknown {
    if (this.instances.has(token)) return this.instances.get(token);
    const def = this.defs.get(token) ?? (isClass(token) && this.controllers.includes(token) ? { kind: 'class' as const, useClass: token } : undefined);
    if (!def) throw new MissingProviderError(token, path);
    if (path.includes(tokenName(token))) throw new Error(`circular dependency: ${[...path, tokenName(token)].join(' → ')}`);
    const instance = this.build(def, [...path, tokenName(token)]);
    this.instances.set(token, instance);
    return instance;
  }

  private build(def: ProviderDef, path: string[]): unknown {
    switch (def.kind) {
      case 'value':
        return def.useValue;
      case 'existing':
        return this.resolve(def.useExisting, path);
      case 'factory':
        return def.useFactory(...def.inject.map((t) => this.resolve(t, path)));
      case 'class': {
        const instance = new def.useClass(...this.dependencies(def.useClass, path));
        this.order.push(instance);
        return instance;
      }
    }
  }

  private dependencies(cls: Class, path: string[]): unknown[] {
    const types = (Reflect.getMetadata(PARAMTYPES_METADATA, cls) as Token[] | undefined) ?? [];
    const declared = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, cls) as Array<{ index: number; param: Token }> | undefined) ?? [];
    const optional = new Set((Reflect.getMetadata(OPTIONAL_DEPS_METADATA, cls) as number[] | undefined) ?? []);
    const count = Math.max(types.length, cls.length);
    return Array.from({ length: count }, (_, index) => {
      const token = declared.find((d) => d.index === index)?.param ?? types[index];
      if (token === undefined || token === Object) {
        if (optional.has(index)) return undefined;
        throw new Error(`${cls.name} parameter ${index} has no injectable type`);
      }
      try {
        return this.resolve(token, path);
      } catch (err) {
        if (optional.has(index) && err instanceof MissingProviderError) return undefined;
        throw err;
      }
    });
  }
}
