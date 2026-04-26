import http from 'node:http';

const PORT = process.env.PORT ?? 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <!DOCTYPE html>
    <html>
      <head><title>Updraft Sample App</title></head>
      <body>
        <h1>Hello from Updraft!</h1>
        <p>Deployed at: ${new Date().toISOString()}</p>
        <p>Request: ${req.method} ${req.url}</p>
      </body>
    </html>
  `);
});

server.listen(PORT, () => {
  console.log(\`Sample app listening on port \${PORT}\`);
});
