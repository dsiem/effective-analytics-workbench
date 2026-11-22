import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Latch,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlError } from "effect/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";
import { Credentials, DatabricksClient } from "../src/index.js";
import { listen } from "./http.js";

for (const policy of ["workspace", "download", "oauth"] as const) {
  test(`${policy} transport rejects redirects without forwarding credentials`, async (t) => {
    let redirected = 0;
    const target = await listen(async (_req, res) => {
      redirected++;
      res.end("unexpected redirect");
    });
    t.after(target.close);
    const requests: Array<{ path: string; authorization: string | undefined }> =
      [];
    const server = await listen(async (req, res) => {
      requests.push({
        path: req.url ?? "",
        authorization: req.headers.authorization,
      });
      if (policy === "download" && req.url === "/api/2.0/sql/statements") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            statement_id: "statement",
            status: { state: "SUCCEEDED" },
            manifest: { format: "ARROW_STREAM", total_chunk_count: 1 },
            result: {
              external_links: [
                {
                  chunk_index: 0,
                  external_link: `${server.origin}/signed?signature=private-signature`,
                },
              ],
            },
          }),
        );
        return;
      }
      res.writeHead(307, { Location: `${target.origin}/redirected` });
      res.end();
    });
    t.after(server.close);
    const result = await Effect.runPromise(
      Effect.result(
        policy === "oauth"
          ? Credentials.clientCredentials({
              host: server.origin,
              clientId: "client",
              clientSecret: Redacted.make("private-secret"),
            })
          : Effect.gen(function* () {
              const sql = yield* DatabricksClient.DatabricksClient;
              yield* sql.arrow(sql`SELECT 1`);
            }).pipe(
              Effect.provide(
                DatabricksClient.layer({
                  host: server.origin,
                  warehouseId: "warehouse",
                  accessToken: Effect.succeed(Redacted.make("private-secret")),
                }),
              ),
            ),
      ),
    );
    assert.equal(result._tag, "Failure");
    assert.equal(redirected, 0);
    assert.equal(requests.length, policy === "download" ? 2 : 1);
    assert.equal(
      requests.at(-1)?.authorization,
      policy === "download"
        ? undefined
        : policy === "workspace"
          ? "Bearer private-secret"
          : `Basic ${Buffer.from("client:private-secret").toString("base64")}`,
    );
    if (result._tag === "Failure")
      assert.doesNotMatch(
        JSON.stringify(result.failure),
        /private-secret|private-signature/,
      );
  });
}

for (const stop of ["interruption", "deadline"] as const) {
  test(
    `OAuth ${stop} aborts the response body and releases refresh for retry`,
    {
      timeout: 5000,
    },
    async () => {
      let attempts = 0;
      let signal: AbortSignal | null | undefined;
      const started = Latch.makeUnsafe();
      const provider = Credentials.clientCredentials({
        host: "https://workspace.example",
        clientId: "client",
        clientSecret: Redacted.make("secret"),
        fetch: async (_input, init) => {
          attempts++;
          assert.equal(init?.credentials, "omit");
          assert.equal(init?.redirect, "error");
          if (attempts > 1)
            return Response.json({
              access_token: "fresh-token",
              token_type: "Bearer",
              expires_in: 3600,
            });
          signal = init?.signal;
          return new Response(
            new ReadableStream({
              start(controller) {
                signal?.addEventListener(
                  "abort",
                  () => controller.error(new Error("aborted")),
                  { once: true },
                );
                started.openUnsafe();
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        },
      });
      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* provider.pipe(Effect.forkChild);
          yield* started.await;
          if (stop === "deadline") yield* TestClock.adjust("30 seconds");
          else yield* Fiber.interrupt(fiber);
          const exit = yield* Fiber.await(fiber);
          assert.equal(Redacted.value(yield* provider), "fresh-token");
          return exit;
        }).pipe(Effect.provide(TestClock.layer())),
      );
      assert.ok(Exit.isFailure(exit));
      if (stop === "interruption") assert.ok(Cause.hasInterrupts(exit.cause));
      else {
        const error = Cause.squash(exit.cause);
        assert.ok(error instanceof SqlError);
        assert.equal(error.reason._tag, "StatementTimeoutError");
      }
      assert.equal(signal?.aborted, true);
      assert.equal(attempts, 2);
    },
  );
}

for (const stage of ["submission", "poll", "download"] as const) {
  test(`retrying a statement on isRetryable never replays SQL after a ${stage} failure`, async () => {
    let submissions = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (init?.method === "POST" && !url.endsWith("/cancel")) {
        submissions++;
        if (stage === "submission") throw new TypeError("Connection lost");
        return Response.json(
          stage === "poll"
            ? {
                statement_id: "s",
                status: { state: "RUNNING" },
              }
            : {
                statement_id: "s",
                status: { state: "SUCCEEDED" },
                manifest: { format: "ARROW_STREAM", total_chunk_count: 1 },
                result: {
                  external_links: [
                    {
                      chunk_index: 0,
                      external_link: "https://storage.example/chunk",
                    },
                  ],
                },
              },
        );
      }
      return new Response(null, { status: 503 });
    };
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* DatabricksClient.DatabricksClient;
        return yield* Effect.flip(
          sql
            .arrow(sql`SELECT 1`)
            .pipe(
              Effect.retry({ while: (error) => error.isRetryable, times: 1 }),
            ),
        );
      }).pipe(
        Effect.provide(
          DatabricksClient.layer({
            host: "https://workspace.example",
            warehouseId: "warehouse",
            accessToken: Effect.succeed(Redacted.make("token")),
            pollInterval: 1,
            fetch,
          }),
        ),
      ),
    );
    assert.equal(submissions, 1);
    assert.equal(error.isRetryable, false);
    assert.equal(
      error.reason.operation,
      stage === "submission" ? "submit" : stage,
    );
  });
}

