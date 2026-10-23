/**
 * The real-world benchmark: page shapes Qyntra met on real sites, each
 * with the right answer. Rebuilt from their structure (tags, roles,
 * class names, behaviour), never from their data.
 *
 * Every entry is a lesson. When a real site fools Qyntra, add its shape
 * here with the right answer, so the mistake can never come back.
 */

export interface RealWorldPage {
  name: string;
  /** Where the shape was met, and what went wrong there, if anything. */
  origin: string;
  html: string;
  /** Probe kinds that must find a defect. Every other probe must pass. */
  defects: Array<'search' | 'filter' | 'sort' | 'pagination'>;
  /** At least this many probes must be generated: a benchmark page Qyntra cannot probe teaches nothing. */
  minProbes: number;
}

// --------------------------------------------------
// Material-UI DataTable (MUI-Datatables), as on an admin console
// --------------------------------------------------

function muiTable(options: { rules: [string, string, string, string][]; searchBug?: boolean }): string {
  const rows = options.rules
    .map(
      ([name, tours, description, status]) => `<tr class="MuiTableRow-root jss311" data-name="${name.toLowerCase()} ${tours.toLowerCase()} ${description.toLowerCase()}">
        <td class="MuiTableCell-root MuiTableCell-body jss316">${name}</td><td class="MuiTableCell-root MuiTableCell-body jss316">${tours}</td>
        <td class="MuiTableCell-root MuiTableCell-body jss316">${description}</td><td class="MuiTableCell-root MuiTableCell-body jss316">${status}</td>
        <td class="MuiTableCell-root MuiTableCell-body jss316"><button aria-label="Edit">✎</button></td></tr>`
    )
    .join('');

  return `<div class="MuiPaper-root jss101">
    <div class="MuiToolbar-root jss120" role="toolbar">
      <h6>Fee Rules</h6>
      <span id="search-slot"></span>
      <button class="MuiIconButton-root jss130" aria-label="Search" title="Search">🔍</button>
      <button class="MuiIconButton-root jss130" aria-label="View Columns">▥</button>
      <button class="MuiIconButton-root jss130" aria-label="Filter Table">⏷</button>
    </div>
    <table class="MuiTable-root jss270" role="table">
      <thead class="MuiTableHead-root jss272"><tr class="MuiTableRow-root MuiTableRow-head jss273">
        ${['Rule Name', 'Tours Assigned', 'Description', 'Status', 'Actions'].map((name) => `<th class="MuiTableCell-root MuiTableCell-head jss274 jss275">${name}</th>`).join('')}
      </tr></thead>
      <tbody class="MuiTableBody-root jss280">${rows}
        <tr class="MuiTableRow-root jss311" id="empty" hidden><td colspan="5">Sorry, no matching records found</td></tr></tbody>
    </table>
    <div class="MuiTablePagination-root jss290"><p id="count">1-${options.rules.length} of ${options.rules.length}</p></div>
  </div>
  <script>(() => {
    document.querySelector('[aria-label="Search"]').addEventListener('click', () => {
      document.getElementById('search-slot').innerHTML = '<input class="MuiInputBase-input jss140" placeholder="Search Rule">';
      const input = document.querySelector('[placeholder="Search Rule"]');
      input.focus();
      input.addEventListener('input', () => {
        ${options.searchBug ? 'return;' : ''}
        const query = input.value.trim().toLowerCase();
        let shown = 0;
        document.querySelectorAll('tbody tr[data-name]').forEach((row) => {
          const visible = row.dataset.name.includes(query);
          row.hidden = !visible;
          if (visible) shown += 1;
        });
        document.getElementById('empty').hidden = shown > 0;
        document.getElementById('count').textContent = (shown ? '1-' + shown : '0-0') + ' of ' + shown;
      });
    });
  })();</script>`;
}

