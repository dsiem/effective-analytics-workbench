import { Data, Effect, Schema } from "effect";

export const GenieId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9-]{1,100}$/),
);

export class GenieResponseError extends Data.TaggedError("GenieResponseError")<{
  readonly cause: unknown;
}> {}

export class GenieMessageUnavailable extends Data.TaggedError(
  "GenieMessageUnavailable",
)<{
  readonly status: string;
  readonly state: "pending" | "failed" | "unresolved";
}> {}

export const decode = <A>(schema: Schema.Decoder<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => new GenieResponseError({ cause })),
  );

export const GenieOperation = Schema.Struct({
  conversationId: GenieId,
  messageId: GenieId,
});
export type GenieOperation = typeof GenieOperation.Type;

export const GenieProgress = Schema.Struct({
  ...GenieOperation.fields,
  state: Schema.Literals(["pending", "completed", "failed"]),
  status: Schema.String,
});
export type GenieProgress = typeof GenieProgress.Type;

export class GeniePermissionDenied extends Data.TaggedError(
  "GeniePermissionDenied",
)<{
  readonly source: "warehouse" | "query";
}> {}

export interface GenieQueryReference extends GenieOperation {
  readonly attachmentId: string;
}

export const chatPaths = (spaceId: string) => {
  const space = `/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}`;
  const messages = (conversationId: string) =>
    `${space}/conversations/${encodeURIComponent(conversationId)}/messages`;
  const message = ({ conversationId, messageId }: GenieOperation) =>
    `${messages(conversationId)}/${encodeURIComponent(messageId)}`;
  const attachment = (reference: GenieQueryReference) =>
    `${message(reference)}/attachments/${encodeURIComponent(reference.attachmentId)}`;
  return {
    startConversation: `${space}/start-conversation`,
    messages,
    message,
    attachment,
  };
};
