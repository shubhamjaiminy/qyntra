import { test, expect, type Page } from '@playwright/test';

import {
  distinctiveWord,
  formProbes,
  invalidValueFor,
  listProbes,
  probeFailureIsDefect,
  sortOptionMeaning,
  sortOrder,
  tableProbes,
  type Probe,
} from '../../scripts/lib/feature-probes';

/** Run a generated probe body the way its spec file would. */
async function runProbe(page: Page, probe: Probe): Promise<void> {
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
  await new AsyncFunction('page', 'expect', probe.test.body)(page, expect);
}

const RULES = [
  ['Summer Sale', 'Active'],
  ['Keyboard Clearance', 'Inactive'],
  ['Student Discount', 'Active'],
  ['Monitor Bundle', 'Inactive'],
];

/** A list page; `bug` breaks one behaviour the way the demo shop does. */
function listPage(bug: 'none' | 'search' | 'filter' = 'none'): string {
  const rows = RULES.map(([name, status]) => `<tr data-name="${name.toLowerCase()}" data-status="${status.toLowerCase()}"><td>${name}</td><td>${status}</td></tr>`).join('');
  const search = bug === 'search' ? 'true' : 'row.dataset.name.includes(q)';
  const filter = bug === 'filter' ? "s === 'all' || row.dataset.status !== s" : "s === 'all' || row.dataset.status === s";

  return `
    <label>Search rules <input id="q" type="search"></label>
    <label>Status <select id="s"><option value="all">All</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
    <a href="#new"><button type="button">Add a New Rule</button></a>
    <div role="toolbar"><button disabled>Save Filters</button></div>
    <table><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
    <script>
      function apply() {
        var q = document.getElementById('q').value.toLowerCase();
        var s = document.getElementById('s').value;
        document.querySelectorAll('tbody tr').forEach(function (row) { row.hidden = !((${search}) && (${filter})); });
      }
      document.getElementById('q').addEventListener('input', apply);
      document.getElementById('s').addEventListener('change', apply);
    </script>`;
}

function formPage(options: { rangeBug?: boolean; disabledSubmit?: boolean } = {}): string {
  const range = options.rangeBug ? '' : "if (!(Number(f.percent.value) >= 1 && Number(f.percent.value) <= 90)) e.push('Discount must be between 1 and 90');";

  return `
    <form id="f" novalidate>
      <label>Rule name <input name="name"></label>
      <label>Discount (%) <input name="percent" type="number"></label>
      <ul role="alert" id="errors"></ul>
      <button type="submit" ${options.disabledSubmit ? 'disabled' : ''}>Save Rule</button>
    </form>
    <script>
      document.getElementById('f').addEventListener('submit', (event) => { event.preventDefault(); const f = event.target; const e = [];
        if (!f.name.value.trim()) e.push('Rule name is required'); ${range}
        document.getElementById('errors').innerHTML = e.map((x) => '<li>' + x + '</li>').join(''); });
    </script>`;
}

test.describe('list probes', () => {
  test('a table with search and a status filter gets one probe each', async ({ page }) => {
    await page.setContent(listPage());
    const probes = await listProbes(page);

    expect(probes.map((probe) => probe.test.title)).toEqual([
      'Search for "Summer" shows only matching rows',
      'Filter "Active" shows only "Active" rows',
    ]);
  });

  test('the generated tests pass on a working page', async ({ page }) => {
    await page.setContent(listPage());
    for (const probe of await listProbes(page)) {
      await page.setContent(listPage());
      await runProbe(page, probe);
    }
  });

  test('the search probe fails when search does nothing', async ({ page }) => {
    await page.setContent(listPage());
    const [search] = await listProbes(page);

    await page.setContent(listPage('search'));
    await expect(runProbe(page, search)).rejects.toThrow(/search should narrow the list/);
  });

  test('the filter probe fails when the filter shows the opposite', async ({ page }) => {
    await page.setContent(listPage());
    const filter = (await listProbes(page))[1];

    await page.setContent(listPage('filter'));
    await expect(runProbe(page, filter)).rejects.toThrow(/every row should show the chosen value/);
  });
});

