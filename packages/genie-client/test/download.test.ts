import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, Effect, Exit, Fiber, Latch, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import {
  makeGenieDownloadClient,
  type GenieDownloadRequest,
} from "../src/index.js";

const reference = {
  conversationId: "conversation",
  messageId: "message",
  attachmentId: "attachment",
};
const signedFirst =
  "https://first.s3.eu-west-1.amazonaws.com/result?signature=private";
const signedSecond =
  "https://storage.googleapis.com/bucket/second?signature=private";
const accepted = {
  download_id: "download",
  download_id_signature: "test + signature",
};

const prepared = (
  external_link: string,
  options: { truncated?: boolean; count?: number; expiration?: string } = {},
) => ({
  statement_response: {
    statement_id: "statement",
    status: { state: "SUCCEEDED" },
    manifest: {
      format: "CSV",
      truncated: options.truncated ?? false,
      total_chunk_count: options.count ?? 2,
      schema: { columns: [{ name: "trip" }, { name: "count" }] },
    },
    result: {
      external_links: [
        {
          chunk_index: 0,
          external_link,
          ...(options.expiration === undefined
            ? {}
            : { expiration: options.expiration }),
        },
      ],
    },
  },
});

test("downloads every CSV chunk in order using scoped, credentialless storage requests", async () => {
  const calls: GenieDownloadRequest[] = [];
  const fetched: string[] = [];
  const signals: AbortSignal[] = [];
  let firstClosedBeforeSecond = false;
  const client = makeGenieDownloadClient({
    spaceId: "space",
    request(request) {
      return Effect.sync(() => {
        calls.push(request);
        switch (request.kind) {
          case "start":
            return accepted;
          case "poll":
            return prepared(signedFirst);
          case "chunk":
            return {
              external_links: [
                {
                  chunk_index: 1,
                  external_link: signedSecond,
                  http_headers: {
                    "x-goog-project-id": "fixture",
                    Authorization: "private",
                    Cookie: "private",
                  },
                },
              ],
            };
        }
      });
    },
    fetch: async (input, options) => {
      assert.ok(input instanceof URL);
      assert.ok(options?.signal);
      if (input.href === signedSecond)
        firstClosedBeforeSecond = signals[0]?.aborted === true;
      signals.push(options.signal);
      fetched.push(input.href);
      assert.equal(options?.credentials, "omit");
      assert.equal(options?.redirect, "error");
      assert.deepEqual(
        Object.fromEntries(new Headers(options?.headers)),
        input.href === signedFirst ? {} : { "x-goog-project-id": "fixture" },
      );
      return new Response(
        input.href === signedFirst ? "trip,count\r\nA,7" : "B,8\r\n",
      );
    },
  });

  const csv = await Effect.runPromise(
    client.download(reference).pipe(
      Effect.flatMap((bytes) =>
        bytes.pipe(Stream.decodeText, Stream.runCollect),
      ),
      Effect.withSpan("download CSV"),
    ),
  );

  const base =
    "/api/2.0/genie/spaces/space/conversations/conversation/messages/message/attachments/attachment/downloads";
  assert.deepEqual(calls, [
    { kind: "start", method: "POST", path: base },
    {
      kind: "poll",
      method: "GET",
      path: `${base}/download?download_id_signature=test+%2B+signature`,
    },
    {
      kind: "chunk",
      method: "GET",
      path: "/api/2.0/sql/statements/statement/result/chunks/1",
    },
  ]);
  assert.deepEqual(fetched, [signedFirst, signedSecond]);
  assert.equal(firstClosedBeforeSecond, true);
  assert.deepEqual(
    signals.map((signal) => signal.aborted),
    [true, true],
  );
  assert.equal(csv.join(""), "trip,count\r\nA,7\r\nB,8\r\n");
});

test("streams signed downloads from Databricks regional storage", async () => {
  const link =
    "https://us-east-2.storage.cloud.databricks.com/results?signature=private";
  const client = makeGenieDownloadClient({
    spaceId: "space",
    request: ({ kind }) =>
      Effect.succeed(
        kind === "start" ? accepted : prepared(link, { count: 1 }),
      ),
    fetch: async (url, init) => {
      assert.ok(url instanceof URL);
      assert.equal(url.href, link);
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.redirect, "error");
      return new Response("trip,count\r\nA,7\r\n");
    },
  });
  const csv = await Effect.runPromise(
    client
      .download(reference)
      .pipe(
        Effect.flatMap((bytes) =>
          bytes.pipe(Stream.decodeText, Stream.runCollect),
        ),
      ),
  );
  assert.equal(csv.join(""), "trip,count\r\nA,7\r\n");
});

