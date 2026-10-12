/**
 * Read-only guard for exploring and testing a customer's application.
 *
 * Feature exploration clicks buttons it has never seen, and AI-written
 * tests can do things nobody reviewed. On a shared environment, one
 * accidental "Delete" or "Save" changes data other people depend on. So
 * read-only is enforced where it cannot be talked around: at the
 * network. Every request the browser makes passes through this check,
 * and anything that writes is aborted before it leaves the machine.
 *
 *   GET / HEAD / OPTIONS            allowed
 *   GraphQL query (POST)            allowed — GraphQL reads are POSTs
 *   GraphQL mutation                blocked
 *   Other POST / PUT / PATCH / DELETE  blocked, unless the host is an
 *                                   identity provider refreshing the
 *                                   session (blocking that logs out)
 *
 * The function is self-contained on purpose: generated tests embed its
 * source (`toString()`) so they enforce exactly the same rule without
 * importing Qyntra.
 */

export function isWriteRequest(
  method: string,
  url: string,
  postData: string | null | undefined
): boolean {
  const verb = method.toUpperCase();

  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') {
    return false;
  }

  let host = '';

  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }

  // Session upkeep, not application data. Firebase refreshes its ID
  // token by POST; blocking it ends the session mid-run.
  const identityHosts = [
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    'oauth2.googleapis.com',
  ];
  const identitySuffixes = ['.okta.com', '.auth0.com', '.onelogin.com', '.clerk.accounts.dev'];

  if (identityHosts.includes(host) || identitySuffixes.some((suffix) => host.endsWith(suffix))) {
    return false;
  }

  if (verb !== 'POST' || !postData) {
    return true;
  }

  // GraphQL: a JSON body with a `query` string, or a batch of them.
  try {
    const body = JSON.parse(postData);
    const operations = Array.isArray(body) ? body : [body];

    const isGraphQL = operations.every(
      (operation) => operation && typeof operation === 'object' && typeof operation.query === 'string'
    );

    if (!isGraphQL) {
      return true;
    }

    // Only the keyword that opens each operation counts: a field
    // called `subscription` inside a query is still a read. Words are
    // collected at brace depth 0, after comments and strings are gone.
    return operations.some((operation) => {
      const source = String(operation.query)
        .replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"/g, '""')
        .replace(/#[^\n]*/g, '');

      let depth = 0;
      let topLevel = '';

      for (const char of source) {
        if (char === '{') depth += 1;
        else if (char === '}') depth = Math.max(0, depth - 1);
        else if (depth === 0) topLevel += char;
      }

      return /\b(mutation|subscription)\b/.test(topLevel.replace(/\([^)]*\)/g, ' '));
    });
  } catch {
    return true;
  }
}