test.describe('form probes', () => {
  test('a list page is not a form: "Add a New Rule" and "Save Filters" are not submits', async ({ page }) => {
    await page.setContent(listPage());
    expect(await formProbes(page, [])).toEqual([]);
  });

  test('a form gets an empty-submit probe and a range probe, and both pass when it validates', async ({ page }) => {
    await page.setContent(formPage());
    const probes = await formProbes(page, []);

    expect(probes.map((probe) => probe.test.title)).toEqual(['Submitting the empty form shows an error', '"Discount (%)" rejects 150']);

    for (const probe of probes) {
      await page.setContent(formPage());
      await runProbe(page, probe);
    }
  });

  test('the range probe fails when 150% is accepted', async ({ page }) => {
    await page.setContent(formPage());
    const range = (await formProbes(page, []))[1];

    await page.setContent(formPage({ rangeBug: true }));
    await expect(runProbe(page, range)).rejects.toThrow(/150 in "Discount \(%\)" should be rejected/);
  });

  test('a submit disabled until valid is checked for staying disabled', async ({ page }) => {
    await page.setContent(formPage({ disabledSubmit: true }));
    const probes = await formProbes(page, []);

    expect(probes.map((probe) => probe.test.title)).toEqual(['"Save Rule" is disabled while the form is empty']);
    await runProbe(page, probes[0]);
  });

  test('a form already showing error-like text cannot be judged', async ({ page }) => {
    await page.setContent(`<p>Fields marked * are required</p>${formPage()}`);
    expect(await formProbes(page, [])).toEqual([]);
  });
});

test.describe('probe helpers', () => {
  test('the search word is the one fewest rows contain', () => {
    expect(distinctiveWord(['Summer Sale Rule', 'Clearance', 'b2b-rule'])).toBe('Summer');
    expect(distinctiveWord(['Same', 'Same'])).toBeUndefined();
  });

  test('invalid values follow the label', () => {
    expect(invalidValueFor('Discount (%)')).toBe('150');
    expect(invalidValueFor('inside fee amount')).toBe('-5');
    expect(invalidValueFor('Rule name')).toBeUndefined();
  });

  test('an assertion failure is a defect; a failure to act is not', () => {
    expect(probeFailureIsDefect('Error: expect(received).toBeLessThan(expected)\nsearch should narrow the list')).toBe(true);
    expect(probeFailureIsDefect("TimeoutError: locator.click: Timeout 15000ms exceeded.\nwaiting for getByRole('button')")).toBe(false);
  });
});

/** A sortable, paginated table; `bug` breaks sorting or paging. */
function tablePage(bug: 'none' | 'sort' | 'page' = 'none'): string {
  return `
    <table><thead><tr><th aria-sort="none"><button id="by-price">Price</button></th><th>Name</th></tr></thead><tbody id="body"></tbody></table>
    <button id="prev" aria-label="Previous Page">‹</button><button id="next" aria-label="Next Page">›</button>
    <script>
      var data = [['$120.00','Gamma'],['$9.50','Alpha'],['$1,000.00','Delta'],['$45.00','Beta'],['$300.00','Epsilon'],['$2.00','Zeta']];
      var dir = 0, page = 0;
      function money(v) { return parseFloat(v.replace(/[^\\d.]/g, '')); }
      function render() {
        var rows = data.slice();
        if (dir !== 0 && '${bug}' !== 'sort') rows.sort(function (a, b) { return dir * (money(a[0]) - money(b[0])); });
        var shown = '${bug}' === 'page' ? rows.slice(0, 3) : rows.slice(page * 3, page * 3 + 3);
        document.getElementById('body').innerHTML = shown.map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>'; }).join('');
      }
      document.getElementById('by-price').onclick = function () { dir = dir === 1 ? -1 : 1; render(); };
      document.getElementById('next').onclick = function () { page = 1; render(); };
      document.getElementById('prev').onclick = function () { page = 0; render(); };
      render();
    </script>`;
}

