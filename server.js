const http = require('http');
const { HOST, PORT } = require('./catalyst-server/config');
const { requestHandler } = require('./catalyst-server/app');

const server = http.createServer(requestHandler);

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Catalyst server running at http://${HOST}:${PORT}`);
  });
}

module.exports = { server, requestHandler };
