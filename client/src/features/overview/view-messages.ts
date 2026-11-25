import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { analysisRequest } from "../../domain/analysis";
import { messages } from "./messages";

export const Message = defineMessageUnion({
  ...messages,
  Analyze: analysisRequest,
  Reload: {},
});
export type H = HtmlBuilder<typeof Message.Type>;
