import { Effect, Schema } from "effect";
import { AsyncData, Command, Navigation, Runtime } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import type { Html } from "foldkit/html";
import { card, panelHeader, type H } from "./primitives.js";

type Request<A> = Effect.Effect<A, string>;

/** Mount a submission form, recent run links, and an independently reloadable report. */
export function mountRunPage<Draft, Run, Report>(options: {
  readonly container: HTMLElement | null;
  readonly draft: Schema.Codec<Draft>;
  readonly initial: Draft;
  readonly run: Schema.Codec<Run>;
  readonly report: Schema.Codec<Report>;
  readonly list: Request<readonly Run[]>;
  readonly selection: Request<{
    readonly run: Run;
    readonly report: Report;
  }> | null;
  readonly submit: (draft: Draft, requestId: string) => Request<string>;
  readonly heading: <M>(h: H<M>) => readonly Html[];
  readonly form: <M>(
    h: H<M>,
    draft: Draft,
    changed: (draft: Draft) => M,
    busy: boolean,
  ) => readonly Html[];
  readonly historyEntry: (run: Run) => {
    href: string;
    label: string;
    detail: string;
  };
  readonly result: <M>(h: H<M>, run: Run, report: Report) => readonly Html[];
}) {
  const runs = Schema.Array(options.run);
  const report = Schema.Struct({ run: options.run, report: options.report });
  const M = defineMessageUnion({
    Refresh: {},
    Listed: { runs },
    ListFailed: { message: Schema.String },
    RetryReport: {},
    Opened: { report },
    ReportFailed: { message: Schema.String },
    Changed: { draft: options.draft },
    Submit: {},
    Submitted: { href: Schema.String },
    CompletedOpenReport: {},
    SubmitFailed: { id: Schema.String, message: Schema.String },
  });
  const Submission = Schema.Union([
    Schema.TaggedStruct("Idle", {}),
    Schema.TaggedStruct("Submitting", {}),
    Schema.TaggedStruct("Failed", {
      id: Schema.String,
      message: Schema.String,
    }),
  ]);
  const Model = Schema.Struct({
    draft: options.draft,
    submission: Submission,
    history: AsyncData.Schema(runs, Schema.String).schema,
    report: AsyncData.Schema(report, Schema.String).schema,
  });
  const list = Command.define("LoadRunHistory", {
    messages: [M.Listed, M.ListFailed],
    execute: options.list.pipe(
      Effect.match({
        onSuccess: (runs) => M.Listed({ runs }),
        onFailure: (message) => M.ListFailed({ message }),
      }),
    ),
  });
  const read =
    options.selection &&
    Command.define("LoadSelectedReport", {
      messages: [M.Opened, M.ReportFailed],
      execute: options.selection.pipe(
        Effect.match({
          onSuccess: (report) => M.Opened({ report }),
          onFailure: (message) => M.ReportFailed({ message }),
        }),
      ),
    });
  const submit = Command.define("SubmitAnalysis", {
    args: { draft: options.draft, retryId: Schema.NullOr(Schema.String) },
    messages: [M.SubmitFailed, M.Submitted],
    execute: ({ draft, retryId }) =>
      Effect.gen(function* () {
        const id = retryId ?? crypto.randomUUID();
        return yield* options.submit(draft, id).pipe(
          Effect.match({
            onSuccess: (href) => M.Submitted({ href }),
            onFailure: (message) => M.SubmitFailed({ id, message }),
          }),
        );
      }),
  });

  const openReport = Command.define("OpenReport", {
    args: { href: Schema.String },
    messages: [M.CompletedOpenReport],
    execute: ({ href }) =>
      Navigation.load(href).pipe(Effect.as(M.CompletedOpenReport())),
  });
  const sameDraft = Schema.toEquivalence(options.draft);

  return Runtime.run(
    Runtime.makeElement<typeof Model.Type, typeof M.Type>({
      container: options.container,
      Model,
      init: () => ({
        model: {
          draft: options.initial,
          submission: { _tag: "Idle" },
          history: AsyncData.Loading(),
          report: read ? AsyncData.Loading() : AsyncData.Idle(),
        },
        commands: [list(), ...(read ? [read()] : [])],
      }),
      update: (model, m) => {
        switch (m._tag) {
          case "Refresh":
            return {
              model: { ...model, history: AsyncData.Loading() },
              commands: [list()],
            };
          case "Listed":
            return {
              model: { ...model, history: AsyncData.Success({ data: m.runs }) },
            };
          case "ListFailed":
            return {
              model: {
                ...model,
                history: AsyncData.Failure({ error: m.message }),
              },
            };
          case "RetryReport":
            return read
              ? {
                  model: { ...model, report: AsyncData.Loading() },
                  commands: [read()],
                }
              : { model };
          case "Opened":
            return {
              model: {
                ...model,
                report: AsyncData.Success({ data: m.report }),
              },
            };
          case "ReportFailed":
            return {
              model: {
                ...model,
                report: AsyncData.Failure({ error: m.message }),
              },
            };
          case "Changed":
            return {
              model:
                model.submission._tag === "Submitting" ||
                sameDraft(model.draft, m.draft)
                  ? model
                  : { ...model, draft: m.draft, submission: { _tag: "Idle" } },
            };
          case "Submit":
            return model.submission._tag === "Submitting"
              ? { model }
              : {
                  model: { ...model, submission: { _tag: "Submitting" } },
                  commands: [
                    submit({
                      draft: model.draft,
                      retryId:
                        model.submission._tag === "Failed"
                          ? model.submission.id
                          : null,
                    }),
                  ],
                };
          case "SubmitFailed":
            return {
              model: {
                ...model,
                submission: { _tag: "Failed", id: m.id, message: m.message },
              },
            };
          case "Submitted":
            return {
              model: { ...model, submission: { _tag: "Idle" } },
              commands: [openReport({ href: m.href })],
            };
          case "CompletedOpenReport":
            return { model };
        }
      },
      view: (model, h) =>
        h.main(
          [],
          [
            ...options.heading(h),
            card(h, [
              panelHeader(h, { title: "New run" }),
              h.form(
                [h.OnSubmit(M.Submit()), h.Class("run-form")],
                [
                  ...options.form(
                    h,
                    model.draft,
                    (draft) => M.Changed({ draft }),
                    model.submission._tag === "Submitting",
                  ),
                  h.button(
                    [
                      h.Type("submit"),
                      h.Disabled(model.submission._tag === "Submitting"),
                    ],
                    [
                      model.submission._tag === "Submitting"
                        ? "Running…"
                        : "Run analysis",
                    ],
                  ),
                  ...(model.submission._tag === "Failed"
                    ? [h.p([h.Role("alert")], [model.submission.message])]
                    : []),
                ],
              ),
            ]),
            ...(model.report._tag === "Success"
              ? options.result(
                  h,
                  model.report.data.run,
                  model.report.data.report,
                )
              : model.report._tag === "Failure"
                ? [
                    h.p([h.Role("alert")], [model.report.error]),
                    h.button([h.OnClick(M.RetryReport())], ["Retry report"]),
                  ]
                : model.report._tag === "Loading"
                  ? [h.p([h.Role("status")], ["Loading report…"])]
                  : []),
            card(h, [
              panelHeader(h, {
                title: "Recent runs",
                actions: [
                  h.button(
                    [
                      h.OnClick(M.Refresh()),
                      h.Disabled(model.history._tag === "Loading"),
                    ],
                    ["Refresh"],
                  ),
                ],
              }),
              ...(model.history._tag === "Success"
                ? model.history.data.length
                  ? [
                      h.ol(
                        [h.Class("run-history")],
                        model.history.data.map((run) => {
                          const entry = options.historyEntry(run);
                          return h.li(
                            [h.Key(entry.href)],
                            [
                              h.a([h.Href(entry.href)], [entry.label]),
                              h.span([], [entry.detail]),
                            ],
                          );
                        }),
                      ),
                    ]
                  : [h.p([], ["No runs yet."])]
                : model.history._tag === "Failure"
                  ? [h.p([h.Role("alert")], [model.history.error])]
                  : [h.p([h.Role("status")], ["Loading recent runs…"])]),
            ]),
          ],
        ),
    }),
  );
}
