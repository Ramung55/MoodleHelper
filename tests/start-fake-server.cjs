const http = require('node:http');
http.createServer((req, res) => { res.writeHead(200); res.end('ok'); }).listen(Number(process.argv[2]), '127.0.0.1');
