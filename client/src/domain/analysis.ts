import { Schema } from "effect";
import type { HtmlBuilder } from "foldkit/html";
import { GenieContext } from "@dsiem/analytics-shared/genie";
import { icon } from "../ui/icons";
import { button } from "../ui/primitives";

export const ask = <Message>(
  h: HtmlBuilder<Message>,
  onOpen: (context: GenieContext | null, question: string | null) => Message,
  label = "Ask Genie",
  context: GenieContext | null = null,
  question: string | null = null,
) =>
  button(h, {
    label: icon(h, "sparkles"),
    variant: "ghost",
    size: "icon",
    onClick: onOpen(context, question),
    attributes: [h.AriaLabel(label), h.Attribute("title", label)],
  });

// A request to analyze displayed data; the application chooses its recipient.
export const analysisRequest = {
  context: Schema.NullOr(GenieContext),
  question: Schema.NullOr(Schema.String),
};
