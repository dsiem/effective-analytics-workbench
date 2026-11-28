import { Effect, Schedule, Schema } from "effect";
import type { GenieAnswer, GenieAttachment } from "./answer.js";
import {
  chatPaths,
  decode,
  GenieId,
  GenieMessageUnavailable,
  type GenieOperation,
  GeniePermissionDenied,
  type GenieProgress,
  GenieResponseError,
} from "./protocol.js";
import {
  ChatQueryAttachment,
  decodeQueryAttachment,
  type GenieQueryFailed,
  GenieQueryUnavailable,
} from "./query-result.js";

export type GenieRequest =
  | {
      readonly kind: "submit";
      readonly path: string;
      readonly method: "POST";
      readonly body: { readonly content: string };
    }
  | {
      readonly kind: "message" | "query-result";
      readonly path: string;
      readonly method: "GET";
      readonly body?: never;
    };

const SubmittedMessage = Schema.Struct({
  message_id: GenieId,
  conversation_id: GenieId,
});

const MessageStatus = Schema.Struct({
  ...SubmittedMessage.fields,
  status: Schema.String,
  error: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ type: Schema.optionalKey(Schema.String) })),
  ),
});

const attachmentId = Schema.optionalKey(Schema.String);
const AttachmentFields = Schema.Record(Schema.String, Schema.Unknown);
const AttachmentByKey = {
  text: Schema.Struct({
    attachment_id: attachmentId,
    text: Schema.Struct({ content: Schema.String }),
  }),
  query: ChatQueryAttachment,
  suggested_questions: Schema.Struct({
    attachment_id: attachmentId,
    suggested_questions: AttachmentFields,
  }),
  viz: Schema.Struct({ attachment_id: attachmentId, viz: AttachmentFields }),
};
type WireAttachment =
  (typeof AttachmentByKey)[keyof typeof AttachmentByKey]["Type"];
const attachmentSchemas = Object.entries(AttachmentByKey);
const MessageAttachments = Schema.Struct({
  attachments: Schema.optionalKey(Schema.Array(AttachmentFields)),
});

const Started = Schema.Struct({
  conversation_id: GenieId,
  message: Schema.Struct({ message_id: GenieId }),
});

export interface GenieResult extends GenieOperation, GenieAnswer {}

const messageState = (status: string): GenieProgress["state"] => {
  switch (status) {
    case "COMPLETED":
      return "completed";
    case "FAILED":
    case "CANCELLED":
    case "QUERY_RESULT_EXPIRED":
      return "failed";
    default:
      return "pending";
  }
};

