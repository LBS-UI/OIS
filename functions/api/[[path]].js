import apiWorker from '../../worker/src/index.js';

// Cloudflare Pages Functions catch-all: routes /api/* requests to the API handler.
export async function onRequest(context) {
  return apiWorker.fetch(context.request, context.env);
}
