import { chart } from "./chart.js";
import { metric, table, type Child, type H } from "./primitives.js";

export type Metric<Summary> = {
  readonly label: string;
  readonly value: (summary: Summary) => string;
  readonly detail: string | ((summary: Summary) => string);
  readonly icon?: Child;
};

export function metricGrid<Message, Summary>(
  h: H<Message>,
  summary: Summary,
  metrics: ReadonlyArray<Metric<Summary>>,
) {
  return h.div(
    [h.Class("metrics")],
    metrics.map((spec) =>
      metric(h, {
        label: spec.label,
        value: spec.value(summary),
        detail:
          typeof spec.detail === "string" ? spec.detail : spec.detail(summary),
        ...(spec.icon ? { icon: spec.icon } : {}),
      }),
    ),
  );
}

export type Series<Row> = Omit<Parameters<typeof chart>[1], "data"> & {
  readonly label: (row: Row) => string;
  readonly value: (row: Row) => number;
};

export function seriesChart<Message, Row>(
  h: H<Message>,
  rows: ReadonlyArray<Row>,
  { label, value, ...options }: Series<Row>,
) {
  return chart(h, {
    ...options,
    data: rows.map((row) => ({ label: label(row), value: value(row) })),
  });
}

export type RecordTable<Row> = {
  readonly caption: string;
  readonly key: (row: Row) => string;
  readonly columns: ReadonlyArray<{
    readonly header: Child;
    readonly cell: (row: Row) => Child;
  }>;
};

export function recordTable<Message, Row>(
  h: H<Message>,
  rows: ReadonlyArray<Row>,
  spec: RecordTable<Row>,
) {
  return table(h, {
    caption: spec.caption,
    headers: spec.columns.map(({ header }) => header),
    rows: rows.map((row) => ({
      key: spec.key(row),
      cells: spec.columns.map(({ cell }) => cell(row)),
    })),
  });
}
