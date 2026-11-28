import { Effect, Option, Schema } from "effect";
import { AsyncData, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import type { HtmlBuilder } from "foldkit/html";
import { findingFields } from "./fields.js";
import { createFindingSearch } from "./search.js";
import { createFindingWrites } from "./writes.js";

import type { FindingOperations } from "./client.js";

export function makeFindingsFeature<F, R = never>(
  options: FindingOperations<F, string, R> & {
    readonly filters: Schema.Codec<F>;
    readonly newFilters: Effect.Effect<F, string, R>;
    readonly href: (filters: F) => string;
    readonly describe: (filters: F) => string;
    readonly id?: string;
  },
) {
  const search = createFindingSearch({ ...options, error: Schema.String });
  const writes = createFindingWrites({
    ...options,
    error: Schema.String,
    newFinding: { input: Schema.Null, filters: () => options.newFilters },
  });
  const Model = Schema.Struct({
    search: search.Model,
    writes: writes.Model,
    notice: Schema.String,
  });
  const M = defineMessageUnion({
    ...search.messageFields,
    ...writes.messageFields,
    New: {},
  });
  type Model = typeof Model.Type;
  type Message = typeof M.Type;
  type SearchMessage = typeof search.Message.Type;
  type Transition = Update.Return<Model, Message, R>;
  function isSearch(message: Message): message is SearchMessage {
    return Object.hasOwn(search.messageFields, message._tag);
  }

  function updateSearch(model: Model, message: SearchMessage): Transition {
    const result = search.update(model.search, message);
    return {
      model: { ...model, search: result.model },
      commands: result.commands ?? [],
    };
  }
  const init = () =>
    updateSearch(
      { search: search.init(), writes: writes.init(), notice: "" },
      M.Refresh(),
    );
  const update = (model: Model, message: Message): Transition => {
    if (isSearch(message)) return updateSearch(model, message);
    const {
      model: next,
      commands,
      outMessage,
    } = writes.update(
      model.writes,
      message._tag === "New" ? writes.Message.New({ input: null }) : message,
    );
    let notice = model.notice;
    switch (outMessage?._tag) {
      case "Saved":
        notice = "Finding saved.";
        break;
      case "Pinned":
        notice = outMessage.pinned ? "Finding pinned." : "Finding unpinned.";
        break;
      case "Deleted":
        notice = "Finding deleted.";
        break;
      case "WriteFailed":
        notice = "";
        break;
      case undefined:
        if (next.panel._tag !== "Browse") notice = "";
        break;
    }
    const changed = { ...model, writes: next, notice };
    const refreshed = outMessage
      ? updateSearch(changed, M.Refresh())
      : { model: changed };
    return {
      model: refreshed.model,
      commands: [...(commands ?? []), ...(refreshed.commands ?? [])],
    };
  };
  const view = (model: Model, h: HtmlBuilder<Message>) => {
    const panel = model.writes.panel;
    const editing = panel._tag === "Editor" ? panel.editor : null;
    const deleting = panel._tag === "Delete" ? panel : null;
    const disabled = panel._tag !== "Browse";
    const list = model.search.data;
    const page = Option.getOrUndefined(AsyncData.getData(list));
    const listError = Option.getOrUndefined(AsyncData.getError(list));
    const loading = AsyncData.isPending(list);
    const rows = page?.rows ?? [];
    const browseError = panel._tag === "Browse" ? panel.error : null;
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
                  h.Value(model.search.query),
                  h.OnInput((value) => M.Search({ value })),
                ]),
              ],
            ),
            action("New finding", M.New(), disabled),
          ],
        ),
        ...(model.notice ? [h.p([h.Role("status")], [model.notice])] : []),
        ...(browseError ? [h.p([h.Role("alert")], [browseError])] : []),
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
                  ...(deleting.error
                    ? [h.p([h.Role("alert")], [deleting.error])]
                    : []),
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
        ...(listError
          ? [
              h.p([h.Role("alert")], [listError]),
              action("Reload findings", M.Refresh()),
            ]
          : []),
        ...(loading ? [h.p([h.Role("status")], ["Loading findings…"])] : []),
        ...(!loading && !listError && rows.length === 0
          ? [h.p([], ["No findings match this view."])]
          : []),
        h.ul(
          [],
          rows.map((row) =>
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
        ...(page?.nextCursor
          ? [action("Load more findings", M.More(), loading)]
          : []),
      ],
    );
  };
  return { Model, Message: M, init, update, view };
}
