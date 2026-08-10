import { connect, createServer } from "node:net";

const mappings = [
  { listenPort: 15432, targetHost: "business-db", targetPort: 5432 },
  { listenPort: 15433, targetHost: "hatchet-db", targetPort: 5432 },
  { listenPort: 15000, targetHost: "moto", targetPort: 5000 },
  { listenPort: 18888, targetHost: "hatchet-lite", targetPort: 8888 },
  { listenPort: 18733, targetHost: "hatchet-lite", targetPort: 8733 },
];

const servers = [];

for (const mapping of mappings) {
  const server = createServer((downstream) => {
    const upstream = connect({ host: mapping.targetHost, port: mapping.targetPort });
    downstream.pipe(upstream);
    upstream.pipe(downstream);
    const close = () => {
      downstream.destroy();
      upstream.destroy();
    };
    downstream.once("error", close);
    upstream.once("error", close);
  });
  server.on("error", (error) => {
    process.stderr.write(`Recovery host access port ${mapping.listenPort} failed: ${error.message}\n`);
    process.exitCode = 1;
    for (const active of servers) active.close();
  });
  server.listen(mapping.listenPort, "0.0.0.0");
  servers.push(server);
}

function stop() {
  for (const server of servers) server.close();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
