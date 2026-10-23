/**
 * A narrated explainer video of Qyntra, recorded from the real demo:
 * what it is for, shown on Acme Shop, the AI support bot and Qyntra
 * Cloud, with captions and a spoken voice-over.
 *
 *   npm run demo:video        writes demo/qyntra-out/qyntra-explainer.mp4
 *
 * Needs macOS (`say` for the voice) and ffmpeg. Starts and stops its own
 * demo, so stop a running `npm run demo:live` first. About 4 minutes.
 */

import fs from 'fs';
import path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';

import { chromium, type Page } from '@playwright/test';

import { DEMO_PORT, MODE_FILE } from './shop-app';

// From demo/live.ts, which starts the demo when imported.
const CLOUD_PORT = Number(process.env.DEMO_CLOUD_PORT ?? 8080);
const DEMO_LOGIN = { email: 'demo@acme.example', password: 'qyntra-demo-2026' };

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'qyntra-out');
const WORK = path.join(OUT, 'video-work');
const VIDEO = path.join(OUT, 'qyntra-explainer.mp4');
const VOICE = process.env.QYNTRA_VIDEO_VOICE ?? 'Samantha';
const SHOP = `http://localhost:${DEMO_PORT}`;
const CLOUD = `http://localhost:${CLOUD_PORT}`;

// --------------------------------------------------
// PREPARATION: real results for the video to show
// --------------------------------------------------

function tsx(args: string[], options: { quiet?: boolean } = {}): string {
  const result = spawnSync(process.execPath, [require.resolve('tsx/cli'), ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, QYNTRA_AI_PROVIDER: 'none' },
  });

  if (!options.quiet && result.status !== 0 && result.status !== 1) {
    throw new Error(`${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }

  return result.stdout;
}

async function waitFor(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(url).then((response) => response.status < 500, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} did not come up`);
}

/** Log in, offer the design-partner plan, and find the org and project. */
async function cloudSetup(): Promise<{ org: string; project: string }> {
  let cookie = '';
  const request = async (route: string, form?: Record<string, string>) => {
    const response = await fetch(CLOUD + route, {
      method: form ? 'POST' : 'GET',
      redirect: 'manual',
      headers: { cookie, origin: CLOUD, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form) : undefined,
    });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { location: response.headers.get('location') ?? '', body: await response.text() };
  };

  await request('/login', { email: DEMO_LOGIN.email, password: DEMO_LOGIN.password });
  const admin = await request('/admin');
  const orgId = admin.body.match(/action="\/admin\/orgs\/([^/]+)\/offer"/)?.[1];
  const csrf = admin.body.match(/name="csrf" value="([^"]+)"/)?.[1];
  if (orgId && csrf) await request(`/admin/orgs/${orgId}/offer`, { offer: 'partner', csrf });

  const home = await request('/app');
  const orgPage = await request(home.location || '/app');
  const link = (orgPage.body + home.body).match(/\/o\/([a-z0-9-]+)\/p\/([a-z0-9-]+)/);
  if (!link) throw new Error('Could not find the demo project in Qyntra Cloud');

  return { org: link[1], project: link[2] };
}

// --------------------------------------------------
// NARRATION
// --------------------------------------------------

function narrate(index: number, text: string): { file: string; seconds: number } {
  const file = path.join(WORK, `voice-${String(index).padStart(2, '0')}.aiff`);
  spawnSync('say', ['-v', VOICE, '-r', '172', '-o', file, text]);

  const info = spawnSync('afinfo', [file], { encoding: 'utf-8' }).stdout;
  const seconds = Number(info.match(/estimated duration: ([\d.]+)/)?.[1] ?? 5);

  return { file, seconds };
}

// --------------------------------------------------
// ON-SCREEN PIECES
// --------------------------------------------------

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;

