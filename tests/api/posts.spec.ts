import { test, expect } from '@playwright/test';

test('GET post API returns expected data', async ({ request }) => {
  const response = await request.get(
    'https://jsonplaceholder.typicode.com/posts/1'
  );

  expect(response.status()).toBe(200);

  const body = await response.json();

  expect(body.id).toBe(1);
  expect(body).toHaveProperty('title');
  expect(body).toHaveProperty('body');
  expect(body.userId).toBe(1);
});

test('POST post API creates a record', async ({ request }) => {
  const response = await request.post(
    'https://jsonplaceholder.typicode.com/posts',
    {
      data: {
        title: 'Qyntra Demo',
        body: 'AI Quality Engineering',
        userId: 1
      }
    }
  );

  expect(response.status()).toBe(201);
});
