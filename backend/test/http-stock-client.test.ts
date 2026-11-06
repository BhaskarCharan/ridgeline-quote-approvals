import { pino } from "pino";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STOCK_CLIENT_OPTIONS,
  HttpStockClient,
  type HttpStockClientOptions,
} from "../src/adapters/http-stock-client.js";

type Step = Response | Error | ((url: URL) => Response);

/** A scripted fetch: each call consumes the next step. Records requested URLs. */
function scriptedFetch(steps: Step[]): { fetch: typeof fetch; calls: URL[] } {
  const calls: URL[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url);
    const step = steps.shift();
    if (step === undefined) throw new Error(`unexpected extra call #${calls.length}`);
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(url) : step;
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const reading = (part: string) => ({ part_number: part, warehouses: { DAL: 5, PHX: 0, ATL: 1 }, as_of: "2026-10-12T08:00:00-05:00" });
const ok = (parts: string[], notFound: string[] = []) => json(200, { items: parts.map(reading), not_found: notFound });
const unavailable = (retryAfterSeconds = 2) =>
  json(503, { error: "service_unavailable", retry_after_seconds: retryAfterSeconds });
const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
const networkError = () => new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8080") });

function makeClient(steps: Step[], overrides: Partial<HttpStockClientOptions> = {}) {
  const { fetch, calls } = scriptedFetch(steps);
  const sleeps: number[] = [];
  const client = new HttpStockClient(
    { ...DEFAULT_STOCK_CLIENT_OPTIONS, baseUrl: "http://stock.test", ...overrides },
    {
      logger: pino({ level: "silent" }),
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
    },
  );
  return { client, calls, sleeps };
}

describe("HttpStockClient", () => {
  it("returns items and not-found parts from the batch endpoint", async () => {
    const { client, calls } = makeClient([ok(["RL1"], ["RL120374"])]);
    const result = await client.getStock(["RL1", "RL120374", "RL1"]);

    expect(result).toEqual({ ok: true, items: [reading("RL1")], notFound: ["RL120374"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pathname).toBe("/v1/stock");
    expect(calls[0]?.searchParams.get("part_numbers")).toBe("RL1,RL120374"); // de-duplicated
  });

  it("does not call the API for an empty list", async () => {
    const { client, calls } = makeClient([]);
    expect(await client.getStock([])).toEqual({ ok: true, items: [], notFound: [] });
    expect(calls).toHaveLength(0);
  });

  it("splits more than 50 parts into batches of at most 50", async () => {
    const parts = Array.from({ length: 120 }, (_, i) => `P${i}`);
    const { client, calls } = makeClient([
      (url) => ok(url.searchParams.get("part_numbers")!.split(",")),
      (url) => ok(url.searchParams.get("part_numbers")!.split(",")),
      (url) => ok(url.searchParams.get("part_numbers")!.split(",")),
    ]);
    const result = await client.getStock(parts);

    expect(calls.map((u) => u.searchParams.get("part_numbers")!.split(",").length)).toEqual([50, 50, 20]);
    expect(result.ok && result.items).toHaveLength(120);
  });

  it("retries a 503, honouring retry_after_seconds, then succeeds", async () => {
    const { client, calls, sleeps } = makeClient([unavailable(2), ok(["RL1"])]);
    const result = await client.getStock(["RL1"]);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]); // hint (2s) beats backoff (~150ms)
  });

  it("caps a huge retry_after_seconds hint at 5s", async () => {
    const { client, sleeps } = makeClient([unavailable(600), ok(["RL1"])]);
    await client.getStock(["RL1"]);
    expect(sleeps).toEqual([5000]);
  });

  it("backs off exponentially with jitter when there is no hint", async () => {
    // random()=0.5 -> delay = step/2 + 0.5*step/2 = 0.75*step; steps 200, 400.
    const { client, sleeps } = makeClient([timeoutError(), networkError(), ok(["RL1"])]);
    const result = await client.getStock(["RL1"]);
    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([150, 300]);
  });

  it("gives up after 3 attempts and reports stock unavailable without throwing", async () => {
    const { client, calls, sleeps } = makeClient([unavailable(0), unavailable(0), unavailable(0)]);
    const result = await client.getStock(["RL1"]);

    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2); // no sleep after the final attempt
    expect(result).toEqual({ ok: false, reason: "stock unavailable after 3 attempts (last error: HTTP 503)" });
  });

  it("retries timeouts and network errors", async () => {
    const { client, calls } = makeClient([timeoutError(), timeoutError(), networkError()]);
    const result = await client.getStock(["RL1"]);
    expect(calls).toHaveLength(3);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("network error: fetch failed (connect ECONNREFUSED");
  });

  it.each([400, 404, 500])("does not retry HTTP %i", async (status) => {
    const { client, calls, sleeps } = makeClient([json(status, { error: "x" })]);
    const result = await client.getStock(["RL1"]);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(result).toEqual({ ok: false, reason: `stock API error: HTTP ${status}` });
  });

  it("does not retry a malformed 200 body", async () => {
    const { client, calls } = makeClient([json(200, { items: [{ part_number: "RL1" }] })]);
    const result = await client.getStock(["RL1"]);
    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/^stock API error: malformed response/);
  });

  it("fails the whole lookup if any batch is exhausted", async () => {
    const parts = Array.from({ length: 60 }, (_, i) => `P${i}`);
    const { client, calls } = makeClient([ok(parts.slice(0, 50)), unavailable(0), unavailable(0), unavailable(0)]);
    const result = await client.getStock(parts);
    expect(calls).toHaveLength(4);
    expect(result.ok).toBe(false);
  });

  it("never throws, even if fetch itself misbehaves", async () => {
    const { client } = makeClient([new RangeError("boom")]);
    await expect(client.getStock(["RL1"])).resolves.toEqual({ ok: false, reason: "stock API error: boom" });
  });

  it("enforces the per-attempt timeout with a real AbortSignal", async () => {
    // A fetch that only settles when aborted, to prove the signal is wired.
    const hangingFetch = ((_url: URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const client = new HttpStockClient(
      { ...DEFAULT_STOCK_CLIENT_OPTIONS, baseUrl: "http://stock.test", timeoutMs: 20, maxAttempts: 2 },
      { logger: pino({ level: "silent" }), fetch: hangingFetch, sleep: async () => {} },
    );
    expect(await client.getStock(["RL1"])).toEqual({
      ok: false,
      reason: "stock unavailable after 2 attempts (last error: timeout after 20 ms)",
    });
  });
});