async function caption(page: Page, text: string): Promise<void> {
  await page.evaluate(
    ({ text, font }) => {
      document.getElementById('qyntra-caption')?.remove();
      const box = document.createElement('div');
      box.id = 'qyntra-caption';
      box.textContent = text;
      Object.assign(box.style, {
        position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)', maxWidth: '1100px',
        background: 'rgba(15, 23, 42, 0.92)', color: '#fff', font: `600 24px/1.35 ${font}`,
        padding: '16px 26px', borderRadius: '14px', zIndex: '2147483647', textAlign: 'center',
        boxShadow: '0 10px 30px rgba(0,0,0,.35)',
      });
      document.body.appendChild(box);
    },
    { text, font: FONT }
  );
}

async function highlight(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().evaluate((element) => {
    (element as HTMLElement).style.outline = '4px solid #f59e0b';
    (element as HTMLElement).style.outlineOffset = '4px';
    (element as HTMLElement).style.borderRadius = '6px';
  }).catch(() => undefined);
}

function card(body: string, tone: 'dark' | 'light' = 'dark'): string {
  const dark = tone === 'dark';
  return `<!doctype html><html><head><style>
    body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center; font-family:${FONT};
      background:${dark ? 'radial-gradient(circle at 30% 20%, #1e3a8a, #0f172a 70%)' : '#f8fafc'}; color:${dark ? '#f8fafc' : '#0f172a'}; }
    .wrap { width: 1080px; }
    h1 { font-size: 64px; margin: 0 0 16px; letter-spacing: -1px; }
    h2 { font-size: 40px; margin: 0 0 28px; }
    p, li { font-size: 30px; line-height: 1.45; }
    li { margin: 14px 0; }
    .muted { color: ${dark ? '#cbd5e1' : '#475569'}; }
    .accent { color: #38bdf8; }
    table { border-collapse: collapse; width: 100%; font-size: 21px; background: #fff; color: #0f172a; border-radius: 12px; overflow: hidden; }
    th, td { padding: 9px 14px; text-align: left; border-bottom: 1px solid #e2e8f0; }
    th { background: #e2e8f0; }
    .SAFE { color: #15803d; font-weight: 700; } .SAFE_WITH_RISK { color: #b45309; font-weight: 700; } .UNSAFE { color: #b91c1c; font-weight: 700; }
    .big { display:flex; gap: 28px; margin-top: 26px; }
    .big div { flex:1; background: rgba(255,255,255,.08); border-radius: 18px; padding: 22px 28px; }
    .big b { display:block; font-size: 72px; }
  </style></head><body><div class="wrap">${body}</div></body></html>`;
}

