import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Effect, type Schema } from "effect";
import { analysisQuestion } from "./analysis-context.js";
import { makeGenieClient, type GenieRequest } from "./chat.js";

export function makeReportAssistant(
  { spaceId, token, host }: { spaceId: string; token: string; host: string },
  dataset: { table: string; filterInstructions: string },
  send: typeof fetch = fetch,
) {
  const origin = new URL(host);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("DATABRICKS_HOST must be an HTTPS workspace origin.");

  const request = ({ path, method, body }: GenieRequest) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await send(new URL(path, origin), {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal,
          redirect: "error",
        });
        if (!response.ok)
          throw new Error(`Genie returned HTTP ${response.status}`);
        return response.json() as Promise<unknown>;
      },
      catch: () => ({
        message: "Could not reach the Genie space. Check workspace access.",
      }),
    });
  const key = randomBytes(32);
  const sign = (id: string) =>
    createHmac("sha256", key).update(id).digest("base64url");
  const client = makeGenieClient({ spaceId, request });
  return (input: {
    question: string;
    continuation: string | null;
    filters: Schema.JsonObject;
    context: Schema.JsonObject;
  }) =>
    Effect.gen(function* () {
      const content = analysisQuestion(dataset, {
        content: input.question,
        filters: input.filters,
        context: input.context,
      });
      let conversationId: string | undefined;
      if (input.continuation !== null) {
        const parts = /^([a-zA-Z0-9-]{1,100})\.([a-zA-Z0-9_-]{43})$/.exec(
          input.continuation,
        );
        const id = parts?.[1],
          signature = parts?.[2];
        if (
          !id ||
          !signature ||
          !timingSafeEqual(Buffer.from(signature), Buffer.from(sign(id)))
        )
          return yield* Effect.fail({ message: "Start a new conversation." });
        conversationId = id;
      }
      const operation = yield* client.submit({
        content,
        ...(conversationId ? { conversationId } : {}),
      });
      const result = yield* client.complete(operation);
      return {
        continuation:
          operation.conversationId + "." + sign(operation.conversationId),
        text: result.attachments.flatMap((a) =>
          a.kind === "text" ? [a.content] : [],
        ),
        tables: result.attachments.flatMap((a) =>
          a.kind === "query"
            ? [
                {
                  columns: a.columns.map((c) => c.name),
                  rows: a.rows.slice(0, 100),
                  truncated:
                    a.truncated === true ||
                    a.rows.length > 100 ||
                    a.nextChunkIndex != null ||
                    (a.totalRowCount ?? 0) > a.rows.length,
                },
              ]
            : [],
        ),
      };
    }).pipe(
      Effect.timeout("2 minutes"),
      Effect.mapError(() => ({
        message:
          "Genie did not return an answer. Check the space and conversation history before retrying.",
      })),
    );
}
