// This web app as a Cloudflare Worker (F-CW.6, ADR-0009). `/api/*` goes to the API Worker
// through its service binding, as the Node rewrite proxy sent it to the API; everything
// else is the Next.js app OpenNext builds into .open-next/ (`opennextjs-cloudflare build`).
import { forwardToApi, isApiRequest } from '@jobwork/web-kit/edge';
import nextApp from './.open-next/worker.js';

export default {
  fetch(request, env, ctx) {
    if (isApiRequest(new URL(request.url))) return forwardToApi(request, env.API);
    return nextApp.fetch(request, env, ctx);
  },
};
