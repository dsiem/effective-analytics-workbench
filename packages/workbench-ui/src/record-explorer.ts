import { Effect, Schema } from "effect";
import { AsyncData, Command, Runtime } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import type { Html } from "foldkit/html";
import { type Child, type H, card, panelHeader } from "./primitives.js";
import { recordGrid, RecordViewport, recordWindow } from "./record-grid.js";
import { recordViewportMount } from "./record-viewport.js";
export { recordViewportMount } from "./record-viewport.js";
export { RecordViewport, recordGrid, recordWindow } from "./record-grid.js";

const Note = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  author: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  created_at: Schema.String,
});
export function commentList<M>(
  h: H<M>,
  rows: readonly (typeof Note.Type)[],
  anonymous = "Workspace viewer",
) {
  return h.ol(
    [h.AriaLabel("Record comments"), h.Class("space-y-3")],
    rows.map((comment) =>
      h.li(
        [h.Key(comment.id), h.Class("rounded-lg border p-3")],
        [
          h.div(
            [h.Class("flex flex-wrap justify-between gap-1 text-xs mb-2")],
            [
              h.span(
                [h.Class("font-medium")],
                [comment.author?.name ?? anonymous],
              ),
              h.time(
                [h.Datetime(comment.created_at), h.Class("muted")],
                [new Date(comment.created_at).toLocaleString()],
              ),
            ],
          ),
          h.p(
            [h.Class("whitespace-pre-wrap break-words text-sm leading-5")],
            [comment.body],
          ),
        ],
      ),
    ),
  );
}
const Draft = Schema.Struct({
  body: Schema.String,
  retryId: Schema.NullOr(Schema.String),
  error: Schema.String,
});
const blank = { body: "", retryId: null, error: "" };
const Notes = Schema.Struct({
  rows: Schema.Array(Note),
  nextCursor: Schema.NullOr(Schema.String),
});
type Result<A> = Effect.Effect<A, string>;
type CommentSource<Row> = {
  readonly list: (row: Row, cursor: string | null) => Result<typeof Notes.Type>;
  readonly post: (
    row: Row,
    id: string,
    body: string,
  ) => Result<typeof Note.Type>;
};

export interface RecordExplorerOptions<
  Row extends object,
  Detail extends object,
  Sort extends string,
> {
  readonly row: Schema.Codec<Row>;
  readonly detail: Schema.Codec<Detail>;
  readonly sort: Schema.Codec<Sort>;
  readonly sorts: readonly [Sort, ...Sort[]];
  readonly sortLabel: (sort: Sort) => string;
  readonly key: (row: Row) => string;
  readonly caption: string;
  readonly columns: readonly {
    readonly header: string;
    readonly value: (row: Row) => Child;
  }[];
  readonly heading: <M>(h: H<M>) => readonly Html[];
  readonly inspectLabel: (row: Row) => string;
  readonly inspector: <M>(h: H<M>, detail: Detail) => readonly Html[];
  readonly load: (sort: Sort) => Result<readonly Row[]>;
  readonly inspect: (row: Row) => Result<Detail>;
  readonly comments?: CommentSource<Row>;
}

export function createRecordExplorer<
  Row extends object,
  Detail extends object,
  Sort extends string,