/** Just enough Markdown for Qyntra's own reports: headings, tables, lists, bold, code, quotes. */
function markdownPage(markdown: string, title: string): string {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (text: string) =>
    escape(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\\\|/g, '|');

  const lines = markdown.split('\n');
  const html: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (line.startsWith('|')) {
      const rows: string[] = [];
      while (index < lines.length && lines[index].startsWith('|')) rows.push(lines[index++]);
      index--;
      const cells = (row: string) => row.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim());
      const [head, , ...body] = rows;
      html.push(
        `<table><tr>${cells(head).map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr>${body
          .map((row) => `<tr>${cells(row).map((cell) => `<td>${inline(cell).replace('FAILED', '<span style="color:#b91c1c">FAILED</span>')}</td>`).join('')}</tr>`)
          .join('')}</table>`
      );
    } else if (/^#{1,3} /.test(line)) {
      const level = line.match(/^#+/)![0].length;
      html.push(`<h${level}>${inline(line.replace(/^#+ /, ''))}</h${level}>`);
    } else if (line.startsWith('- ')) {
      html.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (line.startsWith('> ')) {
      html.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
    } else if (line.trim()) {
      html.push(`<p>${inline(line)}</p>`);
    }
  }

  return `<!doctype html><html><head><title>${title}</title><style>
    body { font-family:${FONT}; margin: 0; background:#f1f5f9; color:#0f172a; }
    main { max-width: 1100px; margin: 0 auto; padding: 36px 40px 160px; background:#fff; min-height:100vh; }
    h1 { font-size: 36px; } h2 { font-size: 26px; margin-top: 34px; } h3 { font-size: 21px; }
    p, li { font-size: 18px; line-height: 1.5; } code { background:#f1f5f9; padding: 1px 5px; border-radius: 4px; }
    table { border-collapse: collapse; width: 100%; font-size: 15px; margin: 12px 0; }
    th, td { border: 1px solid #cbd5e1; padding: 6px 10px; text-align: left; vertical-align: top; } th { background:#e2e8f0; }
    blockquote { border-left: 4px solid #f59e0b; margin: 0; padding: 6px 14px; color:#92400e; background:#fffbeb; }
    .tag { display:inline-block; background:#0f172a; color:#fff; padding: 4px 10px; border-radius: 6px; font-size: 14px; }
  </style></head><body><main><span class="tag">${title}</span>${html.join('\n')}</main></body></html>`;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Show one of the video's own pages. From about:blank, because
 * setContent keeps the current document's origin, and Qyntra Cloud's
 * Content-Security-Policy forbids the inline styles these pages use.
 */
async function slide(page: Page, html: string): Promise<void> {
  await page.goto('about:blank');
  await page.setContent(html);
}

async function scrollSlowly(page: Page, pixels: number, ms: number): Promise<void> {
  const steps = Math.max(1, Math.round(ms / 50));
  for (let step = 0; step < steps; step++) {
    await page.mouse.wheel(0, pixels / steps);
    await pause(50);
  }
}

// --------------------------------------------------
// THE VIDEO
// --------------------------------------------------

interface Scene {
  say: string;
  show: (page: Page) => Promise<void>;
}

async function main(): Promise<void> {
  for (const tool of ['say', 'afinfo', 'ffmpeg']) {
    if (spawnSync('which', [tool]).status !== 0) throw new Error(`${tool} is needed (macOS say/afinfo, and: brew install ffmpeg)`);
  }

  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  console.log('Starting the demo…');
  tsx(['demo/live.ts', 'stop'], { quiet: true });
  const demo: ChildProcess = spawn(process.execPath, [require.resolve('tsx/cli'), 'demo/live.ts', 'start'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: true,
  });

  try {
    await waitFor(`${SHOP}/`);
    await waitFor(`${CLOUD}/login`);

    console.log('Preparing real results: a pilot week, a feature check, the AI bot…');
    const pilotOutput = tsx(['demo/pilot.ts']);
    fs.writeFileSync(MODE_FILE, 'search-bug');
    tsx(['demo/live.ts', 'check']);
    fs.writeFileSync(MODE_FILE, 'healthy');
    tsx(['demo/ai-bot.ts']);
    const { org, project } = await cloudSetup();

    const prs = [...pilotOutput.matchAll(/PR (\d+)\s+(.+?)\s{2,}(SAFE_WITH_RISK|SAFE|UNSAFE)\s+score (\d+)/g)].map((match) => ({
      n: match[1], change: match[2].trim(), verdict: match[3], score: match[4],
    }));
    const week = fs.readFileSync(path.join(OUT, 'pilot-report.md'), 'utf-8').match(/\| (\d{4}-\d\d-\d\d) \| (\d+) \| (\d+) \| (\d+) \|/);
    const assessment = fs.readFileSync(path.join(__dirname, 'ai-bot', 'qyntra-out', 'ai-assessment.md'), 'utf-8');

    const verdictText: Record<string, string> = { SAFE: 'Safe', SAFE_WITH_RISK: 'Safe, with a warning', UNSAFE: 'Blocked' };

    const scenes: Scene[] = [
      {
        say: 'This is Qyntra. In one sentence: it tells a software team whether a change is safe to release, before their customers find out that it is not.',
        show: async (page) => {
          await slide(page, card(`<h1>Qyntra</h1><p class="accent" style="font-size:38px;margin:0">An AI quality engineer</p>
            <p class="muted" style="margin-top:30px">It tells a software team whether a change is <b>safe to release</b>, before customers find out it isn't.</p>`));
        },
      },
      {
        say: "Here is the problem. Every time developers change code, something can break. Teams write automated tests to catch that. But those tests often fail for silly reasons, like a page loading a little slowly. So people learn to ignore failing tests, and one day a real bug slips through to customers.",
        show: async (page) => {
          await slide(page, card(`<h2>The problem</h2><ul>
            <li>Every code change can break something.</li>
            <li>Teams have automated tests, but they often fail for <b>silly reasons</b>.</li>
            <li>So people ignore failing tests…</li>
            <li>…and a <b class="accent">real bug</b> slips through to customers.</li></ul>`));
        },
      },
      {
        say: "Let's see it on a sample online shop. This is the shop's admin page for discount rules. Search works: type summer, and only the summer rules are left.",
        show: async (page) => {
          await page.goto(`${SHOP}/admin/discount-rules`);
          await caption(page, 'A sample online shop: its admin page for discount rules');
          await pause(4500);
          await highlight(page, '#search');
          await page.locator('#search').pressSequentially('summer', { delay: 220 });
          await highlight(page, '#shown');
          await caption(page, 'Search works: typing "summer" leaves only the summer rules');
        },
      },
      {
        say: 'Now a developer changes some code. The page still looks perfectly fine. But type summer, and nothing happens. Search is broken. A typical test, which only checks that the search box is there, would still pass.',
        show: async (page) => {
          fs.writeFileSync(MODE_FILE, 'search-bug');
          await page.goto(`${SHOP}/admin/discount-rules`);
          await caption(page, 'A developer changes some code… the page still looks fine');
          await pause(4500);
          await highlight(page, '#search');
          await page.locator('#search').pressSequentially('summer', { delay: 220 });
          await highlight(page, '#shown');
          await caption(page, 'But search is broken: nothing is filtered');
        },
      },
      {
        say: 'Qyntra checked this page by itself. Nobody wrote a test for it. It knows that a search box must narrow the list, so it tried it, saw that it did not, and marked the feature: not ready, with the reason. In a real team, this stops the change before it ships.',
        show: async (page) => {
          fs.writeFileSync(MODE_FILE, 'healthy');
          await page.goto(`${CLOUD}/o/${org}/p/${project}/features`);
          await caption(page, 'Qyntra checked the page on its own, with no test written by anyone');
          await pause(3500);
          await page.locator('a', { hasText: /Discount Rules/i }).first().click().catch(() => undefined);
          await page.waitForLoadState();
          await caption(page, 'Result: NOT READY. Search did not narrow the list');
          await pause(3000);
          await scrollSlowly(page, 500, 3000);
        },
      },
      {
        say: "Here is one week at this company: eight changes. Three times, the team's own tests failed only because a button loaded slowly. Nothing was wrong for shoppers, so Qyntra let those through with a warning, instead of stopping the team. Once, a change really broke the cart total. Qyntra blocked that one.",
        show: async (page) => {
          await slide(page, card(`<h2>One week, eight changes</h2><table><tr><th>Change</th><th>Qyntra said</th></tr>
            ${prs.map((pr) => `<tr><td>${pr.change}</td><td class="${pr.verdict}">${verdictText[pr.verdict]}</td></tr>`).join('')}</table>`));
          await caption(page, 'Slow buttons failed the tests, not the shop: let through. The real cart bug: blocked.');
        },
      },
      {
        say: "At the end of the week, Qyntra reports two numbers. Real bugs caught, and false alarms avoided. The customer's team confirms each one. That is how a customer sees, every week, that Qyntra is worth paying for.",
        show: async (page) => {
          await slide(page, card(`<h2>The weekly report</h2>
            <div class="big"><div><b>${week?.[3] ?? '1'}</b>real bug caught</div><div><b>${week?.[4] ?? '2'}</b>false alarms avoided</div></div>
            <p class="muted" style="margin-top:30px">The customer's team ticks off each one to confirm it. Counts only, so it's safe to share.</p>`));
        },
      },
      {
        say: "Many products now have an AI chat assistant. Qyntra attacks it the way a bad actor would. This support bot leaked its secret instructions, handed out other customers' email addresses, obeyed a hidden command, and crashed on an empty message. Qyntra writes a report that a security team can file, and runs it again after every change.",
        show: async (page) => {
          const top = assessment.split('## OWASP')[0];
          await slide(page, markdownPage(top, 'AI assistant check'));
          await caption(page, 'Testing an AI chatbot: Qyntra attacks it and reports what got through');
          await pause(6000);
          await scrollSlowly(page, 900, 9000);
        },
      },
      {
        say: "Everything runs inside the customer's own systems, so their code and data never leave. Teams that want history and dashboards use Qyntra Cloud. The first customers pay five hundred dollars a month, as design partners.",
        show: async (page) => {
          await page.goto(`${CLOUD}/o/${org}/billing`);
          await caption(page, "Runs inside the customer's systems. Early customers: $500 a month");
          await pause(4000);
          await scrollSlowly(page, 400, 2500);
        },
      },
      {
        say: 'So, in short. Qyntra checks your app by itself. It tells real bugs apart from false alarms. It tests your AI assistant. And it gives every change a clear answer: safe to ship, or not.',
        show: async (page) => {
          await slide(page, card(`<h2>Qyntra, in short</h2><ul>
            <li>Checks your app's features <b>by itself</b></li>
            <li>Tells <b>real bugs</b> apart from <b>false alarms</b></li>
            <li>Tests your <b>AI assistant</b> for leaks and attacks</li>
            <li>Gives every change a clear answer: <b class="accent">safe to ship, or not</b></li></ul>`));
        },
      },
    ];

    console.log('Recording the voice-over…');
    const voices = scenes.map((scene, index) => narrate(index, scene.say));

    console.log('Recording the screen…');
    const browser = await chromium.launch();
    const login = await browser.newContext();
    const loginPage = await login.newPage();
    await loginPage.goto(`${CLOUD}/login`);
    await loginPage.fill('input[name="email"]', DEMO_LOGIN.email);
    await loginPage.fill('input[name="password"]', DEMO_LOGIN.password);
    await Promise.all([loginPage.waitForLoadState(), loginPage.locator('button[type="submit"]').first().click()]);
    const storageState = await login.storageState();
    await login.close();

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: WORK, size: { width: 1280, height: 720 } },
      storageState,
    });
    const page = await context.newPage();
    const started = Date.now();
    const offsets: number[] = [];

    for (const [index, scene] of scenes.entries()) {
      const sceneStart = Date.now();
      offsets.push(sceneStart - started);
      await scene.show(page);
      const remaining = voices[index].seconds * 1000 + 900 - (Date.now() - sceneStart);
      if (remaining > 0) await pause(remaining);
      console.log(`  scene ${index + 1}/${scenes.length}`);
    }

    await pause(800);
    const raw = await page.video()!.path();
    await context.close();
    await browser.close();

    console.log('Mixing video and voice…');
    const inputs = voices.flatMap((voice) => ['-i', voice.file]);
    const delays = voices.map((_, index) => `[${index + 1}:a]adelay=${offsets[index]}|${offsets[index]}[a${index}]`);
    const mix = `${delays.join(';')};${voices.map((_, index) => `[a${index}]`).join('')}amix=inputs=${voices.length}:normalize=0[aout]`;

    const ffmpeg = spawnSync('ffmpeg', [
      '-y', '-i', raw, ...inputs,
      '-filter_complex', mix,
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20',
      '-c:a', 'aac', '-b:a', '160k',
      VIDEO,
    ], { encoding: 'utf-8' });

    if (ffmpeg.status !== 0) throw new Error(`ffmpeg failed:\n${ffmpeg.stderr.slice(-2000)}`);

    console.log(`\nVideo: ${VIDEO}\n`);
  } finally {
    fs.writeFileSync(MODE_FILE, 'healthy');
    if (demo.pid) {
      try {
        process.kill(-demo.pid);
      } catch {
        // Already stopped.
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
