import assert from "node:assert/strict";
import { createConnection, createServer, type AddressInfo, type Server } from "node:net";

import { startStagingDbProxy } from "../scripts/staging-db-proxy.mjs";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function roundTrip(port: number, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => socket.end(payload));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => resolve(Buffer.concat(chunks)));
    socket.once("error", reject);
  });
}

async function main(): Promise<void> {
  const upstream = createServer((socket) => socket.pipe(socket));
  const upstreamPort = await listen(upstream);
  const logs: unknown[] = [];
  const proxy = await startStagingDbProxy({
    listenHost: "127.0.0.1",
    listenPort: 0,
    upstreamHost: "127.0.0.1",
    upstreamPort,
    log(event: unknown) {
      logs.push(event);
    },
  });

  const payload = Buffer.from("mysql-handshake-fixture");
  assert.equal((await roundTrip(proxy.port, payload)).toString(), payload.toString());
  assert.equal(proxy.stats().accepted, 1);
  assert.equal(proxy.stats().active, 0);
  assert.equal(JSON.stringify(logs).includes(payload.toString()), false);

  await proxy.close();
  await assert.rejects(() => roundTrip(proxy.port, Buffer.from("x")), /ECONNREFUSED|connect/i);
  await close(upstream);

  await assert.rejects(
    () =>
      startStagingDbProxy({
        listenHost: "0.0.0.0",
        listenPort: -1,
        upstreamHost: "mysql.example.test",
        upstreamPort: 3306,
      }),
    /configuration/i,
  );

  console.log("staging DB proxy tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
