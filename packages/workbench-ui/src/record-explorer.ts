import { Effect, Option, Schema } from "effect";
import { Runtime, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import type { Html } from "foldkit/html";
import { type Child, type H, card, panelHeader } from "./primitives.js";
import { recordGrid } from "./record-grid.js";
import {
  RecordViewport,
  recordViewportMount,
  recordWindow,
} from "./record-viewport.js";
import { recordInspector } from "./record-inspector.js";
import { recordList } from "./record-list.js";
import type { TableColumn } from "./report.js";
export { recordList, type RecordPage } from "./record-list.js";
export { recordInspector } from "./record-inspector.js";
export {
  RecordViewport,
  recordViewportMount,
  recordWindow,
} from "./record-viewport.js";
export { recordGrid } from "./record-grid.js";

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
  readonly sort?: Schema.Codec<Sort>;
  readonly sorts: readonly [Sort, ...Sort[]];
  readonly sortLabel?: (sort: Sort) => string;
  readonly key: (row: Row) => string;
  readonly caption: string;
  readonly fixedRowHeight?: number;
  readonly columns: readonly (
    | TableColumn<Row>
    | {
        readonly header: string;
        readonly value: (row: Row) => Child;
      }
  )[];
  readonly heading?: <M>(h: H<M>) => readonly Html[];
  readonly inspectLabel?: (row: Row) => string;
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
  const { fixedRowHeight } = options;
  if (
    fixedRowHeight !== undefined &&
    (!Number.isFinite(fixedRowHeight) || fixedRowHeight <= 0)
  )
    throw new RangeError("fixedRowHeight must be a positive number of pixels.");
  const sortCodec: Schema.Codec<Sort> =
    options.sort ?? Schema.Literals(options.sorts);
  const decodeSort = Schema.decodeUnknownSync(sortCodec);
  const inspectLabel =
    options.inspectLabel ?? ((row: Row) => `Inspect ${options.key(row)}`);
  const list = recordList({
    row: options.row,
    query: sortCodec,
    error: Schema.String,
    load: options.load,
  });
  const inspection = recordInspector({
    row: options.row,
    detail: options.detail,
    error: Schema.String,
    key: options.key,
    inspect: options.inspect,
    ...(options.comments
      ? { comments: { ...options.comments, note: Note, cursor: Schema.String } }
      : {}),
  });
  const columns = options.columns.map((column) =>
    "cell" in column ? column : { header: column.header, cell: column.value },
  );
  const M = defineMessageUnion({
    ...list.messageFields,
    ...inspection.messageFields,
    Sort: { sort: sortCodec },
    RetryList: {},
    LoadNotes: {},
    Scrolled: { generation: Schema.Int, viewport: RecordViewport },
  });
  const Model = Schema.Struct({
    ...list.Model.fields,
    ...inspection.Model.fields,
    sort: sortCodec,
    viewport: Schema.NullOr(RecordViewport),
  });
  type Model = typeof Model.Type;
  type Message = typeof M.Type;
  const load = (model: Model, sort: Sort) =>
    list.load<Model>(
      { ...model, inspector: Option.none(), sort, viewport: null },
      sort,
    );
  function update(model: Model, msg: Message): Update.Return<Model, Message> {
    switch (msg._tag) {
      case "Scrolled":
        return {
          model:
            msg.generation === model.loadGeneration
              ? { ...model, viewport: msg.viewport }
              : model,
        };
      case "Sort":
        return Option.isSome(model.postingId)
          ? { model }
          : load(model, msg.sort);
      case "RetryList":
        return load(model, model.sort);
      case "Listed":
      case "RecordBatch":
      case "RecordsFinished":
        return { model: list.update(model, msg) };
      case "Inspect":
      case "Close":
      case "Edit":
        if (Option.isSome(model.postingId)) return { model };
        break;
    }
    const message =
      msg._tag === "LoadNotes"
        ? M.LoadComments({
            more: Option.exists(model.inspector, ({ comments }) =>
              Option.exists(comments.data, (page) => page.nextCursor !== null),
            ),
          })
        : msg;
    const changed = inspection.update(model, message);
    return { model: changed.model, commands: changed.commands ?? [] };
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
    const inspector = Option.getOrUndefined(model.inspector);
    const selected = inspector?.row;
    const draft =
      selected && Object.hasOwn(model.commentDrafts, options.key(selected))
        ? model.commentDrafts[options.key(selected)]
        : undefined;
    const posting = Option.isSome(model.postingId);
    const notes = inspector && Option.getOrUndefined(inspector.comments.data);
    const reading = inspector && Option.isSome(inspector.comments.read);
    const comments = options.comments;
    const readError =
      inspector && Option.getOrUndefined(inspector.comments.error);
    const postError = Option.getOrUndefined(model.postError);
    const sort = h.label(
      [],
      [
        "Sort by ",
        h.select(
          [
            h.AriaLabel("Sort records"),
            h.Value(model.sort),
            h.Disabled(posting),
            h.OnChange((value) => M.Sort({ sort: decodeSort(value) })),
          ],
          options.sorts.map((value) =>
            h.option([h.Value(value)], [options.sortLabel?.(value) ?? value]),
          ),
        ),
      ],
    );
    const records = model.preview;
    const details = inspector?.details;
    return h.main(
      [h.Class("record-explorer")],
      [
        ...(options.heading?.(h) ?? []),
        card(h, [
          panelHeader(h, {
            title: options.caption,
            actions: options.sorts.length > 1 ? [sort] : [],
          }),
          ...(records._tag === "Ready"
            ? records.rows.length
              ? [
                  recordGrid(h, records.rows, {
                    caption: options.caption,
                    headers: [
                      ...columns.map((column) => column.header),
                      "Inspect",
                    ],
                    region: [
                      h.Key(`records-${model.loadGeneration}`),
                      ...(fixedRowHeight === undefined
                        ? []
                        : [
                            h.DataAttribute("fixed-rows", ""),
                            h.OnMount(
                              recordViewportMount(
                                model.loadGeneration,
                                M.Scrolled,
                                fixedRowHeight,
                              ),
                            ),
                          ]),
                      h.Role("region"),
                      h.AriaLabel(options.caption),
                      h.Tabindex(0),
                    ],
                    ...(fixedRowHeight === undefined
                      ? {}
                      : {
                          window: recordWindow(
                            records.rows.length,
                            model.viewport ?? undefined,
                            fixedRowHeight,
                          ),
                        }),
                    key: options.key,
                    cells: (row, tabbable) => {
                      const cells = [
                        ...columns.map((column) => column.cell(row)),
                        action(
                          inspectLabel(row),
                          M.Inspect({ row }),
                          posting,
                          tabbable,
                        ),
                      ];
                      return fixedRowHeight === undefined
                        ? cells
                        : cells.map((cell) =>
                            h.div(
                              [
                                h.Class("record-fixed-cell"),
                                h.Style({ height: `${fixedRowHeight}px` }),
                              ],
                              [cell],
                            ),
                          );
                    },
                  }),
                ]
              : [status("No matching records.")]
            : records._tag === "Failed"
              ? [
                  alert(records.error),
                  action("Retry loading records", M.RetryList()),
                ]
              : [status("Loading records…")]),
        ]),
        ...(selected && inspector && details
          ? [
              h.section(
                [
                  h.Class("record-inspector card"),
                  h.AriaLabel(inspectLabel(selected)),
                ],
                [
                  panelHeader(h, {
                    title: inspectLabel(selected),
                    actions: [action("Close details", M.Close(), posting)],
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
                        commentList(h, notes?.rows ?? []),
                        ...(reading
                          ? [status("Loading comments…")]
                          : readError
                            ? [
                                alert(readError),
                                action("Retry loading comments", M.LoadNotes()),
                              ]
                            : notes?.nextCursor
                              ? [action("Load older comments", M.LoadNotes())]
                              : (notes?.rows ?? []).length
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
                                  h.Value(draft?.body ?? ""),
                                  h.OnInput((body) => M.Edit({ body })),
                                  h.Maxlength(4000),
                                  h.Disabled(posting),
                                ]),
                              ],
                            ),
                            ...(!posting && postError
                              ? [alert(postError)]
                              : []),
                            h.button(
                              [
                                h.Type("submit"),
                                h.Disabled(
                                  posting || !(draft?.body ?? "").trim(),
                                ),
                              ],
                              [posting ? "Posting…" : "Post comment"],
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
    init: () =>
      load(
        {
          ...list.init(),
          ...inspection.init(),
          viewport: null,
          sort: options.sorts[0],
        },
        options.sorts[0],
      ),
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
