import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';

interface ApplicationMap {
  generatedAt: string;
  url: string;
  title: string;
  headings: string[];
  links: {
    text: string;
    href: string;
  }[];
  buttons: {
    text: string;
    ariaLabel: string | null;
  }[];
  inputs: {
    type: string;
    name: string | null;
    placeholder: string | null;
    ariaLabel: string | null;
  }[];
  textareas: {
    name: string | null;
    placeholder: string | null;
    ariaLabel: string | null;
  }[];
  selects: {
    name: string | null;
    ariaLabel: string | null;
  }[];
  forms: number;
}

async function discoverApplication(url: string): Promise<void> {
  console.log('');
  console.log('======================================');
  console.log('QYNTRA APPLICATION DISCOVERY');
  console.log('======================================');
  console.log('');
  console.log(`URL: ${url}`);
  console.log('');

  const browser = await chromium.launch({
    headless: true,
  });

  const page = await browser.newPage();

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    await page.waitForTimeout(1_000);

    const title = await page.title();

    const headings = await page.locator('h1, h2, h3, h4, h5, h6').evaluateAll(
      (elements) =>
        elements
          .map((element) => element.textContent?.trim() || '')
          .filter(Boolean)
    );

    const links = await page.locator('a').evaluateAll((elements) =>
      elements
        .map((element) => ({
          text: element.textContent?.trim() || '',
          href: (element as HTMLAnchorElement).href || '',
        }))
        .filter((link) => link.text || link.href)
    );

    const buttons = await page
      .locator('button, input[type="button"], input[type="submit"]')
      .evaluateAll((elements) =>
        elements.map((element) => ({
          text:
            element.textContent?.trim() ||
            (element as HTMLInputElement).value ||
            '',
          ariaLabel: element.getAttribute('aria-label'),
        }))
      );

    const inputs = await page
      .locator('input:not([type="button"]):not([type="submit"])')
      .evaluateAll((elements) =>
        elements.map((element) => ({
          type: element.getAttribute('type') || 'text',
          name: element.getAttribute('name'),
          placeholder: element.getAttribute('placeholder'),
          ariaLabel: element.getAttribute('aria-label'),
        }))
      );

    const textareas = await page.locator('textarea').evaluateAll((elements) =>
      elements.map((element) => ({
        name: element.getAttribute('name'),
        placeholder: element.getAttribute('placeholder'),
        ariaLabel: element.getAttribute('aria-label'),
      }))
    );

    const selects = await page.locator('select').evaluateAll((elements) =>
      elements.map((element) => ({
        name: element.getAttribute('name'),
        ariaLabel: element.getAttribute('aria-label'),
      }))
    );

    const forms = await page.locator('form').count();

    const applicationMap: ApplicationMap = {
      generatedAt: new Date().toISOString(),
      url,
      title,
      headings,
      links,
      buttons,
      inputs,
      textareas,
      selects,
      forms,
    };

    const outputDirectory = path.join(process.cwd(), 'qyntra-dashboard');

    fs.mkdirSync(outputDirectory, {
      recursive: true,
    });

    const outputFile = path.join(
      outputDirectory,
      'application-map.json'
    );

    fs.writeFileSync(
      outputFile,
      JSON.stringify(applicationMap, null, 2),
      'utf8'
    );

    console.log('PAGE');
    console.log(`Title   : ${title}`);
    console.log(`Headings: ${headings.length}`);
    console.log('');

    console.log('ELEMENTS');
    console.log(`Inputs  : ${inputs.length}`);
    console.log(`Buttons : ${buttons.length}`);
    console.log(`Links   : ${links.length}`);
    console.log(`Forms   : ${forms}`);
    console.log('');

    if (headings.length > 0) {
      console.log('HEADINGS');

      for (const heading of headings) {
        console.log(`• ${heading}`);
      }

      console.log('');
    }

    if (inputs.length > 0) {
      console.log('INPUTS');

      for (const input of inputs) {
        const identifier =
          input.ariaLabel ||
          input.placeholder ||
          input.name ||
          input.type;

        console.log(`• ${identifier}`);
      }

      console.log('');
    }

    if (buttons.length > 0) {
      console.log('BUTTONS');

      for (const button of buttons) {
        const identifier = button.ariaLabel || button.text || 'Unnamed button';

        console.log(`• ${identifier}`);
      }

      console.log('');
    }

    if (links.length > 0) {
      console.log('LINKS');

      for (const link of links) {
        console.log(`• ${link.text || link.href}`);
      }

      console.log('');
    }

    console.log('--------------------------------------');
    console.log(`Application map saved:`);
    console.log(outputFile);
    console.log('--------------------------------------');
    console.log('');
  } finally {
    await browser.close();
  }
}

const url = process.argv[2];

if (!url) {
  console.error(
    'Usage: npm run discover -- "https://example.com"'
  );

  process.exit(1);
}

discoverApplication(url).catch((error) => {
  console.error('');
  console.error('QYNTRA APPLICATION DISCOVERY FAILED');
  console.error('');
  console.error(error);
  process.exit(1);
});