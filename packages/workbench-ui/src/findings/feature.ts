import { Effect, Schema } from "effect";
import { Command, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import type { HtmlBuilder } from "foldkit/html";
import { SavedViewCursor, savedViewSchemas } from "@dsiem/analytics/contracts";
import { findingFields } from "./fields.js";
import { readFindingPages, mergeFindingPages } from "./pages.js";
import { findingEditor } from "./editor.js";

type Contracts<F> = ReturnType<typeof savedViewSchemas<Schema.Codec<F>>>;
type Finding<F> = Contracts<F>["SavedView"]["Type"];
type Draft<F> = Contracts<F>["SavedViewInput"]["Type"];

export function makeFindingsFeature<F>(options: {
  readonly filters: Schema.Codec<F>;
  readonly newFilters: Effect.Effect<F, string>;
  readonly list: (params: {
    readonly cursor?: SavedViewCursor;
    readonly q?: string;
  }) => Effect.Effect<Contracts<F>["SavedViewsPage"]["Type"], string>;
  readonly save: (draft: Draft<F>) => Effect.Effect<Finding<F>, string>;
  readonly pin: (
    id: string,
    pinned: boolean,
    version: number,
  ) => Effect.Effect<unknown, string>;
  readonly remove: (
    id: string,
    version: number,
  ) => Effect.Effect<unknown, string>;
  readonly href: (filters: F) => string;
  readonly describe: (filters: F) => string;
  readonly id?: string;
}) {
  const { SavedView: Row, SavedViewsPage: Page } = savedViewSchemas(
    options.filters,
  );
  const editor = findingEditor(options.filters, Schema.String, "");
  const Mutation = Schema.Union([
    Schema.TaggedStruct("Save", { draft: editor.Draft }),
    Schema.TaggedStruct("Pin", { row: Row }),
    Schema.TaggedStruct("Delete", { row: Row }),
  ]);
  const Panel = defineTaggedUnion({
    Browse: {},
    Working: {},
    Editor: { editor: editor.Model },
    Delete: { row: Row, busy: Schema.Boolean },
  });
  const Model = Schema.Struct({
    rows: Schema.Array(Row),
    cursor: Schema.NullOr(SavedViewCursor),
    search: Schema.String,
    generation: Schema.Int,
    pages: Schema.Int,
    loading: Schema.Boolean,
    listError: Schema.String,
    panel: Panel,
    notice: Schema.String,
    error: Schema.String,
  });
  const M = defineMessageUnion({
    Search: { value: Schema.String },
    Refresh: {},
    More: {},
    Listed: { generation: Schema.Int, more: Schema.Boolean, page: Page },
    ListFailed: { generation: Schema.Int, reason: Schema.String },
    New: {},
    DraftCreated: { id: Schema.String, filters: options.filters },
    Copy: {},
    DraftCopied: { id: Schema.String },
    Edit: { row: Row },
    Change: { field: Schema.Literals(["body", "title"]), value: Schema.String },
    Cancel: {},
    Save: {},
    Pin: { row: Row },
    Delete: { row: Row },
    Confirm: {},
    Changed: { notice: Schema.String },
    Failed: { reason: Schema.String },
  });
  type Model = typeof Model.Type;
  type Message = typeof M.Type;
  type Result = Update.Return<Model, Message>;

  const load = Command.define("ListFindings", {
    args: {
      search: Schema.String,
      cursor: Schema.NullOr(SavedViewCursor),
      generation: Schema.Int,
      pages: Schema.Int,
    },
    messages: [M.Listed, M.ListFailed],
    execute: ({ search, cursor, generation, pages }) =>
      readFindingPages({ cursor, pages }, (next) =>
        options.list({
          ...(next ? { cursor: next } : {}),
          ...(search ? { q: search } : {}),
        }),
      ).pipe(
        Effect.match({
          onSuccess: (page) =>
            M.Listed({ page, more: cursor !== null, generation }),
          onFailure: (reason) => M.ListFailed({ reason, generation }),
        }),
      ),
  });
  const prepare = Command.define("NewFinding", {
    messages: [M.DraftCreated, M.Failed],
    execute: options.newFilters.pipe(
      Effect.match({
        onSuccess: (filters) =>
          M.DraftCreated({ filters, id: crypto.randomUUID() }),
        onFailure: (reason) => M.Failed({ reason }),
      }),
    ),
  });
  const copy = Command.define("CopyFinding", {
    messages: [M.DraftCopied],
    execute: Effect.sync(() => M.DraftCopied({ id: crypto.randomUUID() })),
  });
  const mutate = Command.define("MutateFinding", {
    args: { action: Mutation },
    messages: [M.Changed, M.Failed],
    execute: ({ action }) => {
      const result =
        action._tag === "Save"
          ? options
              .save({ ...action.draft, title: action.draft.title.trim() })
              .pipe(Effect.as("Finding saved."))
          : action._tag === "Pin"
            ? options
                .pin(action.row.id, !action.row.pinned, action.row.version)
                .pipe(
                  Effect.as(
                    action.row.pinned ? "Finding unpinned." : "Finding pinned.",
                  ),
                )
            : options
                .remove(action.row.id, action.row.version)
                .pipe(Effect.as("Finding deleted."));
      return result.pipe(
        Effect.match({
          onSuccess: (notice) => M.Changed({ notice }),
          onFailure: (reason) => M.Failed({ reason }),
        }),
      );
    },
  });
  const refresh = (model: Model, more = false): Result => {
    const generation = model.generation + 1;
    const cursor = more ? model.cursor : null;
    return {
      model: { ...model, generation, loading: true, listError: "" },
      commands: [
        load({
          search: model.search,
          cursor,
          generation,
          pages: more ? 1 : model.pages,
        }),
      ],
    };
  };
  const init = () =>
    refresh({
      rows: [],
      cursor: null,
      search: "",
      generation: 0,
      pages: 1,
      loading: false,
      listError: "",
      panel: Panel.Browse(),
      notice: "",
      error: "",
    });
  const update = (model: Model, message: Message): Result => {
    const panel = model.panel;
    const run = (
      action: typeof Mutation.Type,
      next: typeof Panel.Type,
    ): Result => ({
      model: { ...model, panel: next, notice: "", error: "" },
      commands: [mutate({ action })],
    });
    return M.match<Result>(message, {
      Refresh: () => refresh(model),
      More: () =>
        model.cursor && !model.loading ? refresh(model, true) : { model },
      Search: ({ value }) =>
        refresh({ ...model, search: value, cursor: null, rows: [], pages: 1 }),
      Listed: ({ generation, more, page }) =>
        generation === model.generation
          ? {
              model: {
                ...model,
                loading: false,
                cursor: page.nextCursor,
                pages: more ? model.pages + 1 : model.pages,
                rows: more
                  ? mergeFindingPages(model.rows, page.rows)
                  : page.rows,
              },
            }
          : { model },
      ListFailed: ({ generation, reason }) =>
        generation === model.generation
          ? { model: { ...model, loading: false, listError: reason } }
          : { model },
      New: () =>
        panel._tag === "Browse"
          ? {
              model: {
                ...model,
                panel: Panel.Working(),
                error: "",
                notice: "",
              },
              commands: [prepare()],
            }
          : { model },
      DraftCreated: ({ id, filters }) => ({
        model: {
          ...model,
          panel: Panel.Editor({ editor: editor.create(id, filters) }),
        },
      }),
      Copy: () =>
        panel._tag === "Editor" && !panel.editor.saving && panel.editor.error
          ? {
              model: {
                ...model,
                panel: Panel.Editor({
                  editor: { ...panel.editor, saving: true },
                }),
              },
              commands: [copy()],
            }
          : { model },
      DraftCopied: ({ id }) =>
        panel._tag === "Editor"
          ? {
              model: {
                ...model,
                panel: Panel.Editor({
                  editor: editor.edit({
                    ...panel.editor.draft,
                    id,
                    version: null,
                  }),
                }),
              },
            }
          : { model },
      Edit: ({ row }) =>
        panel._tag === "Browse"
          ? {
              model: {
                ...model,
                panel: Panel.Editor({ editor: editor.edit(row) }),
                notice: "",
                error: "",
              },
            }
          : { model },
      Change: ({ field, value }) =>
        panel._tag === "Editor"
          ? {
              model: {
                ...model,
                panel: Panel.Editor({
                  editor: editor.change(panel.editor, field, value),
                }),
              },
            }
          : { model },
      Cancel: () =>
        (panel._tag === "Delete" && !panel.busy) ||
        (panel._tag === "Editor" && !panel.editor.saving)
          ? { model: { ...model, panel: Panel.Browse(), error: "" } }
          : { model },
      Save: () => {
        const pending = panel._tag === "Editor" && editor.submit(panel.editor);
        return pending
          ? run(
              { _tag: "Save", draft: pending.draft },
              Panel.Editor({ editor: pending }),
            )
          : { model };
      },
      Pin: ({ row }) =>
        panel._tag === "Browse"
          ? run({ _tag: "Pin", row }, Panel.Working())
          : { model },
      Delete: ({ row }) =>
        panel._tag === "Browse"
          ? {
              model: {
                ...model,
                panel: Panel.Delete({ row, busy: false }),
                error: "",
                notice: "",
              },
            }
          : { model },
      Confirm: () =>
        panel._tag === "Delete" && !panel.busy
          ? run(
              { _tag: "Delete", row: panel.row },
              Panel.Delete({ row: panel.row, busy: true }),
            )
          : { model },
      Changed: ({ notice }) =>
        refresh({ ...model, panel: Panel.Browse(), notice }),
      Failed: ({ reason }) =>
        refresh({
          ...model,
          panel:
            panel._tag === "Editor"
              ? Panel.Editor({ editor: editor.reject(panel.editor, reason) })
              : Panel.Browse(),
          error: panel._tag === "Editor" ? "" : reason,
        }),
    });
  };
  const view = (model: Model, h: HtmlBuilder<Message>) => {
    const panel = model.panel;
    const editing = panel._tag === "Editor" ? panel.editor : null;
    const deleting = panel._tag === "Delete" ? panel : null;
    const disabled = panel._tag !== "Browse";
    const action = (label: string, message: Message, unavailable = false) =>
      h.button(
        [h.Type("button"), h.Disabled(unavailable), h.OnClick(message)],
        [label],
      );
    return h.section(
      [h.Class("findings"), h.AriaLabel("Saved findings")],
      [
        h.div(
          [h.Class("findings-toolbar")],
          [
            h.label(
              [],
              [
                "Search findings",
                h.input([
                  h.Type("search"),
                  h.Maxlength(200),
                  h.Value(model.search),
                  h.OnInput((value) => M.Search({ value })),
                ]),
              ],
            ),
            action("New finding", M.New(), disabled),
          ],
        ),
        ...(model.notice ? [h.p([h.Role("status")], [model.notice])] : []),
        ...(model.error ? [h.p([h.Role("alert")], [model.error])] : []),
        ...(editing
          ? [
              h.form(
                [h.Class("finding-editor"), h.OnSubmit(M.Save())],
                [
                  h.h2(
                    [],
                    [
                      editing.draft.version === null
                        ? "New finding"
                        : "Edit finding",
                    ],
                  ),
                  h.p([], [options.describe(editing.draft.filters)]),
                  ...findingFields(h, {
                    id: options.id ?? "finding",
                    title: editing.draft.title,
                    body: editing.draft.body,
                    readOnly: editing.saving,
                    onChange: (field, value) => M.Change({ field, value }),
                  }),
                  ...(editing.error
                    ? [
                        h.p([h.Role("alert")], [editing.error]),
                        ...(editing.draft.version !== null
                          ? [
                              action(
                                "Keep draft as a new finding",
                                M.Copy(),
                                editing.saving,
                              ),
                            ]
                          : []),
                      ]
                    : []),
                  h.div(
                    [h.Class("findings-actions")],
                    [
                      h.button(
                        [
                          h.Type("submit"),
                          h.Disabled(
                            editing.saving || !editing.draft.title.trim(),
                          ),
                        ],
                        [editing.saving ? "Saving…" : "Save finding"],
                      ),
                      action("Cancel", M.Cancel(), editing.saving),
                    ],
                  ),
                ],
              ),
            ]
          : []),
        ...(deleting
          ? [
              h.div(
                [h.Class("finding-editor")],
                [
                  h.h2([], [`Delete “${deleting.row.title}”?`]),
                  h.div(
                    [h.Class("findings-actions")],
                    [
                      action("Confirm delete", M.Confirm(), deleting.busy),
                      action("Cancel", M.Cancel(), deleting.busy),
                    ],
                  ),
                ],
              ),
            ]
          : []),
        ...(model.listError
          ? [
              h.p([h.Role("alert")], [model.listError]),
              action("Reload findings", M.Refresh()),
            ]
          : []),
        ...(model.loading
          ? [h.p([h.Role("status")], ["Loading findings…"])]
          : []),
        ...(!model.loading && !model.listError && model.rows.length === 0
          ? [h.p([], ["No findings match this view."])]
          : []),
        h.ul(
          [],
          model.rows.map((row) =>
            h.li(
              [h.Key(row.id)],
              [
                h.a([h.Href(options.href(row.filters))], [row.title]),
                ...(row.pinned ? [h.span([], ["Pinned"])] : []),
                h.p([], [options.describe(row.filters)]),
                ...(row.body ? [h.p([], [row.body])] : []),
                h.div(
                  [h.Class("findings-actions")],
                  [
                    action(`Edit ${row.title}`, M.Edit({ row }), disabled),
                    action(
                      `${row.pinned ? "Unpin" : "Pin"} ${row.title}`,
                      M.Pin({ row }),
                      disabled,
                    ),
                    action(`Delete ${row.title}`, M.Delete({ row }), disabled),
                  ],
                ),
              ],
            ),
          ),
        ),
        ...(model.cursor
          ? [action("Load more findings", M.More(), model.loading)]
          : []),
      ],
    );
  };
  return { Model, Message: M, init, update, view };
}