test.describe('sorting and pagination probes', () => {
  test('a sortable, paginated table gets both probes, and they pass when it works', async ({ page }) => {
    await page.setContent(tablePage());
    const probes = await tableProbes(page, 'tbody tr:visible');

    expect(probes.map((probe) => probe.kind)).toEqual(['sort', 'pagination']);
    expect(probes[0].test.body).not.toContain('__name');

    for (const probe of probes) {
      await page.setContent(tablePage());
      await runProbe(page, probe);
    }
  });

  test('the sort probe fails when the header click does not sort', async ({ page }) => {
    await page.setContent(tablePage());
    const [sort] = await tableProbes(page, 'tbody tr:visible');

    await page.setContent(tablePage('sort'));
    await expect(runProbe(page, sort)).rejects.toThrow(/should sort the column|should reverse the order/);
  });

  test('the pagination probe fails when Next shows the same rows', async ({ page }) => {
    await page.setContent(tablePage());
    const pagination = (await tableProbes(page, 'tbody tr:visible'))[1];

    await page.setContent(tablePage('page'));
    await expect(runProbe(page, pagination)).rejects.toThrow(/next page should show different rows/);
  });

  test('sort order understands money, percentages, dates and text', () => {
    expect(sortOrder(['$9.50', '$45.00', '$120.00', '$1,000.00'])).toBe('asc');
    expect(sortOrder(['90%', '15%', '10%'])).toBe('desc');
    expect(sortOrder(['2026-01-03', '2026-02-01', '2026-10-12'])).toBe('asc');
    expect(sortOrder(['Item 2', 'Item 10', 'item 11'])).toBe('asc');
    expect(sortOrder(['b', 'a', 'c'])).toBe('none');
    expect(sortOrder(['Same', 'same'])).toBe('equal');
  });
});

/** A custom (ARIA) dropdown filter, as MUI renders one. */
function comboPage(bug = false): string {
  return `
    <span id="lbl">Status</span>
    <div role="combobox" aria-labelledby="lbl" aria-expanded="false" tabindex="0" id="combo">All</div>
    <ul role="listbox" id="list" hidden><li role="option">All</li><li role="option">Active</li><li role="option">Inactive</li></ul>
    <table><tbody>
      <tr><td>Summer Sale</td><td>Active</td></tr><tr><td>Clearance</td><td>Inactive</td></tr><tr><td>Student</td><td>Active</td></tr>
    </tbody></table>
    <script>
      document.getElementById('combo').onclick = function () { document.getElementById('list').hidden = false; };
      document.querySelectorAll('[role=option]').forEach(function (option) {
        option.onclick = function () {
          var want = option.textContent;
          document.getElementById('list').hidden = true;
          document.querySelectorAll('tbody tr').forEach(function (row) {
            var status = row.cells[1].textContent;
            row.hidden = want !== 'All' && (${bug ? 'status === want' : 'status !== want'});
          });
        };
      });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') document.getElementById('list').hidden = true; });
    </script>`;
}

test.describe('custom dropdown filter probe', () => {
  test('is found, passes when it filters, and fails when it shows the opposite', async ({ page }) => {
    await page.setContent(comboPage());
    const [filter] = (await listProbes(page)).filter((probe) => probe.kind === 'filter');

    expect(filter.test.title).toBe('Filter "Active" shows only "Active" rows');

    await page.setContent(comboPage());
    await runProbe(page, filter);

    await page.setContent(comboPage(true));
    await expect(runProbe(page, filter)).rejects.toThrow(/every row should show the chosen value/);
  });
});

test.describe('native validation', () => {
  const emailForm = (novalidate: boolean) => `
    <form ${novalidate ? 'novalidate' : ''} onsubmit="event.preventDefault(); document.getElementById('r').textContent = 'Saved';">
      <label>Name <input name="name" required></label>
      <label>Email <input name="email" type="email" required></label>
      <button type="submit">Save</button>
    </form><p id="r"></p>`;

  test('a form the browser validates passes the email probe', async ({ page }) => {
    await page.setContent(emailForm(false));
    const probe = (await formProbes(page, [])).find((entry) => entry.test.title.includes('not-an-email'))!;

    await runProbe(page, probe);
  });

  test('the same form with novalidate and no checks of its own fails it', async ({ page }) => {
    await page.setContent(emailForm(false));
    const probe = (await formProbes(page, [])).find((entry) => entry.test.title.includes('not-an-email'))!;

    await page.setContent(emailForm(true));
    await expect(runProbe(page, probe)).rejects.toThrow(/not-an-email in "Email" should be rejected/);
  });
});

