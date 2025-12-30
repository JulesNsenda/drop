#!/usr/bin/env node
/**
 * Simple Static File Server
 *
 * A lightweight static file server for serving static sites.
 * Used by DROP to serve static/SPA applications.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'font/otf',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const port = parseInt(process.env.PORT || '3000', 10);
const rootDir = process.argv[2] || process.cwd();
const spaMode = process.argv.includes('--spa') || process.argv.includes('-s');

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function serveFile(res: http.ServerResponse, filePath: string): void {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      if (spaMode) {
        // SPA mode: serve index.html for missing files
        const indexPath = path.join(rootDir, 'index.html');
        fs.readFile(indexPath, (indexErr, data) => {
          if (indexErr) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
          }
        });
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      }
      return;
    }

    const mimeType = getMimeType(filePath);
    res.writeHead(200, { 'Content-Type': mimeType });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', () => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('500 Internal Server Error');
    });
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url || '/', true);
  let pathname = decodeURIComponent(parsedUrl.pathname || '/');

  // Security: prevent directory traversal
  pathname = pathname.replace(/\.\./g, '');

  let filePath = path.join(rootDir, pathname);

  // If requesting a directory, try to serve index.html
  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    serveFile(res, filePath);
  });
});

server.listen(port, () => {
  console.log(`Static server running at http://localhost:${port}`);
  console.log(`Serving files from: ${rootDir}`);
  if (spaMode) {
    console.log('SPA mode enabled');
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use`);
    process.exit(1);
  }
  console.error('Server error:', err);
  process.exit(1);
});
