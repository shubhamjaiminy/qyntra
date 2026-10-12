/**
 * Qyntra Cloud server.
 *
 *   QYNTRA_CLOUD_URL     public base URL, e.g. https://app.qyntra.dev (required in production)
 *   QYNTRA_CLOUD_SECRET  32+ random characters; signs CSRF tokens (required in production)
 *   QYNTRA_CLOUD_DB      SQLite file (default ./data/qyntra-cloud.db)
 *   PORT                 default 8080
 *
 *   npm run cloud        start it locally
 */

import http from 'http';

import { accountRoutes } from './account';
import { apiRoutes, type ApiContext } from './api';
import { extendWithBilling } from './billing';
import { featureRoutes } from './features';
import { integrationRoutes, integrations } from './integrations';
import { Store } from './db';
import { html, htmlResponse, HttpError, jsonResponse, readRequest, redirect, Router, writeResponse, type Response } from './http';
import { publicRoutes } from './public';
import { CSS, layout } from './views';
import { Redirect, webRoutes } from './web';

export interface CloudOptions {
  store: Store;
  baseUrl: string;
  secret: string;
  /** After a run is stored. Default: Slack alerts. */
  onRun?: ApiContext['onRun'];
}

export function createCloudServer(options: CloudOptions): http.Server {
  const router = new Router();
  const secure = options.baseUrl.startsWith('https://');
  const api: ApiContext = { store: options.store, baseUrl: options.baseUrl, onRun: options.onRun ?? integrations(options.store).onRun };
  const web = { store: options.store, secret: options.secret, baseUrl: options.baseUrl, secure };

  router.get('/static/app.css', () => ({ status: 200, headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' }, body: CSS }));
  router.get('/healthz', () => jsonResponse({ ok: true }));

  publicRoutes(router, { baseUrl: options.baseUrl });
  apiRoutes(router, api);
  webRoutes(router, web);
  featureRoutes(router, web, api);
  integrationRoutes(router, web);
  extendWithBilling(router, web);
  accountRoutes(router, web);

  return http.createServer(async (incoming, outgoing) => {
    let response: Response;
    const isApi = (incoming.url ?? '').startsWith('/v1/');

    try {
      const request = await readRequest(incoming);
      const handler = router.match(request);

      if (handler === 'method-not-allowed') throw new HttpError(405, 'Method not allowed.');
      if (!handler) throw new HttpError(404, 'Not found.');

      response = await handler(request);
    } catch (error) {
      if (error instanceof Redirect) {
        response = redirect(error.location);
      } else {
        const status = error instanceof HttpError ? error.status : 500;
        const message = error instanceof HttpError ? error.message : 'Something went wrong on our side. It has been logged.';

        if (!(error instanceof HttpError)) {
          console.error(new Date().toISOString(), incoming.method, incoming.url, error);
        }

        response = isApi
          ? jsonResponse({ error: message }, status)
          : htmlResponse(layout({ title: `${status}` }, html`<div class="card" style="max-width:560px;margin:3rem auto"><h1>${status === 404 ? 'Not found' : 'Something is wrong'}</h1><p>${message}</p><p><a href="/app">Back to Qyntra</a></p></div>`), status);
      }
    }

    // HTTPS only, for a year, once served over HTTPS.
    if (secure) response.headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';

    writeResponse(outgoing, incoming.method === 'HEAD' ? { ...response, body: '' } : response);
  });
}

/** Production entry point. */
export async function main(): Promise<void> {
  const baseUrl = (process.env.QYNTRA_CLOUD_URL ?? `http://localhost:${process.env.PORT ?? 8080}`).replace(/\/+$/, '');
  const secret = process.env.QYNTRA_CLOUD_SECRET ?? '';
  const production = baseUrl.startsWith('https://');

  if (production && secret.length < 32) {
    throw new Error('QYNTRA_CLOUD_SECRET must be set to at least 32 random characters in production.');
  }

  const store = new Store(process.env.QYNTRA_CLOUD_DB ?? 'data/qyntra-cloud.db');


  const server = createCloudServer({ store, baseUrl, secret: secret || 'development-only-secret-not-for-production-use' });

  // Retention runs daily; the first sweep a minute after start.
  const sweep = () => {
    try {
      const removed = store.applyRetention();
      if (removed > 0) console.log(`${new Date().toISOString()} retention: removed ${removed} run(s)`);
    } catch (error) {
      console.error('retention failed', error);
    }
  };
  setTimeout(sweep, 60_000).unref();
  setInterval(sweep, 24 * 3_600_000).unref();

  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => console.log(`Qyntra Cloud on ${baseUrl} (port ${port})${production ? '' : ' — development mode'}`));

  const stop = () => server.close(() => {
    store.close();
    process.exit(0);
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
