const fs = require('fs');
const path = require('path');
const { APP_URL, APP_URL_IS_HTTPS, IS_VERCEL, ROOT } = require('./config');

function buildContentSecurityPolicy() {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "img-src 'self' data: https:",
    "font-src 'self' data: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
    "script-src 'self' 'unsafe-inline' data: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://va.vercel-scripts.com",
    "connect-src 'self' https://formsubmit.co https://api.resend.com https://vitals.vercel-insights.com",
    "form-action 'self' https://formsubmit.co",
  ].join('; ');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function readJsonOrReject(req, res, badRequest) {
  try {
    return await readJson(req);
  } catch (error) {
    if (error?.message === 'Invalid JSON') {
      badRequest(res, 'Invalid JSON');
      return null;
    }
    throw error;
  }
}

function securityHeaders(extra = {}) {
  const frameAncestors = APP_URL
    ? `frame-ancestors 'self' ${APP_URL.replace(/\/$/, '')}`
    : "frame-ancestors 'self'";
  const headers = {
    'Content-Security-Policy': buildContentSecurityPolicy().replace("frame-ancestors 'self'", frameAncestors),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    ...(APP_URL_IS_HTTPS || IS_VERCEL ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload' } : {}),
    ...extra,
  };
  return headers;
}

function sendJson(res, status, data) {
  res.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }));
  res.end(JSON.stringify(data));
}

function notFound(res) {
  sendJson(res, 404, { error: 'Not found' });
}

function unauthorized(res) {
  sendJson(res, 401, { error: 'Unauthorized' });
}

function badRequest(res, message) {
  sendJson(res, 400, { error: message });
}

function tooManyRequests(res, message = 'Too many requests. Try again shortly.') {
  sendJson(res, 429, { error: message });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.eot': 'application/vnd.ms-fontobject',
  }[ext] || 'application/octet-stream');
}

function cacheControlFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'no-store';
  if (['.css', '.js'].includes(ext)) return 'public, max-age=3600, stale-while-revalidate=86400';
  if (['.svg', '.png', '.jpg', '.jpeg', '.ico', '.webp', '.gif', '.woff', '.woff2'].includes(ext)) return 'public, max-age=86400, stale-while-revalidate=604800';
  return 'public, max-age=600';
}

function sendStaticFile(res, status, finalPath, buffer) {
  res.writeHead(status, securityHeaders({
    'Content-Type': contentType(finalPath),
    'Cache-Control': cacheControlFor(finalPath),
  }));
  res.end(buffer);
}

function serveStatic(req, res, pathname) {
  const target = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(ROOT, decodeURIComponent(target)));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stats) => {
    if (err) {
      const notFoundPath = path.join(ROOT, '404.html');
      fs.readFile(notFoundPath, (missingErr, buffer) => {
        if (missingErr) {
          res.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }));
          res.end('Not found');
          return;
        }
        sendStaticFile(res, 404, notFoundPath, buffer);
      });
      return;
    }
    const finalPath = stats.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    fs.readFile(finalPath, (readErr, buffer) => {
      if (readErr) {
        const notFoundPath = path.join(ROOT, '404.html');
        fs.readFile(notFoundPath, (missingErr, notFoundBuffer) => {
          if (missingErr) {
            res.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }));
            res.end('Not found');
            return;
          }
          sendStaticFile(res, 404, notFoundPath, notFoundBuffer);
        });
        return;
      }
      sendStaticFile(res, 200, finalPath, buffer);
    });
  });
}

module.exports = {
  badRequest,
  notFound,
  readJsonOrReject,
  sendJson,
  serveStatic,
  tooManyRequests,
  unauthorized,
};