export const makeGenieClient = <E, R>(options: {
  readonly spaceId: string;
  readonly request: (request: GenieRequest) => Effect.Effect<unknown, E, R>;
  readonly attachmentConcurrency?: number;
}) => {
  const { request } = options;
  const paths = chatPaths(options.spaceId);

  const readMessage = (operation: GenieOperation) =>
    Effect.gen(function* () {
      const data = yield* request({
        kind: "message",
        method: "GET",
        path: paths.message(operation),
      });
      const message = yield* decode(MessageStatus, data);
      if (
        message.status === "FAILED" &&
        message.error?.type === "WAREHOUSE_ACCESS_MISSING_EXCEPTION"
      ) {
        return yield* new GeniePermissionDenied({ source: "warehouse" });
      }
      const progress: GenieProgress = {
        conversationId: message.conversation_id,
        messageId: message.message_id,
        status: message.status,
        state: messageState(message.status),
      };
      return { data, progress };
    });

  const submit = (input: {
    readonly content: string;
    readonly conversationId?: string;
  }) =>
    Effect.gen(function* (): Effect.fn.Return<
      GenieOperation,
      E | GenieResponseError,
      R
    > {
      const body = { content: input.content };
      if (input.conversationId) {
        const data = yield* request({
          kind: "submit",
          method: "POST",
          path: paths.messages(input.conversationId),
          body,
        });
        const message = yield* decode(SubmittedMessage, data);
        return {
          conversationId: message.conversation_id,
          messageId: message.message_id,
        };
      }
      const data = yield* request({
        kind: "submit",
        method: "POST",
        path: paths.startConversation,
        body,
      });
      const started = yield* decode(Started, data);
      return {
        conversationId: started.conversation_id,
        messageId: started.message.message_id,
      };
    }).pipe(Effect.withSpan("genie.submit"));

  const pollMessage = (operation: GenieOperation) =>
    readMessage(operation).pipe(Effect.withSpan("genie.poll"));

  const poll = (operation: GenieOperation) =>
    pollMessage(operation).pipe(Effect.map(({ progress }) => progress));

  const readAttachment = ({
    operation,
    attachment,
    waitForQueries,
  }: {
    readonly operation: GenieOperation;
    readonly attachment: WireAttachment;
    readonly waitForQueries: boolean;
  }) =>
    Effect.gen(function* (): Effect.fn.Return<
      GenieAttachment,
      | E
      | GenieResponseError
      | GeniePermissionDenied
      | GenieQueryFailed
      | GenieQueryUnavailable,
      R
    > {
      const id =
        attachment.attachment_id === undefined
          ? {}
          : { attachmentId: attachment.attachment_id };
      if ("text" in attachment) {
        return { kind: "text", ...id, content: attachment.text.content };
      }
      if ("suggested_questions" in attachment) {
        return {
          kind: "suggested-questions",
          ...id,
          payload: attachment.suggested_questions,
        };
      }
      if ("viz" in attachment) {
        return { kind: "visualization", ...id, payload: attachment.viz };
      }

      const reference = {
        ...operation,
        attachmentId: attachment.attachment_id,
      };
      const readQuery = Effect.suspend(() =>
        request({
          kind: "query-result",
          method: "GET",
          path: `${paths.attachment(reference)}/query-result`,
        }),
      ).pipe(
        Effect.flatMap((response) =>
          decodeQueryAttachment(attachment, response),
        ),
      );
      if (!waitForQueries) return yield* readQuery;
      return yield* readQuery.pipe(
        Effect.retry({
          while: (error) =>
            error instanceof GenieQueryUnavailable && error.state === "pending",
          schedule: Schedule.spaced("1 second"),
        }),
      );
    });

  const assembleResult = ({
    operation,
    message: { data, progress },
    waitForQueries,
  }: {
    readonly operation: GenieOperation;
    readonly message: Effect.Success<ReturnType<typeof readMessage>>;
    readonly waitForQueries: boolean;
  }): Effect.Effect<
    GenieResult,
    | E
    | GenieResponseError
    | GeniePermissionDenied
    | GenieMessageUnavailable
    | GenieQueryFailed
    | GenieQueryUnavailable,
    R
  > =>
    Effect.gen(function* () {
      if (progress.state !== "completed") {
        return yield* new GenieMessageUnavailable({
          status: progress.status,
          state: progress.state,
        });
      }
      const message = yield* decode(MessageAttachments, data);
      const supported: WireAttachment[] = [];
      let unsupportedCount = 0;
      for (const attachment of message.attachments ?? []) {
        const [known, second] = attachmentSchemas.filter(([key]) =>
          Object.hasOwn(attachment, key),
        );
        if (
          second ||
          (!known &&
            Object.keys(attachment).every((key) => key === "attachment_id"))
        )
          return yield* new GenieResponseError({
            cause: new Error("Genie returned an invalid attachment shape"),
          });
        if (known)
          supported.push(yield* decode<WireAttachment>(known[1], attachment));
        else unsupportedCount++;
      }
      const attachments = yield* Effect.forEach(
        supported,
        (attachment) =>
          readAttachment({ operation, attachment, waitForQueries }),
        { concurrency: options.attachmentConcurrency ?? 2 },
      );
      return {
        ...operation,
        attachments,
        ...(unsupportedCount === 0
          ? {}
          : {
              warning: {
                kind: "unsupported-attachments" as const,
                count: unsupportedCount,
              },
            }),
      };
    });

  const result = (operation: GenieOperation) =>
    Effect.gen(function* () {
      const message = yield* readMessage(operation);
      return yield* assembleResult({
        operation,
        message,
        waitForQueries: false,
      });
    }).pipe(Effect.withSpan("genie.result"));

  /** Wait for a submitted turn, including any query attachments still executing. */
  const complete = (operation: GenieOperation) =>
    Effect.gen(function* () {
      let message = yield* pollMessage(operation);
      while (message.progress.state === "pending") {
        yield* Effect.sleep("1 second");
        message = yield* pollMessage(operation);
      }
      return yield* assembleResult({
        operation,
        message,
        waitForQueries: true,
      }).pipe(Effect.withSpan("genie.result"));
    }).pipe(Effect.timeout("2 minutes"));

  return { submit, poll, result, complete };
};
