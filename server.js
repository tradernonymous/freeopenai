const http = require('http');
const fs = require('fs');
const path = require('path');

const port = process.env.PORT || 3000;
const rootDir = __dirname;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function resolveSafePath(root, urlPath) {
  let clean = urlPath.split('?')[0].split('#')[0];
  if (clean === '/') clean = '/index.html';
  const resolved = path.join(root, path.normalize(clean).replace(/^([/\\])+/, ''));
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

function isAssetPath(urlPath) {
  return path.extname(urlPath.split('?')[0]) !== '';
}

function createRequestHandler(root) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return;
    }

    const file = resolveSafePath(root, req.url);
    if (!file) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        if (isAssetPath(req.url)) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        fs.readFile(path.join(root, 'index.html'), (e2, html) => {
          if (e2) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(req.method === 'HEAD' ? undefined : html);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  };
}

if (require.main === module) {
  http.createServer(createRequestHandler(rootDir)).listen(port, () => console.log(`Serving on port ${port}`));
}

module.exports = { resolveSafePath, isAssetPath, createRequestHandler };
