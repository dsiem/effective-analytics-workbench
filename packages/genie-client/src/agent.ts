import { Effect, Option, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import {
  type GenieAnswer,
  type GenieAttachment,
  queryRowsMatchMetadata,
} from "./answer.js";
import {
  decode,
  GenieId,
  GenieMessageUnavailable,
  type GenieProgress,
  GenieResponseError,
} from "./protocol.js";

export const GenieAgentPhase = Schema.Literals([
  "analyzing",
  "running-sql",
  "preparing-report",
]);
export type GenieAgentPhase = typeof GenieAgentPhase.Type;

export interface GenieAgentOperation {
  readonly conversationId: string;
  readonly responseId: string;
}

type SubmitBody = {
  readonly input: ReadonlyArray<{
    readonly type: "message";
    readonly role: "user";
    readonly content: ReadonlyArray<{
      readonly type: "input_text";
      readonly text: string;
    }>;
  }>;
  readonly conversation_id?: string;
};

export type GenieAgentSubmitRequest = {
  readonly method: "POST";
  readonly path: string;
  readonly body: SubmitBody;
};

export type GenieAgentJsonRequest =
  | {
      readonly kind: "agent-cancel";
      readonly method: "POST";
      readonly path: string;
      readonly body?: never;
    }
  | {
      readonly kind: "agent-items";
      readonly method: "GET";
      readonly path: string;
      readonly body?: never;
    };

const Acceptance = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("response.created"),
    response: Schema.Struct({ id: GenieId, conversation_id: GenieId }),
  }),
);

const readGenieAgentAcceptance = <E>(body: Stream.Stream<Uint8Array, E>) =>
  Stream.suspend(() => {
    let accepted: string | undefined;
    const parser = Sse.makeParser((event) => {
      if (event._tag === "Event" && event.event === "response.created") {
        accepted = event.data;
        // Reset stops feed from parsing the rest of this chunk.
        parser.reset();
      }
    });

    return body.pipe(
      Stream.decodeText,
      Stream.mapEffect((chunk) => {
        const cause = accepted === undefined ? parser.feed(chunk) : undefined;
        return cause === undefined
          ? Effect.succeed(accepted)
          : Effect.fail(new GenieResponseError({ cause }));
      }),
      Stream.filter((data) => data !== undefined),
    );
  }).pipe(
    Stream.runHead,
    Effect.flatMap((data) =>
      Option.isSome(data)
        ? decode(Acceptance, data.value)
        : Effect.fail(
            new GenieResponseError({
              cause: new Error("Genie stream ended before response.created"),
            }),
          ),
    ),
    Effect.map(({ response }) => ({
      conversationId: response.conversation_id,
      responseId: response.id,
    })),
  );

const Cancellation = Schema.Struct({ status: Schema.String });

const Item = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  role: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Unknown),
});
type Item = typeof Item.Type;

const Page = Schema.Struct({
  data: Schema.Array(Item),
  status: Schema.String,
  has_more: Schema.Boolean,
  last_id: Schema.optionalKey(Schema.String),
});

const Report = Schema.Array(
  Schema.Struct({
    type: Schema.String,
    text: Schema.optionalKey(Schema.String),
    metadata: Schema.optionalKey(Schema.Unknown),
  }),
);

const Table = Schema.Struct({
  status: Schema.Literal("available"),
  sql: Schema.String,
  columns: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.optionalKey(Schema.String),
    }),
  ),
  preview_rows: Schema.Array(Schema.Array(Schema.NullOr(Schema.String))),
  total_row_count: Schema.optionalKey(Schema.NullOr(Schema.Natural)),
}).check(
  Schema.makeFilter(({ columns, preview_rows, total_row_count }) =>
    queryRowsMatchMetadata(preview_rows, columns.length, total_row_count),
  ),
);

const decodeTable = Schema.decodeUnknownOption(Table);
const userInput = (item: Item) =>
  item.type === "message" && item.role === "user";
const responseNotVisible = "RESPONSE_NOT_VISIBLE";

const stateOf = (status: string): GenieProgress["state"] | "cancelled" => {
  switch (status.toLowerCase()) {
    case "completed":
      return "completed";
    case "failed":
    case "query_result_expired":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "pending";
  }
};

const phaseOf = (items: ReadonlyArray<Item>): GenieAgentPhase => {
  const latest = items.at(-1);
  if (latest?.type === "message" && latest.role === "assistant")
    return "preparing-report";
  if (
    latest?.type === "function_call" ||
    (latest?.type === "function_call_output" && latest.status === "in_progress")
  )
    return "running-sql";
  return "analyzing";
};

export const makeGenieAgentClient = <
  E,
  R,
  StreamError,
  StreamRequirements,
