#!/usr/bin/env node
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.SMOKE_PORT || 18181);
const baseUrl = `http://127.0.0.1:${port}`;
const projectMetricsToken = process.env.PROJECT_METRICS_TOKEN || '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    redirect: 'manual',
    ...options,
  });
  const text = await response.text();
  return { response, text };
}

async function waitForServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const { response } = await request('/api/health');
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Server did not become ready in time.');
}

async function run() {
  const server = fork(path.join(root, 'server.js'), {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    silent: true,
  });

  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer();

    const staticChecks = [
      '/',
      '/landing-page/index.html',
      '/dashboard/dashboard.html',
      '/quote-follow-up-software/',
      '/resources/quote-follow-up-email-templates/',
      '/sitemap.xml',
    ];

    for (const pathname of staticChecks) {
      const { response, text } = await request(pathname);
      assert(response.status === 200, `${pathname} returned ${response.status}`);
      assert(response.headers.get('content-security-policy'), `${pathname} is missing CSP header`);
      assert(response.headers.get('x-content-type-options') === 'nosniff', `${pathname} is missing nosniff header`);
      assert(text.length > 0, `${pathname} returned an empty body`);
    }

    const sitemap = await request('/sitemap.xml');
    assert(sitemap.text.includes('/resources/quote-follow-up-email-templates/'), 'sitemap is missing resource guide URLs');

    const health = await request('/api/health');
    const healthJson = JSON.parse(health.text);
    assert(healthJson.ok === true, '/api/health did not report ok:true');

    const publicConfig = await request('/api/public-config');
    const publicConfigJson = JSON.parse(publicConfig.text);
    assert(typeof publicConfigJson.billing?.configured === 'boolean', '/api/public-config is missing billing.configured');
    assert(!('personalPriceId' in (publicConfigJson.billing || {})), '/api/public-config should not expose Stripe price ids');

    const metricsNoToken = await request('/api/project-metrics');
    if (projectMetricsToken) {
      assert(metricsNoToken.response.status === 404, '/api/project-metrics should be private without a token');
      const metricsWithToken = await request('/api/project-metrics', {
        headers: { 'x-project-metrics-token': projectMetricsToken },
      });
      assert(metricsWithToken.response.status === 200, '/api/project-metrics did not accept the configured token');
    } else {
      assert(metricsNoToken.response.status === 200, '/api/project-metrics should stay available locally when no token is configured');
    }

    const vercelConfig = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
    const headerKeys = new Set((vercelConfig.headers?.[0]?.headers || []).map((entry) => entry.key));
    for (const key of ['Content-Security-Policy', 'Strict-Transport-Security', 'Permissions-Policy', 'X-Content-Type-Options']) {
      assert(headerKeys.has(key), `vercel.json is missing ${key}`);
    }

    console.log('Smoke checks passed.');
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    if (stderr.trim()) process.stderr.write(stderr);
  }
}

run().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
