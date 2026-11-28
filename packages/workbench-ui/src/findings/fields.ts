import type { HtmlBuilder } from "foldkit/html";

export function findingFields<M>(
  h: HtmlBuilder<M>,
  options: {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly readOnly: boolean;
    readonly onChange: (field: "title" | "body", value: string) => M;
    readonly titleLabel?: string;
    readonly bodyLabel?: string;
    readonly titlePlaceholder?: string;
    readonly bodyPlaceholder?: string;
  },
) {
  const titleId = `${options.id}-title`;
  const bodyId = `${options.id}-body`;
  return [
    h.div(
      [h.Class("field")],
      [
        h.label(
          [h.For(titleId), h.Class("field-label")],
          [options.titleLabel ?? "Title"],
        ),
        h.input([
          h.Id(titleId),
          h.Type("text"),
          h.Class("input"),
          h.Required(true),
          h.Maxlength(160),
          h.Value(options.title),
          h.Readonly(options.readOnly),
          ...(options.titlePlaceholder
            ? [h.Placeholder(options.titlePlaceholder)]
            : []),
          h.OnInput((value) => options.onChange("title", value)),
        ]),
      ],
    ),
    h.div(
      [],
      [
        h.label(
          [h.For(bodyId), h.Class("field-label")],
          [options.bodyLabel ?? "Finding"],
        ),
        h.textarea([
          h.Id(bodyId),
          h.Class("input mt-2 min-h-28"),
          h.Maxlength(10000),
          h.Value(options.body),
          h.Readonly(options.readOnly),
          ...(options.bodyPlaceholder
            ? [h.Placeholder(options.bodyPlaceholder)]
            : []),
          h.OnInput((value) => options.onChange("body", value)),
        ]),
      ],
    ),
  ];
}
