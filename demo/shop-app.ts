/**
 * Acme Shop: the application in the live demo.
 *
 * Three modes, switched while the server runs (`npm run demo:mode`), so
 * a demo can move from act to act without a restart:
 *
 *   healthy    everything works.
 *   ui-change  a developer renamed the Add-to-cart buttons. The product
 *              still works; the team's test is now stale (a test defect).
 *   bug        the cart total counts only the last item added (a real
 *              product defect).
 *
 * Planted defects in the Discount Rules admin page, which is built like a
 * real back-office feature (table, search, filter, form) so it can serve
 * as a benchmark with a known right answer for `qyntra feature`:
 *
 *   search-bug      the search box filters nothing.
 *   filter-bug      the status filter shows the opposite status.
 *   validation-bug  the form accepts any discount, e.g. 150%.
 *
 * The mode lives in demo/.demo-mode and is read on every request.
 */

import fs from 'fs';
import http from 'http';
import path from 'path';

export const DEMO_PORT = Number(process.env.DEMO_PORT ?? 4173);

export const DEMO_MODES = ['healthy', 'ui-change', 'bug', 'search-bug', 'filter-bug', 'validation-bug'] as const;

export type DemoMode = (typeof DEMO_MODES)[number];

// Overridable so a second instance (e.g. a benchmark on another port)
// does not share the live demo's mode.
export const MODE_FILE = process.env.DEMO_MODE_FILE ?? path.join(__dirname, '.demo-mode');

const PRODUCTS = [
  { sku: 'keyboard', name: 'Mechanical Keyboard', price: 89 },
  { sku: 'mouse', name: 'Wireless Mouse', price: 40 },
  { sku: 'monitor', name: '27" Monitor', price: 249 },
];

export function readMode(): DemoMode {
  try {
    const mode = fs.readFileSync(MODE_FILE, 'utf-8').trim();
    return (DEMO_MODES as readonly string[]).includes(mode) ? (mode as DemoMode) : 'healthy';
  } catch {
    return 'healthy';
  }
}

