const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');

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

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
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
  }[ext] || 'application/octet-stream');
}

function serveStatic(req, res, pathname) {
  const target = pathname === '/' ? '/landing-page/index.html' : pathname;
  const filePath = path.normalize(path.join(ROOT, decodeURIComponent(target)));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stats) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const finalPath = stats.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    fs.readFile(finalPath, (readErr, buffer) => {
      if (readErr) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType(finalPath), 'Cache-Control': 'no-store' });
      res.end(buffer);
    });
  });
}

module.exports = {
  badRequest,
  notFound,
  readJsonOrReject,
  sendJson,
  serveStatic,
  unauthorized,
};