test("workspace HTTP middleware applies only to Statement Execution requests", async () => {
  const workspaceRequests: string[] = [];
  const downloads: string[] = [];
  const workspaceHttpClient = HttpClient.make((request, url) => {
    workspaceRequests.push(url.hostname);
    assert.equal(request.headers.authorization, "Bearer workspace-token");
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          statement_id: "statement",
          status: { state: "SUCCEEDED" },
          manifest: { format: "ARROW_STREAM", total_chunk_count: 1 },
          result: {
            external_links: [
              {
                chunk_index: 0,
                external_link: "https://storage.example/chunk",
              },
            ],
          },
        }),
      ),
    );
  });
  const config: DatabricksClient.DatabricksClientConfig = {
    host: "https://workspace.example",
    warehouseId: "example",
    accessToken: Effect.succeed(Redacted.make("workspace-token")),
    workspaceHttpClient,
    fetch: async (input, init) => {
      const { hostname } = new URL(
        input instanceof Request ? input.url : input,
      );
      downloads.push(hostname);
      assert.equal(hostname, "storage.example");
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      return new Response(new Uint8Array([1, 2, 3]));
    },
  };
  const chunks = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      return yield* Stream.runCollect(sql.ipcStream(sql`SELECT 1`));
    }).pipe(Effect.provide(DatabricksClient.layer(config))),
  );
  assert.deepEqual(chunks, [new Uint8Array([1, 2, 3])]);
  assert.deepEqual(workspaceRequests, ["workspace.example"]);
  assert.deepEqual(downloads, ["storage.example"]);
});

test("a rejected submission can retry while a gateway timeout preserves its uncertain outcome", async () => {
  for (const [status, retryable] of [
    [429, true],
    [504, false],
  ] as const) {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* DatabricksClient.DatabricksClient;
        return yield* Effect.flip(sql`SELECT 1`);
      }).pipe(
        Effect.provide(
          DatabricksClient.layer({
            host: "https://workspace.example",
            warehouseId: "warehouse",
            accessToken: Effect.succeed(Redacted.make("token")),
            fetch: async () => new Response(null, { status }),
          }),
        ),
      ),
    );
    assert.equal(error.isRetryable, retryable);
    const encoded = Schema.encodeSync(SqlError)(error);
    const decoded = Schema.decodeUnknownSync(SqlError)(
      JSON.parse(JSON.stringify(encoded)),
    );
    assert.equal(decoded.isRetryable, retryable);
    if (status === 504) {
      assert.deepEqual(decoded.reason.cause, {
        reason: "StatementTimeoutError",
      });
      assert.equal(decoded.reason.operation, "submit");
    }
  }
});
