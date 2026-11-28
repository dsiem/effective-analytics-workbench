import { Effect, Schema } from "effect";
import { Command, Runtime, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import type { Html, HtmlBuilder } from "foldkit/html";

type Query<A, R> = {
  readonly result: Schema.Codec<A>;
  readonly load: Effect.Effect<A, string, R>;
};

/** A read-only query whose model and commands can live in a parent Foldkit runtime. */
export function createQueryPage<A, R = never>(query: Query<A, R>) {
  const generation = Schema.Natural;
  const Message = defineMessageUnion({
    Retry: {},
    Loaded: { generation, data: query.result },
    Failed: { generation, error: Schema.String },
  });
  const Model = Schema.Union([
    Schema.TaggedStruct("Loading", { generation }),
    Message.Loaded,
    Message.Failed,
  ]);
  const load = Command.define("LoadReport", {
    args: { generation },
    messages: [Message.Loaded, Message.Failed],
    execute: ({ generation }) =>
      query.load.pipe(
        Effect.match({
          onSuccess: (data) => Message.Loaded({ generation, data }),
          onFailure: (error) => Message.Failed({ generation, error }),
        }),
      ),
  });

  const loading = (
    generation: number,
  ): Update.Return<typeof Model.Type, typeof Message.Type, R> => ({
    model: { _tag: "Loading", generation },
    commands: [load({ generation })],
  });
  const init = () => loading(1);
  const update = (
    model: typeof Model.Type,
    message: typeof Message.Type,
  ): Update.Return<typeof Model.Type, typeof Message.Type, R> => {
    if (message._tag === "Retry") return loading(model.generation + 1);
    return { model: message.generation === model.generation ? message : model };
  };
  function view<Parent>(
    model: typeof Model.Type,
    h: HtmlBuilder<Parent>,
    bindings: {
      readonly onMessage: (message: typeof Message.Type) => Parent;
      readonly content: (h: HtmlBuilder<Parent>, data: A) => readonly Html[];
    },
  ): readonly Html[] {
    switch (model._tag) {
      case "Loaded":
        return bindings.content(h, model.data);
      case "Failed":
        return [
          h.p([h.Role("alert")], [model.error]),
          h.button(
            [h.Type("button"), h.OnClick(bindings.onMessage(Message.Retry()))],
            ["Try again"],
          ),
        ];
      case "Loading":
        return [h.p([h.Role("status")], ["Loading report…"])];
    }
  }
  return { Model, Message, init, update, view };
}

/** Mount a read-only report. Links and forms can select another query by URL. */
export function mountQueryPage<A>(
  options: Query<A, never> & {
    readonly container: HTMLElement | null;
    readonly heading: <M>(h: HtmlBuilder<M>) => readonly Html[];
    readonly content: <M>(h: HtmlBuilder<M>, result: A) => readonly Html[];
  },
) {
  const feature = createQueryPage(options);
  return Runtime.run(
    Runtime.makeElement<typeof feature.Model.Type, typeof feature.Message.Type>(
      {
        container: options.container,
        Model: feature.Model,
        init: feature.init,
        update: feature.update,
        view: (model, h) =>
          h.main(
            [],
            [
              ...options.heading(h),
              ...feature.view(model, h, {
                onMessage: (message) => message,
                content: options.content,
              }),
            ],
          ),
      },
    ),
  );
}
