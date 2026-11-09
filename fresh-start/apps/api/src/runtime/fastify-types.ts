// Controllers, guards and the filter keep their Fastify request and reply types; they are
// type-only, and the runtime's facades (`http.ts`) implement the members they use. The
// cookie members were declared by @fastify/cookie's type augmentation, kept here.
import type {} from '@fastify/cookie';