/** A product grid of cards with a "sort by" dropdown, like most shops. */
function shopPage(bug?: 'sort'): string {
  const products = [
    ['Backpack', 29.99],
    ['Bike Light', 9.99],
    ['Onesie', 7.99],
    ['Fleece Jacket', 49.99],
  ] as const;

  return `<nav><a href="/">Home</a><a href="/cart">Cart</a></nav>
  <select data-test="product-sort">
    <option>Name (A to Z)</option><option>Name (Z to A)</option>
    <option>Price (low to high)</option><option>Price (high to low)</option>
  </select>
  <div class="inventory_list">${[...products]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, price]) => `<div class="inventory_item"><div class="inventory_item_name">${name}</div><p>Soft and useful.</p><div class="price">$${price.toFixed(2)}</div><button>Add to cart</button></div>`)
    .join('')}</div>
  <script>(() => {
    const sorters = {
      'Name (A to Z)': (a, b) => a.name.localeCompare(b.name), 'Name (Z to A)': (a, b) => b.name.localeCompare(a.name),
      'Price (low to high)': (a, b) => a.price - b.price, 'Price (high to low)': (a, b) => b.price - a.price,
    };
    document.querySelector('select').addEventListener('change', (event) => {
      ${bug === 'sort' ? 'return;' : ''}
      const list = document.querySelector('.inventory_list');
      const items = [...list.children].map((node) => ({ node, name: node.querySelector('.inventory_item_name').textContent, price: parseFloat(node.querySelector('.price').textContent.slice(1)) }));
      items.sort(sorters[event.target.selectedOptions[0].label]).forEach((item) => list.appendChild(item.node));
    });
  })();</script>`;
}

test.describe('sort-by dropdown probes', () => {
  test('a product grid of cards with a sort dropdown gets a probe per field, and they pass when it works', async ({ page }) => {
    await page.setContent(shopPage());
    const probes = (await listProbes(page)).filter((probe) => probe.kind === 'sort');

    expect(probes.map((probe) => probe.test.title)).toEqual([
      'Sorting by price follows "Price (high to low)" and "Price (low to high)"',
      'Sorting by name follows "Name (Z to A)" and "Name (A to Z)"',
    ]);
    expect(probes[0].test.body).toContain('[data-test="product-sort"]');
    expect(probes[0].test.body).not.toContain('__name');

    for (const probe of probes) {
      await page.setContent(shopPage());
      await runProbe(page, probe);
    }
  });

  test('the probe fails when choosing a sort order changes nothing', async ({ page }) => {
    await page.setContent(shopPage());
    const [price] = (await listProbes(page)).filter((probe) => probe.kind === 'sort');

    await page.setContent(shopPage('sort'));
    await expect(runProbe(page, price)).rejects.toThrow(/choosing "Price \(high to low\)" should order the items by price/);
  });

  test('sort options are read from their wording', () => {
    expect(sortOptionMeaning('Price (high to low)')).toEqual({ field: 'price', direction: 'desc' });
    expect(sortOptionMeaning('Price: Low - High')).toEqual({ field: 'price', direction: 'asc' });
    expect(sortOptionMeaning('Name (A to Z)')).toEqual({ field: 'name', direction: 'asc' });
    expect(sortOptionMeaning('Z → A')).toEqual({ field: 'name', direction: 'desc' });
    expect(sortOptionMeaning('Featured')).toBeUndefined();
    expect(sortOptionMeaning('Newest')).toBeUndefined();
  });

  test('a page without a list gets no sort probe from an unrelated dropdown', async ({ page }) => {
    await page.setContent('<label>Country <select><option>Price (low to high)</option><option>Price (high to low)</option></select></label><p>Hello</p>');
    expect(await listProbes(page)).toEqual([]);
  });
});
