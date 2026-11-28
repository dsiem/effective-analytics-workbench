import type { Html, HtmlBuilder } from "foldkit/html";

export type H<Message> = HtmlBuilder<Message>;
export type Child = Html | string;

export const card = <Message>(h: H<Message>, children: Child[], classes = "") =>
  h.div(
    [h.Class(`card ${classes}`), h.DataAttribute("slot", "card")],
    children,
  );

/** Presentation only: callers own the metric's meaning and formatting. */
export const metric = <Message>(
  h: H<Message>,
  options: {
    readonly label: string;
    readonly value: string;
    readonly detail: string;
    readonly icon?: Child;
  },
) =>
  card(
    h,
    [
      h.div(
        [h.Class("metric-heading")],
        [
          h.h2([h.Class("metric-label")], [options.label]),
          ...(options.icon ? [options.icon] : []),
        ],
      ),
      h.p([h.Class("metric-value")], [options.value]),
      h.p([h.Class("metric-detail")], [options.detail]),
    ],
    "metric",
  );

export const panelHeader = <Message>(
  h: H<Message>,
  options: {
    readonly title: string;
    readonly description?: string;
    readonly actions?: Child[];
  },
) =>
  h.div(
    [h.Class("panel-header")],
    [
      h.div(
        [],
        [
          h.h2([], [options.title]),
          ...(options.description
            ? [h.p([h.Class("panel-description")], [options.description])]
            : []),
        ],
      ),
      ...(options.actions?.length
        ? [h.div([h.Class("panel-actions")], options.actions)]
        : []),
    ],
  );
export const title = <Message>(
  h: H<Message>,
  text: string,
  description: string,
  actions: Child[] = [],
) =>
  h.div(
    [h.Class("page-title")],
    [
      h.div(
        [],
        [h.h1([], [text]), h.p([h.Class("page-description")], [description])],
      ),
      ...(actions.length
        ? [h.div([h.Class("page-title-actions")], actions)]
        : []),
    ],
  );
export const table = <Message>(
  h: H<Message>,
  options: {
    readonly caption: string;
    readonly headers: ReadonlyArray<Child>;
    readonly rows: ReadonlyArray<{
      readonly key: string;
      readonly cells: ReadonlyArray<Child>;
    }>;
  },
) =>
  h.div(
    [h.Class("table-scroll")],
    [
      h.table(
        [],
        [
          h.caption([h.Class("sr-only")], [options.caption]),
          h.thead(
            [],
            [
              h.tr(
                [],
                options.headers.map((text) => h.th([h.Scope("col")], [text])),
              ),
            ],
          ),
          h.tbody(
            [],
            options.rows.map(({ key, cells }) =>
              h.tr(
                [h.Key(key)],
                cells.map((child) => h.td([], [child])),
              ),
            ),
          ),
        ],
      ),
    ],
  );
