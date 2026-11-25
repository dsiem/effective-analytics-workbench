import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { messages } from "./messages";

export const Message = defineMessageUnion({
  ...messages,
  Reload: {},
});
export type H = HtmlBuilder<typeof Message.Type>;