>(options: {
  readonly agentId: string;
  readonly requestJson: (
    request: GenieAgentJsonRequest,
  ) => Effect.Effect<unknown, E, R>;
  readonly requestEvents: (
    request: GenieAgentSubmitRequest,
    read: typeof readGenieAgentAcceptance,
  ) => Effect.Effect<
    GenieAgentOperation,
    GenieResponseError | StreamError,
    StreamRequirements
  >;
}) => {
  const { requestJson, requestEvents } = options;
  const agent = `/api/2.0/genie/agents/${encodeURIComponent(options.agentId)}`;

  const submit = (input: {
    readonly content: string;
    readonly conversationId?: string;
  }) =>
    Effect.gen(function* () {
      return yield* requestEvents(
        {
          method: "POST",
          path: `${agent}/responses`,
          body: {
            input: [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: input.content }],
              },
            ],
            ...(input.conversationId === undefined
              ? {}
              : { conversation_id: input.conversationId }),
          },
        },
        readGenieAgentAcceptance,
      );
    }).pipe(Effect.withSpan("genie.agent.submit"));

  const readTurn = ({ conversationId, responseId }: GenieAgentOperation) =>
    Effect.gen(function* () {
      const path = `${agent}/conversations/${encodeURIComponent(conversationId)}/items`;
      const marker = `${responseId}_input`;
      const query = new URLSearchParams({ order: "desc" });
      const cursors = new Set<string>();
      const items: Item[] = [];
      let latestStatus: string | undefined;
      let latestTurn = true;
      while (true) {
        const data = yield* requestJson({
          kind: "agent-items",
          method: "GET",
          path: `${path}?${query.toString()}`,
        });
        const page = yield* decode(Page, data);
        latestStatus ??= page.status;
        for (const item of page.data) {
          if (!userInput(item)) {
            items.push(item);
            continue;
          }
          if (item.id === marker) {
            // The page status describes only the conversation's latest turn.
            const last = items.find(
              (entry) =>
                entry.type === "message" &&
                (entry.role === "assistant" || entry.role === "system"),
            );
            return {
              kind: "found" as const,
              items: items.reverse(),
              status: latestTurn
                ? latestStatus
                : last?.role === "assistant"
                  ? (last.status ?? "completed")
                  : "failed",
            };
          }
          latestTurn = false;
          items.length = 0;
        }
        if (!page.has_more) return { kind: "unresolved" as const };
        if (!page.last_id || cursors.has(page.last_id)) {
          return yield* new GenieResponseError({
            cause: new Error("Genie returned an invalid items cursor"),
          });
        }
        cursors.add(page.last_id);
        query.set("after", page.last_id);
      }
    });

  const poll = (operation: GenieAgentOperation) =>
    readTurn(operation).pipe(
      Effect.map((turn) => {
        if (turn.kind === "unresolved")
          return {
            ...operation,
            state: "unresolved" as const,
            status: responseNotVisible,
          };
        const { status, items } = turn;
        const state = stateOf(status);
        return {
          ...operation,
          status,
          state,
          ...(state === "pending" ? { phase: phaseOf(items) } : {}),
        };
      }),
      Effect.withSpan("genie.agent.poll"),
    );

  const cancel = (operation: GenieAgentOperation) =>
    Effect.gen(function* () {
      const { conversationId, responseId } = operation;
      const data = yield* requestJson({
        kind: "agent-cancel",
        method: "POST",
        path: `${agent}/conversations/${encodeURIComponent(conversationId)}/responses/${encodeURIComponent(responseId)}/cancel`,
      });
      const { status } = yield* decode(Cancellation, data);
      return { ...operation, status, state: stateOf(status) };
    }).pipe(Effect.withSpan("genie.agent.cancel"));

  const result = (operation: GenieAgentOperation) =>
    Effect.gen(function* () {
      const turn = yield* readTurn(operation);
      if (turn.kind === "unresolved")
        return yield* new GenieMessageUnavailable({
          state: "unresolved",
          status: responseNotVisible,
        });
      const { items, status } = turn;
      const state = stateOf(status);
      if (state !== "completed")
        return yield* new GenieMessageUnavailable({
          state: state === "cancelled" ? "failed" : state,
          status,
        });
      const attachments: GenieAttachment[] = [];
      for (const item of items) {
        if (item.type !== "message" || item.role !== "assistant") continue;
        const content = yield* decode(Report, item.content);
        for (const [index, part] of content.entries()) {
          if (part.type !== "output_text" || part.text === undefined) continue;
          const table = decodeTable(part.metadata);
          if (Option.isNone(table)) {
            attachments.push({ kind: "text", content: part.text });
            continue;
          }
          const {
            sql,
            columns,
            preview_rows: rows,
            total_row_count: totalRowCount,
          } = table.value;
          attachments.push({
            kind: "query",
            attachmentId: `${item.id}:${index}`,
            sql,
            columns: columns.map(({ name, type }) => ({
              name,
              ...(type === undefined ? {} : { typeName: type }),
            })),
            rows,
            truncated: totalRowCount != null && totalRowCount > rows.length,
            ...(totalRowCount == null ? {} : { totalRowCount }),
          });
        }
      }
      return { ...operation, attachments } satisfies GenieAgentOperation &
        GenieAnswer;
    }).pipe(Effect.withSpan("genie.agent.result"));

  return { submit, poll, cancel, result };
};
