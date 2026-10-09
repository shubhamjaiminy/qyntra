/**
 * A tiny application behind a form login, for testing Qyntra's
 * authentication end to end without depending on a public demo site.
 *
 *   GET  /login        form: #email, #password, button[type=submit]
 *   POST /login        good credentials → session cookie → /dashboard;
 *                      bad → the form again with "Invalid email or password"
 *   GET  /dashboard    needs the session; [data-testid="dashboard"]
 *   GET  /api/me       needs the session; JSON, else 401
 *   GET  /logout       clears the session
 */

import http from 'http';
import { randomBytes } from 'crypto';
import type { AddressInfo } from 'net';

export const LOGIN_EMAIL = 'qa@acme.example';
export const LOGIN_PASSWORD = 'correct horse battery staple';

const page = (title: string, body: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body>${body}</body></html>`;

function loginForm(error = ''): string {
  return page(
    'Sign in · Acme',
    `<h1>Sign in</h1>
     ${error ? `<p role="alert" class="error">${error}</p>` : ''}
     <form method="post" action="/login">
       <label>Email <input id="email" name="email" type="email"></label>
       <label>Password <input id="password" name="password" type="password"></label>
       <button type="submit">Sign in</button>
     </form>`
  );
}

export interface LoginApp {
  url: string;
  close: () => Promise<void>;
}

export async function startLoginApp(
  /** insecureApi: /api/me forgets to check the session — a real-world bug. */
  options: { insecureApi?: boolean } = {}
): Promise<LoginApp> {
  const sessions = new Set<string>();

  const sessionOf = (request: http.IncomingMessage) => {
    const match = /(?:^|;\s*)session=([a-f0-9]+)/.exec(request.headers.cookie ?? '');
    return match && sessions.has(match[1]) ? match[1] : undefined;
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      response.end(body);
    };

    if (url.pathname === '/login' && request.method === 'POST') {
      let raw = '';
      request.on('data', (chunk) => (raw += chunk));
      request.on('end', () => {
        const form = new URLSearchParams(raw);

        if (form.get('email') === LOGIN_EMAIL && form.get('password') === LOGIN_PASSWORD) {
          const id = randomBytes(16).toString('hex');
          sessions.add(id);
          send(303, '', { location: '/dashboard', 'set-cookie': `session=${id}; HttpOnly; Path=/; SameSite=Lax` });
        } else {
          send(200, loginForm('Invalid email or password'));
        }
      });
      return;
    }

    if (url.pathname === '/login') {
      return send(200, loginForm());
    }

    // A login page whose blocking script never arrives.
    if (url.pathname === '/hang') {
      return send(200, page('Sign in', '<script src="/never.js"></script>' + loginForm()));
    }

    if (url.pathname === '/never.js') {
      return; // never answer
    }

    if (url.pathname === '/logout') {
      const id = sessionOf(request);
      if (id) sessions.delete(id);
      return send(303, '', { location: '/login', 'set-cookie': 'session=; Path=/; Max-Age=0' });
    }

    if (url.pathname === '/api/me') {
      if (!sessionOf(request) && !options.insecureApi) {
        response.writeHead(401, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ error: 'unauthenticated' }));
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ email: LOGIN_EMAIL, name: 'QA Bot', plan: 'team', seats: 5 }));
    }

    if (url.pathname === '/dashboard' || url.pathname === '/') {
      if (!sessionOf(request)) {
        return send(303, '', { location: '/login' });
      }

      return send(
        200,
        page(
          'Dashboard · Acme',
          `<h1 data-testid="dashboard">Welcome back</h1>
           <p id="who">Loading…</p>
           <a href="/logout">Sign out</a>
           <script>
             fetch('/api/me').then((r) => r.json()).then((me) => {
               document.getElementById('who').textContent = 'Signed in as ' + me.name;
             });
           </script>`
        )
      );
    }

    send(404, page('Not found', '<h1>Not found</h1>'));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        // Hung requests (/never.js) would keep close() waiting forever.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
