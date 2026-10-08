const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.TEST_PAGE_HOST || '127.0.0.1';
const PORT = Number(process.env.TEST_PAGE_PORT || 8000);
const TEST_PAGE_PATH = '/extension-test/extension-test.html';
const TEST_PAGE_FILE = path.resolve(__dirname, '../tests/pages/extension-test.html');

const server = http.createServer((req, res) => {
  if (req.url === TEST_PAGE_PATH || req.url === TEST_PAGE_PATH + '?') {
    try {
      const html = fs.readFileSync(TEST_PAGE_FILE);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(html);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unable to load the BLB Suite generic extension test page.\n');
      console.error(error);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found.\n');
});

server.listen(PORT, HOST, () => {
  console.log(`BLB Suite generic extension test page: http://bible.localhost:${PORT}${TEST_PAGE_PATH}`);
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