test("polls CSV preparation immediately and waits two seconds between pending responses", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis;
      const pollTimes: number[] = [];
      const ready = prepared(signedFirst, { count: 0 });
      const client = makeGenieDownloadClient({
        spaceId: "space",
        request: ({ kind }) =>
          Effect.gen(function* () {
            if (kind === "start") return accepted;
            assert.equal(kind, "poll");
            pollTimes.push((yield* Clock.currentTimeMillis) - start);
            const state = ["PENDING", "RUNNING"][pollTimes.length - 1];
            return state
              ? { statement_response: { status: { state } } }
              : ready;
          }),
      });
      const transfer = yield* client.download(reference).pipe(Effect.forkChild);
      yield* TestClock.adjust("4 seconds");
      const csv = yield* Fiber.join(transfer);
      const lines = yield* csv.pipe(Stream.decodeText, Stream.runCollect);
      assert.deepEqual(pollTimes, [0, 2000, 4000]);
      assert.equal(lines.join(""), '"trip","count"\r\n');
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("does not fetch an unrecognized URL or deliver a Databricks-truncated result", async () => {
  for (const [data, message] of [
    [
      prepared(
        "https://bucket.s3.amazonaws.com.attacker.invalid/?secret=private",
      ),
      /unrecognized CSV storage location/,
    ],
    [
      prepared(signedFirst, { truncated: true }),
      /Databricks truncated the CSV/,
    ],
  ] as const) {
    const client = makeGenieDownloadClient({
      spaceId: "space",
      request: ({ kind }) => Effect.succeed(kind === "start" ? accepted : data),
      fetch: async () => assert.fail("unexpected storage request"),
    });
    await assert.rejects(
      () =>
        Effect.runPromise(
          client.download(reference).pipe(Effect.flatMap(Stream.runDrain)),
        ),
      message,
    );
  }
});

test("cancels the CSV storage body when it stops delivering bytes", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const received = Latch.makeUnsafe();
      let cancelled = false;
      const client = makeGenieDownloadClient({
        spaceId: "space",
        request: ({ kind }) =>
          Effect.succeed(
            kind === "start" ? accepted : prepared(signedFirst, { count: 1 }),
          ),
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("trip,count\r\n"));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      });
      const csv = yield* client.download(reference);
      const transfer = yield* Stream.runForEach(csv, () => received.open).pipe(
        Effect.forkChild,
      );

      yield* received.await;
      yield* TestClock.adjust("30 seconds");

      const exit = transfer.pollUnsafe();
      assert.ok(exit, "The idle timeout must end the transfer");
      assert.ok(Exit.isFailure(exit), "An incomplete CSV must fail");
      assert.equal(cancelled, true);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

for (const link of ["expired", "rejected", "stalled cleanup"] as const) {
  const knownExpired = link === "expired";
  const stallsDuringCleanup = link === "stalled cleanup";
  test(
    knownExpired
      ? "refreshes known expired CSV links without attempting storage"
      : stallsDuringCleanup
        ? "refreshes a rejected signed CSV link even when body cancellation stalls"
        : "refreshes a rejected signed CSV link once",
    async () => {
      const fetched: string[] = [];
      const calls: GenieDownloadRequest["kind"][] = [];
      const cancelStarted = Latch.makeUnsafe();
      let rejectedBodyCancelled = false;
      let rejectedSignal: AbortSignal | undefined;
      let abortedBeforeCancel = false;
      const client = makeGenieDownloadClient({
        spaceId: "space",
        request: ({ kind }) =>
          Effect.sync(() => {
            calls.push(kind);
            switch (kind) {
              case "start":
                return accepted;
              case "poll":
                return prepared(signedFirst, {
                  count: 1,
                  ...(knownExpired
                    ? { expiration: "2000-01-01T00:00:00Z" }
                    : {}),
                });
              case "chunk":
                if (!knownExpired) {
                  assert.equal(rejectedBodyCancelled, true);
                  assert.equal(rejectedSignal?.aborted, true);
                }
                return {
                  external_links: [
                    { chunk_index: 0, external_link: signedSecond },
                  ],
                };
            }
          }),
        fetch: async (url, init) => {
          assert.ok(url instanceof URL);
          fetched.push(url.href);
          if (url.href !== signedFirst)
            return new Response("trip,count\r\nA,7\r\n");
          rejectedSignal = init?.signal ?? undefined;
          return new Response(
            new ReadableStream({
              cancel() {
                rejectedBodyCancelled = true;
                abortedBeforeCancel = rejectedSignal?.aborted === true;
                cancelStarted.openUnsafe();
                return stallsDuringCleanup
                  ? new Promise<void>(() => undefined)
                  : undefined;
              },
            }),
            { status: 403 },
          );
        },
      });
      const readCsv = client
        .download(reference)
        .pipe(
          Effect.flatMap((bytes) =>
            bytes.pipe(Stream.decodeText, Stream.runCollect),
          ),
        );
      const csv = await Effect.runPromise(
        stallsDuringCleanup
          ? Effect.gen(function* () {
              const transfer = yield* Effect.forkChild(readCsv);
              yield* cancelStarted.await;
              yield* TestClock.adjust("1 second");
              assert.deepEqual(calls, ["start", "poll", "chunk"]);
              assert.equal(abortedBeforeCancel, true);
              return yield* Fiber.join(transfer);
            }).pipe(Effect.provide(TestClock.layer()))
          : readCsv,
      );

      assert.deepEqual(calls, ["start", "poll", "chunk"]);
      assert.deepEqual(
        fetched,
        knownExpired ? [signedSecond] : [signedFirst, signedSecond],
      );
      assert.equal(csv.join(""), "trip,count\r\nA,7\r\n");
    },
  );
}