>(options: RecordExplorerOptions<Row, Detail, Sort>) {
  const revision = Schema.Int;
  const rows = Schema.Array(options.row);
  const M = defineMessageUnion({
    Sort: { sort: options.sort },
    RetryList: {},
    Scrolled: { generation: Schema.Int, viewport: RecordViewport },
    Listed: { revision, rows },
    ListFailed: { revision, error: Schema.String },
    Inspect: { row: options.row },
    RetryDetail: {},
    Close: {},
    Inspected: { revision, detail: options.detail },
    InspectFailed: { revision, error: Schema.String },
    LoadNotes: {},
    NotesLoaded: { revision, page: Notes },
    NotesFailed: { revision, error: Schema.String },
    Edit: { body: Schema.String },
    Post: {},
    Posted: { revision, comment: Note },
    PostFailed: { revision, id: Schema.String, error: Schema.String },
  });
  const Model = Schema.Struct({
    sort: options.sort,
    revision,
    listGeneration: Schema.Int,
    viewport: Schema.NullOr(RecordViewport),
    rows: AsyncData.Schema(rows, Schema.String).schema,
    selected: Schema.NullOr(options.row),
    detail: AsyncData.Schema(options.detail, Schema.String).schema,
    notes: Notes,
    reading: Schema.Boolean,
    readError: Schema.String,
    drafts: Schema.Record(Schema.String, Draft),
    posting: Schema.Boolean,
  });
  type Model = typeof Model.Type;
  type Message = typeof M.Type;
  const list = Command.define("LoadRecords", {
    args: { sort: options.sort, revision },
    messages: [M.Listed, M.ListFailed],
    execute: ({ sort, revision }) =>
      options.load(sort).pipe(
        Effect.match({
          onSuccess: (rows) => M.Listed({ revision, rows }),
          onFailure: (error) => M.ListFailed({ revision, error }),
        }),
      ),
  });
  const inspect = Command.define("InspectRecord", {
    args: { row: options.row, revision },
    messages: [M.Inspected, M.InspectFailed],
    execute: ({ row, revision }) =>
      options.inspect(row).pipe(
        Effect.match({
          onSuccess: (detail) => M.Inspected({ revision, detail }),
          onFailure: (error) => M.InspectFailed({ revision, error }),
        }),
      ),
  });
  const comments = options.comments;
  const read = Command.define("ReadRecordNotes", {
    args: { row: options.row, revision, cursor: Schema.NullOr(Schema.String) },
    messages: [M.NotesLoaded, M.NotesFailed],
    execute: ({ row, revision, cursor }) =>
      (comments
        ? comments.list(row, cursor)
        : Effect.succeed({ rows: [], nextCursor: null })
      ).pipe(
        Effect.match({
          onSuccess: (page) => M.NotesLoaded({ revision, page }),
          onFailure: (error) => M.NotesFailed({ revision, error }),
        }),
      ),
  });
  const post = Command.define("PostRecordNote", {
    args: {
      row: options.row,
      revision,
      retryId: Schema.NullOr(Schema.String),
      body: Schema.String,
    },
    messages: [M.Posted, M.PostFailed],
    execute: ({ row, revision, retryId, body }) =>
      Effect.gen(function* () {
        const id = retryId ?? crypto.randomUUID();
        return yield* (
          comments
            ? comments.post(row, id, body)
            : Effect.fail("Comments are unavailable.")
        ).pipe(
          Effect.match({
            onSuccess: (comment) => M.Posted({ revision, comment }),
            onFailure: (error) => M.PostFailed({ revision, id, error }),
          }),
        );
      }),
  });
  const reset = {
    selected: null,
    detail: AsyncData.Idle(),
    notes: { rows: [], nextCursor: null },
    reading: false,
    readError: "",
    posting: false,
  };
  const draftFor = (model: Model) => {
    const key = model.selected && options.key(model.selected);
    return key !== null && Object.hasOwn(model.drafts, key)
      ? (model.drafts[key] ?? blank)
      : blank;
  };
  function load(sort: Sort, revision: number, drafts: Model["drafts"]) {
    return {
      model: {
        ...reset,
        drafts,
        sort,
        revision,
        listGeneration: revision,
        viewport: null,
        rows: AsyncData.Loading(),
      },
      commands: [list({ sort, revision })],
    };
  }
  function update(model: Model, msg: Message) {
    if ("revision" in msg && msg.revision !== model.revision) return { model };
    const next = model.revision + 1;
    switch (msg._tag) {
      case "Sort":
        return model.posting ? { model } : load(msg.sort, next, model.drafts);
      case "RetryList":
        return load(model.sort, next, model.drafts);
      case "Scrolled":
        return msg.generation === model.listGeneration
          ? { model: { ...model, viewport: msg.viewport } }
          : { model };
      case "Listed":
        return {
          model: { ...model, rows: AsyncData.Success({ data: msg.rows }) },
        };
      case "ListFailed":
        return {
          model: { ...model, rows: AsyncData.Failure({ error: msg.error }) },
        };
      case "Close":
        return model.posting
          ? { model }
          : { model: { ...model, ...reset, revision: next } };
      case "Inspect":
        if (model.posting) return { model };
        return {
          model: {
            ...model,
            ...reset,
            revision: next,
            selected: msg.row,
            detail: AsyncData.Loading(),
            reading: !!comments,
          },
          commands: [
            inspect({ row: msg.row, revision: next }),
            ...(comments
              ? [read({ row: msg.row, cursor: null, revision: next })]
              : []),
          ],
        };
      case "RetryDetail":
        return model.selected && model.detail._tag === "Failure"
          ? {
              model: { ...model, detail: AsyncData.Loading() },
              commands: [
                inspect({ row: model.selected, revision: model.revision }),
              ],
            }
          : { model };
      case "Inspected":
        return {
          model: { ...model, detail: AsyncData.Success({ data: msg.detail }) },
        };
      case "InspectFailed":
        return {
          model: { ...model, detail: AsyncData.Failure({ error: msg.error }) },
        };
      case "LoadNotes":
        return model.selected &&
          !model.reading &&
          (model.notes.nextCursor || model.readError)
          ? {
              model: { ...model, reading: true, readError: "" },
              commands: [
                read({
                  row: model.selected,
                  revision: model.revision,
                  cursor: model.notes.nextCursor,
                }),
              ],
            }
          : { model };
      case "NotesLoaded": {
        const ids = new Set(model.notes.rows.map((note) => note.id));
        return {
          model: {
            ...model,
            reading: false,
            notes: {
              rows: [
                ...model.notes.rows,
                ...msg.page.rows.filter((note) => !ids.has(note.id)),
              ],
              nextCursor: msg.page.nextCursor,
            },
          },
        };
      }
      case "NotesFailed":
        return { model: { ...model, reading: false, readError: msg.error } };
      case "Edit":
        if (!model.selected || model.posting) return { model };
        return {
          model: {
            ...model,
            drafts: {
              ...model.drafts,
              [options.key(model.selected)]: { ...blank, body: msg.body },
            },
          },
        };
      case "Post": {
        const { body, retryId } = draftFor(model);
        if (!model.selected || !comments || model.posting || !body.trim())
          return { model };
        return {
          model: { ...model, posting: true },
          commands: [
            post({
              row: model.selected,
              revision: model.revision,
              body,
              retryId,
            }),
          ],
        };
      }
      case "PostFailed":
        if (!model.selected) return { model };
        return {
          model: {
            ...model,
            posting: false,
            drafts: {
              ...model.drafts,
              [options.key(model.selected)]: {
                ...draftFor(model),
                retryId: msg.id,
                error: msg.error,
              },
            },
          },
        };
      case "Posted": {
        if (!model.selected) return { model };
        const drafts = { ...model.drafts };
        delete drafts[options.key(model.selected)];
        return {
          model: {
            ...model,
            posting: false,
            drafts,
            notes: {
              ...model.notes,
              rows: [
                msg.comment,
                ...model.notes.rows.filter(
                  (note) => note.id !== msg.comment.id,
                ),
              ],
            },
          },
        };
      }
    }
  }

  function view(model: Model, h: H<Message>) {
    const action = (
      text: string,
      message: Message,
      disabled = false,
      tabbable = true,
    ) =>
      h.button(
        [
          h.Type("button"),
          h.Disabled(disabled),
          h.Tabindex(tabbable ? 0 : -1),
          h.OnClick(message),
        ],
        [text],
      );
    const status = (text: string) => h.p([h.Role("status")], [text]);
    const alert = (text: string) => h.p([h.Role("alert")], [text]);
    const selected = model.selected;
    const draft = draftFor(model);
    const sort = h.label(
      [],
      [
        "Sort by ",
        h.select(
          [
            h.AriaLabel("Sort records"),
            h.Value(model.sort),
            h.Disabled(model.posting),
            h.OnChange((value) =>
              M.Sort({ sort: Schema.decodeUnknownSync(options.sort)(value) }),
            ),
          ],
          options.sorts.map((value) =>
            h.option([h.Value(value)], [options.sortLabel(value)]),
          ),
        ),
      ],
    );
    const records = model.rows;
    const details = model.detail;
    return h.main(
      [h.Class("record-explorer")],
      [
        ...options.heading(h),
        card(h, [
          panelHeader(h, { title: options.caption, actions: [sort] }),
          ...(records._tag === "Success"
            ? records.data.length
              ? [
                  recordGrid(h, records.data, {
                    caption: options.caption,
                    headers: [
                      ...options.columns.map((column) => column.header),
                      "Inspect",
                    ],
                    window: recordWindow(
                      records.data.length,
                      model.viewport ?? undefined,
                    ),
                    region: [
                      h.Key(`records-${model.listGeneration}`),
                      h.Role("region"),
                      h.AriaLabel(options.caption),
                      h.Tabindex(0),
                      h.OnMount(
                        recordViewportMount(
                          model.listGeneration,
                          ({ generation, viewport }) =>
                            M.Scrolled({ generation, viewport }),
                        ),
                      ),
                    ],
                    key: options.key,
                    cells: (row, tabbable) => [
                      ...options.columns.map((column) => column.value(row)),
                      action(
                        options.inspectLabel(row),
                        M.Inspect({ row }),
                        model.posting,
                        tabbable,
                      ),
                    ],
                  }),
                ]
              : [status("No matching records.")]
            : records._tag === "Failure"
              ? [
                  alert(records.error),
                  action("Retry loading records", M.RetryList()),
                ]
              : [status("Loading records…")]),
        ]),
        ...(selected
          ? [
              h.section(
                [
                  h.Class("record-inspector card"),
                  h.AriaLabel(options.inspectLabel(selected)),
                ],
                [
                  panelHeader(h, {
                    title: options.inspectLabel(selected),
                    actions: [
                      action("Close details", M.Close(), model.posting),
                    ],
                  }),
                  ...(details._tag === "Success"
                    ? options.inspector(h, details.data)
                    : details._tag === "Failure"
                      ? [
                          alert(details.error),
                          action("Retry loading details", M.RetryDetail()),
                        ]
                      : [status("Loading details…")]),
                  ...(comments
                    ? [
                        h.h3([], ["Comments"]),
                        commentList(h, model.notes.rows),
                        ...(model.reading
                          ? [status("Loading comments…")]
                          : model.readError
                            ? [
                                alert(model.readError),
                                action("Retry loading comments", M.LoadNotes()),
                              ]
                            : model.notes.nextCursor
                              ? [action("Load older comments", M.LoadNotes())]
                              : model.notes.rows.length
                                ? []
                                : [h.p([], ["No comments yet."])]),
                        h.form(
                          [h.OnSubmit(M.Post())],
                          [
                            h.label(
                              [],
                              [
                                "Add a comment",
                                h.textarea([
                                  h.Value(draft.body),
                                  h.OnInput((body) => M.Edit({ body })),
                                  h.Maxlength(4000),
                                  h.Disabled(model.posting),
                                ]),
                              ],
                            ),
                            ...(!model.posting && draft.error
                              ? [alert(draft.error)]
                              : []),
                            h.button(
                              [
                                h.Type("submit"),
                                h.Disabled(model.posting || !draft.body.trim()),
                              ],
                              [model.posting ? "Posting…" : "Post comment"],
                            ),
                          ],
                        ),
                      ]
                    : []),
                ],
              ),
            ]
          : []),
      ],
    );
  }

  return {
    Model,
    Message: M,
    init: () => load(options.sorts[0], 1, {}),
    update,
    view,
  };
}

export function mountRecordExplorer<
  Row extends object,
  Detail extends object,
  Sort extends string,
>({
  container,
  ...options
}: RecordExplorerOptions<Row, Detail, Sort> & {
  readonly container: HTMLElement | null;
}) {
  const feature = createRecordExplorer(options);
  return Runtime.run(
    Runtime.makeElement<typeof feature.Model.Type, typeof feature.Message.Type>(
      {
        container,
        ...feature,
      },
    ),
  );
}
