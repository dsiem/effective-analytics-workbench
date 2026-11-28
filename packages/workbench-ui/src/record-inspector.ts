import { Effect, Option, Schema, Stream } from "effect";
import { AsyncData, Command, Subscription, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";

const completion = <A, E>(data: Schema.Codec<A>, error: Schema.Codec<E>) =>
  Schema.Union([
    Schema.TaggedStruct("Success", { data }),
    Schema.TaggedStruct("Failure", { error }),
  ]);

const settle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onSuccess: (data) => ({ _tag: "Success" as const, data }),
      onFailure: (error) => ({ _tag: "Failure" as const, error }),
    }),
  );

export function recordInspector<
  Row,
  Detail,
  Note extends { readonly id: string },
  Cursor,
  E,
  R = never,
>(options: {
  readonly reads?: "commands" | "subscriptions";
  readonly row: Schema.Codec<Row>;
  readonly detail: Schema.Codec<Detail>;
  readonly error: Schema.Codec<E>;
  readonly key: (row: Row) => string;
  readonly inspect: (row: Row) => Effect.Effect<Detail, E, R>;
  readonly comments?: {
    readonly note: Schema.Codec<Note>;
    readonly cursor: Schema.Codec<Cursor>;
    readonly list: (
      row: Row,
      cursor: Cursor | null,
    ) => Effect.Effect<
      { readonly rows: readonly Note[]; readonly nextCursor: Cursor | null },
      E,
      R
    >;
    readonly post: (
      row: Row,
      id: string,
      body: string,
    ) => Effect.Effect<Note, E, R>;
    readonly snapshot?: (row: Row, detail: Detail) => Row;
  };
}) {
  const note: Schema.Codec<Note> = options.comments?.note ?? Schema.Never;
  const cursor: Schema.Codec<Cursor> = options.comments?.cursor ?? Schema.Never;
  const Page = Schema.Struct({
    rows: Schema.Array(note),
    nextCursor: Schema.NullOr(cursor),
  });
  const Read = Schema.Struct({ cursor: Schema.Option(cursor) });
  const Inspector = Schema.Struct({
    row: options.row,
    details: AsyncData.Schema(options.detail, options.error).schema,
    comments: Schema.Struct({
      data: Schema.Option(Page),
      error: Schema.Option(options.error),
      read: Schema.Option(Read),
    }),
  });
  const Input = Schema.Struct({
    row: options.row,
    id: Schema.String,
    body: Schema.String,
  });
  const Draft = Schema.Union([
    Schema.Struct({
      state: Schema.Literals(["editing", "posting"]),
      body: Schema.String,
    }),
    Schema.Struct({ state: Schema.Literal("retry"), ...Input.fields }),
  ]);
  const Model = Schema.Struct({
    inspector: Schema.Option(Inspector),
    detailLoadGeneration: Schema.Int,
    commentLoadGeneration: Schema.Int,
    commentDrafts: Schema.Record(Schema.String, Draft),
    postingId: Schema.Option(Schema.String),
    postGeneration: Schema.Int,
    postError: Schema.Option(options.error),
    posted: Schema.Option(Schema.String),
  });
  type State = typeof Model.Type;
  const identity = { rowId: Schema.String, generation: Schema.Int };
  const messageFields = {
    Inspect: { row: options.row },
    Close: {},
    RetryDetail: {},
    LoadedDetail: {
      ...identity,
      result: completion(options.detail, options.error),
    },
    LoadComments: { more: Schema.Boolean },
    LoadedComments: { ...identity, result: completion(Page, options.error) },
    Edit: { body: Schema.String },
    Post: {},
    PostedComment: {
      generation: Schema.Int,
      input: Input,
      result: completion(note, options.error),
    },
  };
  const M = defineMessageUnion(messageFields);
  type Message = typeof M.Type;
  const { key, comments } = options;
  const readRequest = { row: options.row, generation: Schema.Int };
  const loadDetail = Command.define("InspectRecord", {
    args: readRequest,
    messages: [M.LoadedDetail],
    execute: ({ row, generation }) =>
      settle(options.inspect(row)).pipe(
        Effect.map((result) =>
          M.LoadedDetail({ rowId: key(row), generation, result }),
        ),
      ),
  });
  const threadRequest = { ...readRequest, cursor: Schema.NullOr(cursor) };
  const readThread =
    comments &&
    Command.define("ReadRecordComments", {
      args: threadRequest,
      messages: [M.LoadedComments],
      execute: ({ row, cursor, generation }) =>
        settle(comments.list(row, cursor)).pipe(
          Effect.map((result) =>
            M.LoadedComments({ rowId: key(row), generation, result }),
          ),
        ),
    });
  const pendingDetail = (model: State) => {
    const selected = Option.getOrUndefined(model.inspector);
    return selected && AsyncData.isPending(selected.details)
      ? { row: selected.row, generation: model.detailLoadGeneration }
      : null;
  };
  const pendingThread = (model: State) => {
    const selected = Option.getOrUndefined(model.inspector);
    const read = selected && Option.getOrUndefined(selected.comments.read);
    return selected && read
      ? {
          row: selected.row,
          cursor: Option.getOrNull(read.cursor),
          generation: model.commentLoadGeneration,
        }
      : null;
  };
  const subscriptions = Subscription.make<State, Message, R>()((entry) => ({
    details: entry(
      { request: Schema.NullOr(Schema.Struct(readRequest)) },
      {
        modelToDependencies: (model) => ({
          request:
            options.reads === "subscriptions" ? pendingDetail(model) : null,
        }),
        dependenciesToStream: ({ request }) =>
          request
            ? Stream.fromEffect(loadDetail(request).effect)
            : Stream.empty,
      },
    ),
    comments: entry(
      { request: Schema.NullOr(Schema.Struct(threadRequest)) },
      {
        modelToDependencies: (model) => ({
          request:
            options.reads === "subscriptions" ? pendingThread(model) : null,
        }),
        dependenciesToStream: ({ request }) =>
          request && readThread
            ? Stream.fromEffect(readThread(request).effect)
            : Stream.empty,
      },
    ),
  }));
  const post =
    comments &&
    Command.define("PostComment", {
      args: {
        row: options.row,
        body: Schema.String,
        retryId: Schema.NullOr(Schema.String),
        generation: Schema.Int,
      },
      messages: [M.PostedComment],
      execute: ({ row, body, retryId, generation }) =>
        Effect.gen(function* () {
          const id = retryId ?? crypto.randomUUID();
          const input = { row, body, id };
          const result = yield* settle(comments.post(row, id, body));
          return M.PostedComment({ generation, input, result });
        }),
    });

  const init = (): State => ({
    inspector: Option.none(),
    detailLoadGeneration: 0,
    commentLoadGeneration: 0,
    commentDrafts: {},
    postingId: Option.none(),
    postGeneration: 0,
    postError: Option.none(),
    posted: Option.none(),
  });

  function transition<P extends State>(
    model: P,
    msg: Message,
  ): Update.ReturnWithOutMessage<
    P,
    Message,
    { readonly _tag: "CommentPosted"; readonly rowId: string },
    R
  > {
    const selected = Option.getOrUndefined(model.inspector);
    const rowId = selected && key(selected.row);
    const draft =
      rowId !== undefined && Object.hasOwn(model.commentDrafts, rowId)
        ? model.commentDrafts[rowId]
        : undefined;
    switch (msg._tag) {
      case "Inspect":
        return {
          model: {
            ...model,
            inspector: Option.some({
              row: msg.row,
              details: AsyncData.Loading(),
              comments: {
                data: Option.none(),
                error: Option.none(),
                read: comments
                  ? Option.some({ cursor: Option.none() })
                  : Option.none(),
              },
            }),
            detailLoadGeneration: model.detailLoadGeneration + 1,
            commentLoadGeneration: model.commentLoadGeneration + 1,
            postError: Option.none(),
            posted: Option.none(),
          },
        };
      case "Close":
        return {
          model: Option.isNone(model.inspector)
            ? model
            : { ...model, inspector: Option.none() },
        };
      case "RetryDetail":
        if (!selected || !AsyncData.hasError(selected.details))
          return { model };
        return {
          model: {
            ...model,
            detailLoadGeneration: model.detailLoadGeneration + 1,
            inspector: Option.some({
              ...selected,
              details: AsyncData.Loading(),
            }),
          },
        };
      case "LoadedDetail":
        if (
          !selected ||
          rowId !== msg.rowId ||
          model.detailLoadGeneration !== msg.generation ||
          !AsyncData.isPending(selected.details)
        )
          return { model };
        return {
          model: {
            ...model,
            inspector: Option.some({ ...selected, details: msg.result }),
          },
        };
      case "LoadComments": {
        if (!selected || !comments || Option.isSome(selected.comments.read))
          return { model };
        const cursor = msg.more
          ? Option.flatMapNullishOr(
              selected.comments.data,
              (page) => page.nextCursor,
            )
          : Option.none();
        if (msg.more && Option.isNone(cursor)) return { model };
        return {
          model: {
            ...model,
            commentLoadGeneration: model.commentLoadGeneration + 1,
            inspector: Option.some({
              ...selected,
              comments: {
                ...selected.comments,
                error: Option.none(),
                read: Option.some({ cursor }),
              },
            }),
          },
        };
      }
      case "LoadedComments": {
        if (
          !selected ||
          rowId !== msg.rowId ||
          model.commentLoadGeneration !== msg.generation ||
          Option.isNone(selected.comments.read)
        )
          return { model };
        const thread = selected.comments;
        let data = thread.data;
        if (msg.result._tag === "Success") {
          const page = msg.result.data;
          const previous = Option.isSome(selected.comments.read.value.cursor)
            ? (Option.getOrUndefined(data)?.rows ?? [])
            : [];
          data = Option.some({
            ...page,
            rows: [
              ...new Map(
                [...previous, ...page.rows].map((note) => [note.id, note]),
              ).values(),
            ],
          });
        }
        return {
          model: {
            ...model,
            inspector: Option.some({
              ...selected,
              comments: {
                data,
                error:
                  msg.result._tag === "Failure"
                    ? Option.some(msg.result.error)
                    : Option.none(),
                read: Option.none(),
              },
            }),
          },
        };
      }
      case "Edit":
        if (rowId === undefined || draft?.body === msg.body) return { model };
        return {
          model: {
            ...model,
            commentDrafts: {
              ...model.commentDrafts,
              [rowId]: { state: "editing", body: msg.body },
            },
            postError: Option.none(),
            posted: Option.none(),
          },
        };
      case "Post": {
        if (
          !selected ||
          rowId === undefined ||
          !post ||
          Option.isSome(model.postingId) ||
          !draft?.body.trim()
        )
          return { model };
        const row =
          draft.state === "retry"
            ? draft.row
            : comments?.snapshot && AsyncData.isSuccess(selected.details)
              ? comments.snapshot(selected.row, selected.details.data)
              : selected.row;
        const generation = model.postGeneration + 1;
        return {
          model: {
            ...model,
            postingId: Option.some(rowId),
            postGeneration: generation,
            commentDrafts: {
              ...model.commentDrafts,
              [rowId]: { state: "posting", body: draft.body },
            },
            postError: Option.none(),
            posted: Option.none(),
          },
          commands: [
            post({
              row,
              body: draft.body,
              retryId: draft.state === "retry" ? draft.id : null,
              generation,
            }),
          ],
        };
      }
      case "PostedComment": {
        const id = Option.getOrUndefined(model.postingId);
        if (id === undefined || model.postGeneration !== msg.generation)
          return { model };
        const drafts = { ...model.commentDrafts };
        if (drafts[id]?.state === "posting") {
          if (msg.result._tag === "Failure")
            drafts[id] = { state: "retry", ...msg.input };
          else delete drafts[id];
        }
        const next: P = {
          ...model,
          commentDrafts: drafts,
          postingId: Option.none(),
          postError:
            msg.result._tag === "Failure" && rowId === id
              ? Option.some(msg.result.error)
              : Option.none(),
          posted:
            msg.result._tag === "Success" ? Option.some(id) : Option.none(),
        };
        if (msg.result._tag === "Failure") return { model: next };
        if (!selected || id !== rowId)
          return {
            model: next,
            outMessage: { _tag: "CommentPosted", rowId: id },
          };
        const thread = selected.comments;
        const previous = Option.getOrUndefined(thread.data);
        const note = msg.result.data;
        const data = Option.some({
          rows: [
            note,
            ...(previous?.rows ?? []).filter((row) => row.id !== note.id),
          ],
          nextCursor: previous?.nextCursor ?? null,
        });
        const refresh =
          !previous ||
          Option.exists(thread.read, ({ cursor }) => Option.isNone(cursor));
        return {
          model: {
            ...next,
            inspector: Option.some({
              ...selected,
              comments: {
                ...thread,
                data,
                read: refresh
                  ? Option.some({ cursor: Option.none() })
                  : thread.read,
              },
            }),
            commentLoadGeneration: refresh
              ? next.commentLoadGeneration + 1
              : next.commentLoadGeneration,
          },
          outMessage: { _tag: "CommentPosted", rowId: id },
        };
      }
    }
  }

  function update<P extends State>(model: P, msg: Message) {
    const changed = transition(model, msg);
    if (options.reads === "subscriptions") return changed;
    const next = changed.model;
    const detail =
      next.detailLoadGeneration !== model.detailLoadGeneration &&
      pendingDetail(next);
    const thread =
      next.commentLoadGeneration !== model.commentLoadGeneration &&
      pendingThread(next);
    return {
      ...changed,
      commands: [
        ...(changed.commands ?? []),
        ...(detail ? [loadDetail(detail)] : []),
        ...(thread && readThread ? [readThread(thread)] : []),
      ],
    };
  }

  return {
    Model,
    messageFields,
    Message: M,
    subscriptions,
    init,
    update,
  };
}
