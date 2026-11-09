import 'reflect-metadata';

type Target = object;

/**
 * Reads decorator metadata off a handler and its controller: the one `Reflector` call
 * this codebase makes, without loading `@nestjs/core` (F-CW.2).
 */
export class Reflector {
  /** The first target (handler before class) that declares `key` wins, as in NestJS. */
  getAllAndOverride<T>(key: string | symbol, targets: Target[]): T | undefined {
    for (const target of targets) {
      const value = Reflect.getMetadata(key, target) as T | undefined;
      if (value !== undefined) return value;
    }
    return undefined;
  }
}
