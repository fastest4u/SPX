#!/usr/bin/env node

import { connect, createServer } from "node:net";

import { canonicalJson } from "./lib/evidence-artifact.mjs";

function validPort(value, allowZero = false) {
  return Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1) && value <= 65_535;
}

function validateOptions(options) {
  if (
    !options ||
    !["127.0.0.1", "0.0.0.0"].includes(options.listenHost) ||
    !validPort(options.listenPort, true) ||
    typeof options.upstreamHost !== "string" ||
    options.upstreamHost.length < 1 ||
    options.upstreamHost.length > 253 ||
    options.upstreamHost === "staging-db-proxy" ||
    /[\s/@]/.test(options.upstreamHost) ||
    !validPort(options.upstreamPort) ||
    !Number.isSafeInteger(options.maxConnections ?? 64) ||
    (options.maxConnections ?? 64) < 1 ||
    (options.maxConnections ?? 64) > 1_024 ||
    (options.log !== undefined && typeof options.log !== "function")
  ) {
    throw new Error("staging DB proxy configuration is invalid");
  }
  return {
    listenHost: options.listenHost,
    listenPort: options.listenPort,
    upstreamHost: options.upstreamHost,
    upstreamPort: options.upstreamPort,
    maxConnections: options.maxConnections ?? 64,
    log: options.log ?? (() => {}),
  };
}

export async function startStagingDbProxy(options) {
  const config = validateOptions(options);
  const clients = new Set();
  const upstreams = new Set();
  const counters = { accepted: 0, active: 0, rejected: 0, closed: 0, errors: 0 };

  const emit = (event) => {
    config.log(Object.freeze({ event, ...counters }));
  };
  const server = createServer({ allowHalfOpen: true }, (client) => {
    if (counters.active >= config.maxConnections) {
      counters.rejected += 1;
      emit("connection-rejected");
      client.destroy();
      return;
    }
    counters.accepted += 1;
    counters.active += 1;
    clients.add(client);
    emit("connection-opened");
    const upstream = connect({
      host: config.upstreamHost,
      port: config.upstreamPort,
      allowHalfOpen: true,
    });
    upstreams.add(upstream);
    let recordedClose = false;
    const recordClose = () => {
      if (recordedClose) return;
      recordedClose = true;
      clients.delete(client);
      upstreams.delete(upstream);
      counters.active = Math.max(0, counters.active - 1);
      counters.closed += 1;
      emit("connection-closed");
    };
    const closeOnError = () => {
      counters.errors += 1;
      emit("connection-error");
      client.destroy();
      upstream.destroy();
    };
    client.once("error", closeOnError);
    upstream.once("error", closeOnError);
    client.once("close", recordClose);
    client.pipe(upstream).pipe(client);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listenPort, config.listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("staging DB proxy failed to bind");
  }
  let closed = false;
  return Object.freeze({
    port: address.port,
    stats() {
      return Object.freeze({ ...counters });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of clients) socket.destroy();
      for (const socket of upstreams) socket.destroy();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  });
}

function integerEnvironment(name, fallback, allowZero = false) {
  const value = Number(process.env[name] ?? fallback);
  if (!validPort(value, allowZero)) throw new Error("staging DB proxy port is invalid");
  return value;
}

async function main() {
  try {
    if (process.argv.length !== 2) throw new Error("staging DB proxy arguments are forbidden");
    const proxy = await startStagingDbProxy({
      listenHost: process.env.STAGING_DB_PROXY_LISTEN_HOST ?? "0.0.0.0",
      listenPort: integerEnvironment("STAGING_DB_PROXY_LISTEN_PORT", 3306),
      upstreamHost: process.env.STAGING_DB_UPSTREAM_HOST,
      upstreamPort: integerEnvironment("STAGING_DB_UPSTREAM_PORT", 3306),
      maxConnections: Number(process.env.STAGING_DB_PROXY_MAX_CONNECTIONS ?? 64),
      log(event) {
        console.log(canonicalJson(event));
      },
    });
    const shutdown = () => {
      proxy.close().finally(() => {
        process.exitCode = 0;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch {
    console.log(canonicalJson({ event: "startup-failed", ok: false }));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("staging-db-proxy.mjs")) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
