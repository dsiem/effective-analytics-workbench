import { Input } from "@foldkit/ui";
import type { Attribute } from "foldkit/html";
import type { H } from "./primitives.js";

export const field = <Message>(
  h: H<Message>,
  options: {
    readonly id: string;
    readonly label: string;
    readonly value: string;
    readonly onInput: (value: string) => Message;
    readonly type?: NonNullable<Input.ViewConfig<Message>["type"]>;
    readonly placeholder?: string;
    readonly className?: string;
    readonly attributes?: ReadonlyArray<
      Exclude<Attribute<Message>, { readonly _tag: "Class" }>
    >;
  },
) =>
  Input.view(
    {
      id: options.id,
      type: options.type ?? "text",
      value: options.value,
      onInput: options.onInput,
      ...(options.placeholder === undefined
        ? {}
        : { placeholder: options.placeholder }),
      toView: ({ label, input }) =>
        h.div(
          [h.Class(`field ${options.className ?? ""}`)],
          [
            h.label([...label, h.Class("field-label")], [options.label]),
            h.input([
              ...input,
              ...(options.attributes ?? []),
              h.Class("input"),
            ]),
          ],
        ),
    },
    h,
  );
