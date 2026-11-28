import { Effect, Result, Schema } from "effect";
import { AsyncData, Command, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { SavedViewCursor, savedViewSchemas } from "@dsiem/analytics/contracts";
import type { FindingOperations } from "./client.js";
import { mergeFindingPages, readFindingPages } from "./pages.js";

let nextSearchInstance = 0;

/** Search and page through findings without choosing their presentation. */
export function createFindingSearch<F, E, R = never>(
  options: Pick<FindingOperations<F, E, R>, "list"> & {
    readonly filters: Schema.Codec<F>;
    readonly error: Schema.Codec<E>;
  },
) {
  const { SavedViewsPage: Page } = savedViewSchemas(options.filters);
  const Request = Schema.Struct({
    cursor: Schema.NullOr(SavedViewCursor),
    pages: Schema.Natural,
    query: Schema.String,
    debounce: Schema.Boolean,
  });
  const Pending = Schema.Union([
    Schema.TaggedStruct("Canceling", { request: Request }),
    Schema.TaggedStruct("Loading", { request: Request }),
  ]);
  const Model = Schema.Struct({
    instance: Schema.Natural,
    data: AsyncData.Schema(Page, options.error).schema,
    query: Schema.String,
    pages: Schema.Natural,
    generation: Schema.Natural,
    pending: Schema.NullOr(Pending),
  });
  const messageFields = {
    Search: { value: Schema.String },
    Browse: {},
    Refresh: {},
    More: {},
    Reset: { retainResults: Schema.Boolean },
    Canceled: { generation: Schema.Natural },
    Listed: { generation: Schema.Natural, page: Page },
    ListFailed: { generation: Schema.Natural, error: options.error },
  };
  const Message = defineMessageUnion(messageFields);
  type Model = typeof Model.Type;
  type Message = typeof Message.Type;
  type Request = typeof Request.Type;
  type Out = { readonly _tag: "ReachedEnd" };
  type Transition = Update.ReturnWithOutMessage<Model, Message, Out, R>;

  const load = Command.define("ListFindings", {
    args: {
      ...Request.fields,
      instance: Schema.Natural,
      generation: Schema.Natural,
    },
    interrupt: {
      keyFields: ["instance", "generation"],
      toKey: ({ instance, generation }) => `${instance}:${generation}`,
    },
    messages: [Message.Listed, Message.ListFailed],
    execute: ({ cursor, pages, query, generation, debounce }) =>
      Effect.gen(function* () {
        if (debounce) yield* Effect.sleep("180 millis");
        const q = query.trim();
        return yield* readFindingPages({ cursor, pages }, (next) =>
          options.list({
            ...(q ? { q } : {}),
            ...(next ? { cursor: next } : {}),
          }),
        );
      }).pipe(
        Effect.match({
          onSuccess: (page) => Message.Listed({ page, generation }),
          onFailure: (error) => Message.ListFailed({ error, generation }),
        }),
      ),
  });

  const init = (): Model => ({
    instance: ++nextSearchInstance,
    data: AsyncData.Idle(),
    query: "",
    pages: 1,
    generation: 0,
    pending: null,
  });
  function start(model: Model, request: Request): Transition {
    return {
      model: { ...model, pending: { _tag: "Loading", request } },
      commands: [
        load({
          ...request,
          instance: model.instance,
          generation: model.generation,
        }),
      ],
    };
  }
  function request(
    model: Model,
    options: {
      readonly query?: string;
      readonly cursor?: SavedViewCursor;
      readonly debounce?: boolean;
    } = {},
  ): Transition {
    const { query, cursor } = options;
    const input = {
      cursor: cursor ?? null,
      pages: query !== undefined || cursor ? 1 : model.pages,
      query: query ?? model.query,
      debounce: options.debounce ?? query !== undefined,
    };
    const next = {
      ...model,
      query: input.query,
      pages: query !== undefined ? 1 : model.pages,
      generation: model.generation + 1,
      data:
        query !== undefined
          ? AsyncData.Loading()
          : AsyncData.getData(model.data).pipe((data) =>
              data._tag === "Some"
                ? AsyncData.Refreshing({ data: data.value })
                : AsyncData.Loading(),
            ),
    };
    return model.pending?._tag === "Loading"
      ? {
          model: { ...next, pending: { _tag: "Canceling", request: input } },
          commands: [
            load.Interrupt(
              { instance: model.instance, generation: model.generation },
              () => Message.Canceled({ generation: next.generation }),
            ),
          ],
        }
      : start(next, input);
  }

  function update(model: Model, message: Message): Transition {
    const pending = model.pending;
    if ("generation" in message && message.generation !== model.generation)
      return { model };
    switch (message._tag) {
      case "Search":
        return request(model, { query: message.value.slice(0, 200) });
      case "Browse":
        return request(model, { query: "", debounce: false });
      case "Refresh":
        return request(model);
      case "More": {
        const data = AsyncData.getData(model.data);
        const cursor = data._tag === "Some" && data.value.nextCursor;
        return !pending && cursor ? request(model, { cursor }) : { model };
      }
      case "Reset": {
        const previous = AsyncData.getData(model.data);
        return {
          model: {
            instance: model.instance,
            query: "",
            pages: 1,
            pending: null,
            data:
              message.retainResults && previous._tag === "Some"
                ? AsyncData.succeed(previous.value)
                : AsyncData.Idle(),
            generation: model.generation + 1,
          },
          commands:
            pending?._tag === "Loading"
              ? [
                  load.Interrupt(
                    { instance: model.instance, generation: model.generation },
                    () =>
                      Message.Canceled({ generation: model.generation + 1 }),
                  ),
                ]
              : [],
        };
      }
      case "Canceled":
        return pending?._tag === "Canceling"
          ? start(model, pending.request)
          : { model };
      case "Listed": {
        if (pending?._tag !== "Loading") return { model };
        const previous = AsyncData.getData(model.data);
        const { page } = message;
        const more = pending.request.cursor !== null;
        return {
          model: {
            ...model,
            data: AsyncData.succeed(
              more && previous._tag === "Some"
                ? {
                    ...page,
                    rows: mergeFindingPages(previous.value.rows, page.rows),
                  }
                : page,
            ),
            pages: more ? model.pages + 1 : pending.request.pages,
            pending: null,
          },
          ...(more && !page.nextCursor
            ? { outMessage: { _tag: "ReachedEnd" } }
            : {}),
        };
      }
      case "ListFailed":
        return pending?._tag === "Loading"
          ? {
              model: {
                ...model,
                data: AsyncData.settle(model.data, Result.fail(message.error)),
                pending: null,
              },
            }
          : { model };
    }
  }
  return { Model, Message, messageFields, init, update };
}
