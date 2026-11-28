import { Effect, Schema, Stream } from "effect";
import { Command, Subscription } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";

export interface RecordPage<Row> {
  readonly rows: readonly Row[];
  readonly hasMore: boolean;
}

type Source<Row, Query, E, R> =
  | {
      readonly load: (query: Query) => Effect.Effect<readonly Row[], E, R>;
      readonly pages?: never;
    }
  | {
      readonly pages: (query: Query) => Stream.Stream<RecordPage<Row>, E, R>;
      readonly load?: never;
    };

/** Supply a single load, or stream preview pages whose final hasMore describes matching rows beyond the preview. */
export function recordList<Row, Query, E, R = never>(
  options: Source<Row, Query, E, R> & {
    readonly row: Schema.Codec<Row>;
    readonly query: Schema.Codec<Query>;
    readonly error: Schema.Codec<E>;
  },
) {
  const rows = Schema.Array(options.row);
  const Preview = defineTaggedUnion({
    Idle: {},
    Loading: { query: options.query, rows },
    Ready: { rows, hasMore: Schema.Boolean },
    Failed: { rows, error: options.error },
  });
  const Model = Schema.Struct({ preview: Preview, loadGeneration: Schema.Int });
  type State = typeof Model.Type;
  const messageFields = {
    Listed: { generation: Schema.Int, rows, hasMore: Schema.Boolean },
    RecordBatch: { generation: Schema.Int, rows },
    RecordsFinished: {
      generation: Schema.Int,
      result: Schema.Union([
        Schema.TaggedStruct("Complete", { hasMore: Schema.Boolean }),
        Schema.TaggedStruct("Failed", { error: options.error }),
      ]),
    },
  };
  const Message = defineMessageUnion(messageFields);
  type Message = typeof Message.Type;
  const { load: read, pages } = options;
  const loadOnce =
    read &&
    Command.define("LoadRecords", {
      args: { query: options.query, generation: Schema.Int },
      messages: [Message.Listed, Message.RecordsFinished],
      execute: ({ query, generation }) =>
        read(query).pipe(
          Effect.match({
            onSuccess: (rows) =>
              Message.Listed({ generation, rows, hasMore: false }),
            onFailure: (error) =>
              Message.RecordsFinished({
                generation,
                result: { _tag: "Failed", error },
              }),
          }),
        ),
    });
  const subscriptions = Subscription.make<State, Message, R>()((entry) => ({
    records: entry(
      {
        request: Schema.NullOr(
          Schema.Struct({ query: options.query, generation: Schema.Int }),
        ),
      },
      {
        modelToDependencies: ({ preview, loadGeneration }) => ({
          request:
            pages && preview._tag === "Loading"
              ? { query: preview.query, generation: loadGeneration }
              : null,
        }),
        dependenciesToStream: ({ request }) =>
          Stream.suspend(() => {
            if (!request || !pages) return Stream.empty;
            const { generation, query } = request;
            let hasMore = false;
            return pages(query).pipe(
              Stream.map((page) => {
                hasMore = page.hasMore;
                return Message.RecordBatch({ generation, rows: page.rows });
              }),
              Stream.concat(
                Stream.suspend(() =>
                  Stream.succeed(
                    Message.RecordsFinished({
                      generation,
                      result: { _tag: "Complete", hasMore },
                    }),
                  ),
                ),
              ),
              Stream.catch((error) =>
                Stream.succeed(
                  Message.RecordsFinished({
                    generation,
                    result: { _tag: "Failed", error },
                  }),
                ),
              ),
            );
          }),
      },
    ),
  }));
  function update<P extends State>(model: P, message: Message): P {
    const { preview } = model;
    if (
      preview._tag !== "Loading" ||
      model.loadGeneration !== message.generation
    )
      return model;
    if (message._tag === "Listed")
      return {
        ...model,
        preview: Preview.Ready({
          rows: message.rows,
          hasMore: message.hasMore,
        }),
      };
    if (message._tag === "RecordBatch")
      return {
        ...model,
        preview: Preview.Loading({
          query: preview.query,
          rows: [...preview.rows, ...message.rows],
        }),
      };
    return {
      ...model,
      preview:
        message.result._tag === "Complete"
          ? Preview.Ready({
              rows: preview.rows,
              hasMore: message.result.hasMore,
            })
          : Preview.Failed({ rows: preview.rows, error: message.result.error }),
    };
  }
  function load<P extends State>(model: P, query: Query) {
    const generation = model.loadGeneration + 1;
    const next: P = {
      ...model,
      preview: Preview.Loading({ query, rows: [] }),
      loadGeneration: generation,
    };
    return {
      model: next,
      commands: loadOnce ? [loadOnce({ query, generation })] : [],
    };
  }
  return {
    Model,
    messageFields,
    Message,
    subscriptions,
    update,
    init: (): State => ({ preview: Preview.Idle(), loadGeneration: 0 }),
    reset: <P extends State>(model: P): P => ({
      ...model,
      preview: Preview.Idle(),
      loadGeneration: model.loadGeneration + 1,
    }),
    load,
  };
}
