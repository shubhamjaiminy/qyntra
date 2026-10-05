import { test, expect } from '@playwright/test';

test('user can create and complete a todo', async ({ page }) => {
  await page.goto('/todomvc');

  const input = page.getByPlaceholder('What needs to be done?');

  await input.fill('Qyntra Demo Test');
  await input.press('Enter');

  const todo = page.getByText('Qyntra Demo Test');

  await expect(todo).toBeVisible();

const checkbox = page.getByRole('checkbox', {
  name: 'Toggle Todo'
});
  await checkbox.check();

  await expect(todo).toHaveCSS(
    'text-decoration-line',
    'line-through'
  );
});
