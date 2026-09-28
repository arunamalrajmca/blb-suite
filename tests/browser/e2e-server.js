const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.env.PORT || 4173);

http.createServer((req, res) => {
  const requestPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.resolve(root, '.' + (requestPath === '/' ? '/selection-fixture.html' : requestPath));
  if (!file.startsWith(root)) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain'});
    res.end(data);
  });
}).listen(port, '127.0.0.1');