const layout = (title: string, body: string, script = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} · Acme Shop</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; color: #1f2937; }
  nav { display: flex; gap: 1rem; margin-bottom: 1.5rem; }
  .product { display: flex; justify-content: space-between; align-items: center;
             border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem; margin-bottom: .5rem; }
  button { background: #2563eb; color: white; border: 0; border-radius: 6px; padding: .5rem 1rem; cursor: pointer; }
  .total { font-size: 1.25rem; font-weight: 600; }
</style></head>
<body>
<nav><a href="/">Products</a><a href="/cart">Cart (<span data-testid="cart-count">0</span>)</a><a href="/admin/discount-rules">Discount Rules</a></nav>
${body}
<script>
  const cart = () => JSON.parse(localStorage.getItem('cart') || '[]');
  const save = (items) => localStorage.setItem('cart', JSON.stringify(items));
  document.querySelector('[data-testid="cart-count"]').textContent = cart().length;
  ${script}
</script>
</body></html>`;

function productsPage(mode: DemoMode): string {
  // The UI change: buttons renamed from #add-to-cart-* to #buy-*, and
  // relabelled. Nothing is broken for a user.
  const idPrefix = mode === 'ui-change' ? 'buy' : 'add-to-cart';
  const label = mode === 'ui-change' ? 'Buy now' : 'Add to cart';

  const items = PRODUCTS.map(
    (product) => `
  <div class="product">
    <div><strong>${product.name}</strong><div>$${product.price.toFixed(2)}</div></div>
    <button id="${idPrefix}-${product.sku}" data-sku="${product.sku}">${label}</button>
  </div>`
  ).join('');

  return layout(
    'Products',
    `<h1>Products</h1>${items}<p role="status" id="added"></p>`,
    `document.querySelectorAll('button[data-sku]').forEach((button) => {
       button.addEventListener('click', () => {
         const items = cart();
         items.push(button.dataset.sku);
         save(items);
         document.querySelector('[data-testid="cart-count"]').textContent = items.length;
         document.getElementById('added').textContent = 'Added to cart';
       });
     });`
  );
}

function cartPage(mode: DemoMode): string {
  const prices = Object.fromEntries(PRODUCTS.map((product) => [product.sku, product.price]));
  const names = Object.fromEntries(PRODUCTS.map((product) => [product.sku, product.name]));

  // The bug: the total is the last item's price, not the sum.
  const total =
    mode === 'bug'
      ? 'items.length ? prices[items[items.length - 1]] : 0'
      : 'items.reduce((sum, sku) => sum + prices[sku], 0)';

  return layout(
    'Cart',
    `<h1>Your cart</h1>
     <ul id="cart-items"></ul>
     <p class="total">Total: <span data-testid="cart-total"></span></p>
     <button id="checkout">Checkout</button>
     <p role="status" id="order"></p>`,
    `const prices = ${JSON.stringify(prices)};
     const names = ${JSON.stringify(names)};
     const items = cart();
     document.getElementById('cart-items').innerHTML =
       items.map((sku) => '<li>' + names[sku] + '</li>').join('') || '<li>Your cart is empty</li>';
     document.querySelector('[data-testid="cart-total"]').textContent = '$' + (${total}).toFixed(2);
     document.getElementById('checkout').addEventListener('click', () => {
       if (!items.length) return;
       save([]);
       document.getElementById('order').textContent = 'Order confirmed';
       document.querySelector('[data-testid="cart-count"]').textContent = 0;
     });`
  );
}

const DISCOUNT_RULES = [
  { name: 'Summer Sale', appliesTo: 'All products', percent: 15, active: true },
  { name: 'Keyboard Clearance', appliesTo: 'Mechanical Keyboard', percent: 30, active: false },
  { name: 'Student Discount', appliesTo: 'All products', percent: 10, active: true },
  { name: 'Monitor Bundle', appliesTo: '27" Monitor', percent: 20, active: false },
];

function discountRulesPage(mode: DemoMode): string {
  const rows = DISCOUNT_RULES.map(
    (rule) => `
      <tr data-name="${rule.name.toLowerCase()}" data-status="${rule.active ? 'active' : 'inactive'}">
        <td>${rule.name}</td><td>${rule.appliesTo}</td><td>${rule.percent}%</td>
        <td>${rule.active ? 'Active' : 'Inactive'}</td>
        <td><button aria-label="Delete ${rule.name}" class="danger">✕</button></td>
      </tr>`
  ).join('');

  // search-bug: the handler is wired up but never hides anything.
  const matchesSearch = mode === 'search-bug' ? 'true' : "row.dataset.name.includes(query)";
  // filter-bug: compares against the opposite status.
  const matchesStatus =
    mode === 'filter-bug'
      ? "status === 'all' || row.dataset.status !== status"
      : "status === 'all' || row.dataset.status === status";

  return layout(
    'Discount Rules',
    `<h1>Discount Rules</h1>
     <p>Discounts applied at checkout. Inactive rules are kept but not applied.</p>
     <div style="display:flex; gap:1rem; margin-bottom:1rem; align-items:end">
       <label>Search rules <input id="search" type="search" placeholder="Rule name"></label>
       <label>Status
         <select id="status"><option value="all">All</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
       </label>
       <a href="/admin/discount-rules/new"><button type="button">Add a New Rule</button></a>
     </div>
     <table aria-label="Discount rules">
       <thead><tr><th>Rule Name</th><th>Applies To</th><th>Discount</th><th>Status</th><th>Actions</th></tr></thead>
       <tbody>${rows}</tbody>
     </table>
     <p role="status" id="shown">${DISCOUNT_RULES.length} rules</p>`,
    `const search = document.getElementById('search');
     const statusFilter = document.getElementById('status');
     function apply() {
       const query = search.value.trim().toLowerCase();
       const status = statusFilter.value;
       let shown = 0;
       document.querySelectorAll('tbody tr').forEach((row) => {
         const visible = (${matchesSearch}) && (${matchesStatus});
         row.hidden = !visible;
         if (visible) shown += 1;
       });
       document.getElementById('shown').textContent = shown + (shown === 1 ? ' rule' : ' rules');
     }
     search.addEventListener('input', apply);
     statusFilter.addEventListener('change', apply);
     document.querySelectorAll('button.danger').forEach((button) => button.addEventListener('click', async () => {
       if (!confirm('Delete this rule?')) return;
       await fetch('/api/discount-rules', { method: 'DELETE' });
     }));`
  );
}

function newDiscountRulePage(mode: DemoMode): string {
  // validation-bug: the range check is gone; only "required" remains.
  const percentCheck =
    mode === 'validation-bug'
      ? "if (form.percent.value === '') errors.push('Discount is required');"
      : "const value = Number(form.percent.value); if (form.percent.value === '' || !(value >= 1 && value <= 90)) errors.push('Discount must be between 1 and 90');";

  return layout(
    'New Discount Rule',
    `<h1>New Discount Rule</h1>
     <form id="rule" novalidate>
       <p><label>Rule name <input name="name" id="name"></label></p>
       <p><label>Applies to
         <select name="appliesTo" id="appliesTo"><option>All products</option>${PRODUCTS.map((product) => `<option>${product.name}</option>`).join('')}</select>
       </label></p>
       <p><label>Discount (%) <input name="percent" id="percent" type="number"></label></p>
       <p><label><input name="active" type="checkbox" checked> Active</label></p>
       <ul role="alert" id="errors"></ul>
       <button type="submit">Save Rule</button>
       <a href="/admin/discount-rules">Cancel</a>
     </form>
     <p role="status" id="result"></p>`,
    `const form = document.getElementById('rule');
     form.addEventListener('submit', async (event) => {
       event.preventDefault();
       const errors = [];
       if (form.name.value.trim() === '') errors.push('Rule name is required');
       ${percentCheck}
       document.getElementById('errors').innerHTML = errors.map((error) => '<li>' + error + '</li>').join('');
       if (errors.length) return;
       try {
         const response = await fetch('/api/discount-rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: form.name.value, percent: Number(form.percent.value) }) });
         document.getElementById('result').textContent = response.ok ? 'Rule saved' : 'Could not save the rule';
       } catch {
         document.getElementById('result').textContent = 'Could not save the rule';
       }
     });`
  );
}

export function startShop(port = DEMO_PORT): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const mode = readMode();

    const pages: Record<string, () => string> = {
      '/': () => productsPage(mode),
      '/cart': () => cartPage(mode),
      '/admin/discount-rules': () => discountRulesPage(mode),
      '/admin/discount-rules/new': () => newDiscountRulePage(mode),
    };

    const html = pages[url.pathname]?.();

    if (url.pathname === '/api/discount-rules') {
      // Accepts writes so --allow-writes runs work; stores nothing.
      response.writeHead(request.method === 'GET' ? 200 : 201, { 'content-type': 'application/json' });
      response.end(JSON.stringify(request.method === 'GET' ? DISCOUNT_RULES : { ok: true }));
      return;
    }

    if (url.pathname === '/api/products') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(PRODUCTS));
      return;
    }

    response.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html ?? layout('Not found', '<h1>Not found</h1>'));
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
