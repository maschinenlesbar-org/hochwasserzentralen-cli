import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { nodeHttpTransport } from "../src/client/http.js";
import { HochwasserzentralenNetworkError } from "../src/client/errors.js";

/** Start a throwaway loopback server for one test and return its base URL. */
async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("performs a real GET and returns status, headers and body", async () => {
  await withServer(
    (req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url, lang: req.headers["accept-language"] ?? null }));
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({
        method: "GET",
        url: `${baseUrl}/data/alerts?states=BY`,
        headers: { "Accept-Language": "de" },
      });
      assert.equal(resp.status, 200);
      const parsed = JSON.parse(resp.body.toString("utf8")) as { path: string; lang: string };
      assert.equal(parsed.path, "/data/alerts?states=BY");
      assert.equal(parsed.lang, "de");
    },
  );
});

test("rejects an unsupported protocol with HochwasserzentralenNetworkError", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "ftp://example.test/x" }),
    HochwasserzentralenNetworkError,
  );
});

test("enforces maxResponseBytes", async () => {
  await withServer(
    (_req, res) => res.end("x".repeat(1000)),
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: 10 }),
        HochwasserzentralenNetworkError,
      );
    },
  );
});
