import { afterAll, beforeAll, expect, test } from "bun:test";
import { serverFetch } from "../modules/https_servers";
import { generateLocalCertificate } from "../utility/local_cert";

// An HTTP/2-only server on this machine, as the Gateway's internal port answers: the first request to it probes
// HTTP/3, which nothing answers, before falling back.
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const cert = await generateLocalCertificate({ validityDays: 1 });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: cert.certPem, key: cert.keyPem },
    http1: false,
    http2: true,
    fetch: () => new Response("ok"),
  } as Parameters<typeof Bun.serve>[0]);
});
afterAll(() => {
  server?.stop(true);
});

test("the first request to a loopback origin without HTTP/3 is not held for the remote probe's wait", async () => {
  const started = performance.now();
  const res = await serverFetch(`https://127.0.0.1:${server.port}/status`);
  const elapsed = performance.now() - started;
  expect(await res.text()).toBe("ok");
  // A QUIC handshake on loopback takes milliseconds; the remote probe waits 2.5 s.
  expect(elapsed).toBeLessThan(1000);
});

test("the origin is then known as HTTP/2 only and answers at once", async () => {
  const started = performance.now();
  const res = await serverFetch(`https://127.0.0.1:${server.port}/status`);
  expect(await res.text()).toBe("ok");
  expect(performance.now() - started).toBeLessThan(500);
});
