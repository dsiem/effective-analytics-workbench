import { Effect, Schema } from "effect";
import { Command, Runtime, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import type { Html } from "foldkit/html";
import { AssistantAnswer } from "./assistant-answer.js";
import { table, type H } from "./primitives.js";

const maxQuestionLength = 2000;
function normalizedQuestion(draft: string) {
  const question = draft.trim();
  return question.length <= maxQuestionLength ? question : "";
}

const Turn = Schema.Struct({
  question: Schema.String,
  answer: AssistantAnswer,
});

function answerView<P>(h: H<P>, { question, answer }: typeof Turn.Type) {
  return h.article(
    [h.Class("assistant-answer")],
    [
      h.h2([], [question]),
      ...answer.text.map((text) => h.p([], [text])),
      ...answer.tables.flatMap((result, i) => [
        table(h, {
          caption: `Genie result ${i + 1}`,
          headers: result.columns,
          rows: result.rows.map((cells, index) => ({
            key: String(index),
            cells: cells.map((cell) => cell ?? ""),
          })),
        }),
        ...(result.truncated
          ? [h.p([], ["Showing a partial query result."])]
          : []),
      ]),
      ...(!answer.text.length && !answer.tables.length
        ? [h.p([], ["Genie returned no text or table for this turn."])]
        : []),
    ],
  );
}

/** A conversation bound to the parent page's current, typed scope. */
export function createAssistant<C, R = never>(options: {
  readonly scope: Schema.Codec<C>;
  readonly connect: (
    scope: C,
  ) => Effect.Effect<
    { readonly configured: boolean; readonly description?: string },
    string,
    R
  >;
  readonly ask: (input: {
    readonly scope: C;
    readonly question: string;
    readonly continuation: string | null;
  }) => Effect.Effect<typeof AssistantAnswer.Type, string, R>;
  readonly suggestion: (scope: C) => string;
  readonly setup: string;
}) {
  const operation = Schema.Natural;
  const scope = options.scope;
  const sameScope = Schema.toEquivalence(scope);
  const active = { operation, scope, draft: Schema.String };
  const conversation = {
    ...active,
    description: Schema.String,
    turns: Schema.Array(Turn),
  };
  const Model = Schema.Union([
    Schema.TaggedStruct("Inactive", { operation, scope: Schema.Null }),
    Schema.TaggedStruct("Checking", active),
    Schema.TaggedStruct("ConnectionFailed", {
      ...active,
      error: Schema.String,
    }),
    Schema.TaggedStruct("Offline", { ...active, description: Schema.String }),
    Schema.TaggedStruct("Ready", { ...conversation, error: Schema.String }),
    Schema.TaggedStruct("Asking", { ...conversation, question: Schema.String }),
  ]);
  const Message = defineMessageUnion({
    Changed: { draft: Schema.String },
    Submit: {},
    RetryConnection: {},
    Reset: {},
    Connected: {
      operation,
      configured: Schema.Boolean,
      description: Schema.String,
    },
    Answered: { operation, answer: AssistantAnswer },
    Failed: { operation, error: Schema.String },
  });
  type Model = typeof Model.Type;
  type Message = typeof Message.Type;
  type Result = Update.Return<Model, Message, R>;

  const check = Command.define("CheckAssistantConnection", {
    args: { scope, operation },
    messages: [Message.Connected, Message.Failed],
    execute: ({ scope, operation }) =>
      options.connect(scope).pipe(
        Effect.match({
          onSuccess: ({ configured, description }) =>
            Message.Connected({
              operation,
              configured,
              description: description ?? "",
            }),
          onFailure: (error) => Message.Failed({ operation, error }),
        }),
      ),
  });
  const ask = Command.define("AskReportAssistant", {
    args: {
      scope,
      operation,
      question: Schema.String,
      continuation: Schema.NullOr(Schema.String),
    },
    messages: [Message.Answered, Message.Failed],
    execute: ({ operation, ...input }) =>
      options.ask(input).pipe(
        Effect.match({
          onSuccess: (answer) => Message.Answered({ operation, answer }),
          onFailure: (error) => Message.Failed({ operation, error }),
        }),
      ),
  });

  const checking = (scope: C, operation: number, draft: string): Result => ({
    model: { _tag: "Checking", scope, operation, draft },
    commands: [check({ scope, operation })],
  });
  const inactive = (operation: number): Model => ({
    _tag: "Inactive",
    scope: null,
    operation,
  });
  const setScope = (model: Model, next: C | null): Result => {
    if (next === null)
      return {
        model:
          model._tag === "Inactive" ? model : inactive(model.operation + 1),
      };
    if (model._tag !== "Inactive" && sameScope(model.scope, next))
      return { model };
    return checking(next, model.operation + 1, options.suggestion(next));
  };
  const init = (scope: C | null) => setScope(inactive(0), scope);

  function update(model: Model, message: Message): Result {
    if (
      model._tag === "Inactive" ||
      ("operation" in message && message.operation !== model.operation)
    )
      return { model };
    switch (message._tag) {
      case "Changed":
        return {
          model:
            model._tag === "Asking"
              ? model
              : { ...model, draft: message.draft },
        };
      case "RetryConnection":
        return model._tag === "ConnectionFailed"
          ? checking(model.scope, model.operation + 1, model.draft)
          : { model };
      case "Connected": {
        if (model._tag !== "Checking") return { model };
        const verified = { ...model, description: message.description };
        return {
          model: message.configured
            ? { ...verified, _tag: "Ready", turns: [], error: "" }
            : { ...verified, _tag: "Offline" },
        };
      }
      case "Reset":
        return {
          model:
            model._tag === "Ready"
              ? {
                  ...model,
                  turns: [],
                  error: "",
                  draft: options.suggestion(model.scope),
                }
              : model,
        };
      case "Submit": {
        if (model._tag !== "Ready") return { model };
        const question = normalizedQuestion(model.draft);
        if (!question) return { model };
        const operation = model.operation + 1;
        const { scope, draft, description, turns } = model;
        return {
          model: {
            _tag: "Asking",
            operation,
            scope,
            draft,
            description,
            turns,
            question,
          },
          commands: [
            ask({
              operation,
              scope,
              question,
              continuation: turns.at(-1)?.answer.continuation ?? null,
            }),
          ],
        };
      }
      case "Answered": {
        if (model._tag !== "Asking") return { model };
        const { scope, operation, description, question, turns } = model;
        return {
          model: {
            _tag: "Ready",
            scope,
            operation,
            description,
            draft: "",
            error: "",
            turns: [...turns, { question, answer: message.answer }],
          },
        };
      }
      case "Failed":
        if (model._tag === "Checking")
          return {
            model: { ...model, _tag: "ConnectionFailed", error: message.error },
          };
        if (model._tag === "Asking") {
          const { scope, operation, draft, description, turns } = model;
          return {
            model: {
              _tag: "Ready",
              scope,
              operation,
              draft,
              description,
              turns,
              error: message.error,
            },
          };
        }
        return { model };
    }
  }

  function view<P>(
    model: Model,
    h: H<P>,
    { onMessage }: { readonly onMessage: (message: Message) => P },
  ): readonly Html[] {
    if (model._tag === "Inactive") return [];
    const pending = model._tag === "Asking";
    const turns = "turns" in model ? model.turns : [];
    const questionLabel = turns.length ? "Follow-up question" : "Question";
    return [
      ...("description" in model && model.description
        ? [h.p([], [model.description])]
        : []),
      ...(model._tag === "Offline"
        ? [h.p([h.Role("status")], [options.setup])]
        : []),
      ...turns.map((turn) => answerView(h, turn)),
      h.form(
        [h.OnSubmit(onMessage(Message.Submit())), h.Class("assistant-form")],
        [
          h.label(
            [],
            [
              questionLabel,
              h.textarea([
                h.AriaLabel(questionLabel),
                h.Rows(3),
                h.Maxlength(maxQuestionLength),
                h.Value(model.draft),
                h.Disabled(pending),
                h.OnInput((draft) => onMessage(Message.Changed({ draft }))),
              ]),
            ],
          ),
          h.button(
            [
              h.Type("submit"),
              h.Disabled(
                model._tag !== "Ready" || !normalizedQuestion(model.draft),
              ),
            ],
            ["Send to Genie"],
          ),
          ...(turns.length
            ? [
                h.button(
                  [
                    h.Type("button"),
                    h.Disabled(pending),
                    h.OnClick(onMessage(Message.Reset())),
                  ],
                  ["New conversation"],
                ),
              ]
            : []),
        ],
      ),
      ...(pending ? [h.p([h.Role("status")], ["Waiting for Genie…"])] : []),
      ...("error" in model && model.error
        ? [h.p([h.Role("alert")], [model.error])]
        : []),
      ...(model._tag === "ConnectionFailed"
        ? [
            h.button(
              [
                h.Type("button"),
                h.OnClick(onMessage(Message.RetryConnection())),
              ],
              ["Retry connection"],
            ),
          ]
        : []),
    ];
  }
  return { Model, Message, init, setScope, update, view };
}

export function mountAssistant(options: {
  container: HTMLElement | null;
  heading: <M>(h: H<M>) => readonly Html[];
  connection: Effect.Effect<
    boolean | { readonly configured: boolean; readonly context: string },
    string
  >;
  setup: string;
  suggestion: string;
  ask: (
    question: string,
    continuation: string | null,
  ) => Effect.Effect<typeof AssistantAnswer.Type, string>;
}) {
  const chat = createAssistant({
    scope: Schema.Literal("page"),
    connect: () =>
      options.connection.pipe(
        Effect.map((result) =>
          typeof result === "boolean"
            ? { configured: result }
            : { configured: result.configured, description: result.context },
        ),
      ),
    setup: options.setup,
    suggestion: () => options.suggestion,
    ask: ({ question, continuation }) => options.ask(question, continuation),
  });
  return Runtime.run(
    Runtime.makeElement<typeof chat.Model.Type, typeof chat.Message.Type>({
      container: options.container,
      Model: chat.Model,
      init: () => chat.init("page"),
      update: chat.update,
      view: (model, h) =>
        h.main(
          [],
          [
            ...options.heading(h),
            ...chat.view(model, h, { onMessage: (message) => message }),
          ],
        ),
    }),
  );
}
