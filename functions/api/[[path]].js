/**
 * Cloudflare Pages Functions catch-all.
 * Forwards /api/* requests to the shared Worker handler.
 * Use this only when deploying as a Pages project (Build output: public).
 */
import apiWorker from '../../worker/src/index.js';

export async function onRequest(context) {
  return apiWorker.fetch(context.request, context.env);
}
