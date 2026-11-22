import {
  GenieAgentPhase,
  GenieAttachmentWarning,
  GenieId,
  GenieOperation as ChatOperation,
  GenieProgress as ChatProgress,
} from "@dsiem/genie-client";
import { Schema } from "effect";
import { boundedText } from "./schema.js";
import { Filters } from "./filters.js";

export const genieContextDataLimit = 24_000;
export const genieResultTimeoutMs = 180_000;
export const GenieContext = Schema.Struct({
  page: Schema.Literals(["overview", "trips", "map", "saved-views", "genie"]),
  title: boundedText(160),
  // A bounded snapshot of the displayed aggregates or visible records.
  data: Schema.optionalKey(boundedText(genieContextDataLimit)),
});
export type GenieContext = typeof GenieContext.Type;
export const GenieMode = Schema.Literals(["chat", "agent"]);
export type GenieMode = typeof GenieMode.Type;
export const GenieModeQuery = Schema.Struct({
  mode: Schema.optionalKey(GenieMode),
});
export const GenieInput = Schema.Struct({
  content: boundedText(4000),
  filters: Schema.optionalKey(Filters),
  context: Schema.optionalKey(GenieContext),
  conversationId: Schema.optionalKey(GenieId),
  ...GenieModeQuery.fields,
});

export const GeniePath = ChatOperation;
export const GenieAgentPath = Schema.Struct({
  conversationId: GenieId,
  responseId: GenieId,
});
export const GenieQueryPath = Schema.Struct({
  ...GeniePath.fields,
  attachmentId: GenieId,
});
export type GenieQueryPath = typeof GenieQueryPath.Type;
export const GenieOperation = Schema.Struct({
  ...ChatOperation.fields,
  ...GenieModeQuery.fields,
  grant: Schema.optionalKey(Schema.String),
});
export type GenieOperation = typeof GenieOperation.Type;
export { GenieAgentPhase };
export const GenieProgress = Schema.Struct({
  ...ChatProgress.fields,
  phase: Schema.optionalKey(GenieAgentPhase),
  state: Schema.Literals([...ChatProgress.fields.state.literals, "cancelled"]),
  ...GenieModeQuery.fields,
});
export type GenieProgress = typeof GenieProgress.Type;
export const GeniePollProgress = Schema.Union([
  GenieProgress,
  Schema.Struct({
    ...ChatProgress.fields,
    mode: Schema.Literal("agent"),
    state: Schema.Literal("unresolved"),
  }),
]);
export type GeniePollProgress = typeof GeniePollProgress.Type;

export const GenieReply = Schema.Struct({
  ...GenieOperation.fields,
  text: Schema.String,
  warning: Schema.optionalKey(GenieAttachmentWarning),
  queries: Schema.Array(
    Schema.Struct({
      attachmentId: Schema.optionalKey(GenieId),
      sql: Schema.String,
      description: Schema.String,
      columns: Schema.Array(Schema.String),
      rows: Schema.Array(Schema.Array(Schema.NullOr(Schema.String))),
      truncated: Schema.Boolean,
    }),
  ),
});
export type GenieReply = typeof GenieReply.Type;
