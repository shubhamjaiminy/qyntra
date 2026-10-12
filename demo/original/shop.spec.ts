import { test, expect } from '@playwright/test';

// The demo team's own tests, written before Qyntra. Qyntra gates on them
// via execution.include, and diagnoses and repairs them when they fail.

test('products are listed', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  await expect(page.locator('.product')).toHaveCount(3);
});

test('add a product to the cart', async ({ page }) => {
  await page.goto('/');

  await page.locator('#add-to-cart-keyboard').click();

  await expect(page.getByTestId('cart-count')).toHaveText('1');
});

test('cart total adds up', async ({ page }) => {
  await page.goto('/');

  await page.locator('#add-to-cart-keyboard').click();
  await page.locator('#add-to-cart-mouse').click();
  await page.goto('/cart');

  await expect(page.getByTestId('cart-total')).toHaveText('$129.00');
});

test('checkout confirms the order', async ({ page }) => {
  await page.goto('/');

  await page.locator('#add-to-cart-monitor').click();
  await page.goto('/cart');
  await page.getByRole('button', { name: 'Checkout' }).click();

  await expect(page.getByRole('status')).toHaveText('Order confirmed');
});