const RULES: [string, string, string, string][] = [
  ['BO cancel fee', 'Admission Tickets', 'Cancel order, internal 30 or less', 'Active'],
  ['Summer surcharge', 'Safari Tour', 'Peak season surcharge', 'Active'],
  ['Group discount', 'Admission Tickets', 'Ten or more guests', 'Inactive'],
  ['Late transfer', 'Bus Tour', 'Transfer within 24 hours', 'Active'],
];

// --------------------------------------------------
// Product grid of cards with a "sort by" dropdown, as in shops
// --------------------------------------------------

function productGrid(options: { sortBug?: boolean }): string {
  const products: [string, number][] = [
    ['Sauce Labs Backpack', 29.99],
    ['Sauce Labs Bike Light', 9.99],
    ['Sauce Labs Bolt T-Shirt', 15.99],
    ['Sauce Labs Fleece Jacket', 49.99],
    ['Sauce Labs Onesie', 7.99],
    ['Test.allTheThings() T-Shirt (Red)', 15.99],
  ];

  return `<div class="header_container"><div class="app_logo">Swag Labs</div><span class="title">Products</span>
    <select class="product_sort_container" data-test="product-sort-container">
      <option value="az">Name (A to Z)</option><option value="za">Name (Z to A)</option>
      <option value="lohi">Price (low to high)</option><option value="hilo">Price (high to low)</option>
    </select></div>
  <div class="inventory_container"><div class="inventory_list">${products
    .map(
      ([name, price]) => `<div class="inventory_item"><div class="inventory_item_img"><img alt="${name}"></div>
      <div class="inventory_item_description"><div class="inventory_item_label"><a href="#"><div class="inventory_item_name">${name}</div></a>
      <div class="inventory_item_desc">carry.allTheThings() with the sleek, streamlined design.</div></div>
      <div class="pricebar"><div class="inventory_item_price">$${price.toFixed(2)}</div><button class="btn btn_primary">Add to cart</button></div></div></div>`
    )
    .join('')}</div></div>
  <script>(() => {
    const select = document.querySelector('select');
    select.addEventListener('change', () => {
      ${options.sortBug ? 'return;' : ''}
      const list = document.querySelector('.inventory_list');
      const read = (node) => ({ node, name: node.querySelector('.inventory_item_name').textContent, price: parseFloat(node.querySelector('.inventory_item_price').textContent.slice(1)) });
      const order = { az: (a, b) => a.name.localeCompare(b.name), za: (a, b) => b.name.localeCompare(a.name), lohi: (a, b) => a.price - b.price, hilo: (a, b) => b.price - a.price }[select.value];
      [...list.children].map(read).sort(order).forEach((item) => list.appendChild(item.node));
    });
  })();</script>`;
}

export const REAL_WORLD_PAGES: RealWorldPage[] = [
  {
    name: 'MUI table with a single rule',
    origin: 'devshop Fee Rules, 2026-10-23: header cells were taken for five rows and search was reported broken. It is not.',
    html: muiTable({ rules: RULES.slice(0, 1) }),
    defects: [],
    minProbes: 0,
  },
  {
    name: 'MUI table, search works',
    origin: 'devshop Fee Rules shape, with several rules',
    html: muiTable({ rules: RULES }),
    defects: [],
    minProbes: 1,
  },
  {
    name: 'MUI table, search broken',
    origin: 'devshop Fee Rules shape, search handler does nothing',
    html: muiTable({ rules: RULES, searchBug: true }),
    defects: ['search'],
    minProbes: 1,
  },
  {
    name: 'Product grid, sort works',
    origin: 'saucedemo.com as standard_user, 2026-10-23',
    html: productGrid({}),
    defects: [],
    minProbes: 2,
  },
  {
    name: 'Product grid, sort broken',
    origin: 'saucedemo.com as problem_user, 2026-10-23: sorting does nothing',
    html: productGrid({ sortBug: true }),
    defects: ['sort'],
    minProbes: 2,
  },
];
