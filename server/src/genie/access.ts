import { createHmac, timingSafeEqual } from "node:crypto";
import { Effect, Redacted } from "effect";
import type { GenieAgentOperation } from "@dsiem/genie-client";
import type {
  GenieInput,
  GenieOperation,
  GenieQueryPath,
} from "../../../shared/genie.js";
import {
  type PermissionDenied,
  type ServiceUnavailable,
  permissionDenied,
  unavailable,
} from "../errors.js";
import { Settings } from "../settings.js";
import type { GenieOperations } from "./service.js";

type Conversation = Pick<GenieOperation, "conversationId" | "mode">;

type GenieViewerAccess = {
  readonly grantFor: (conversation: Conversation) => string | undefined;
  readonly requireGrant: (
    conversation: Conversation,
    grant: string | undefined,
  ) => Effect.Effect<void, PermissionDenied>;
};

const localAccess: GenieViewerAccess = {
  grantFor: () => undefined,
  requireGrant: () => Effect.void,
};

const makeConversationAccess = Effect.gen(function* () {
  const settings = yield* Settings;
  const app = settings.appName.trim();
  const secret = Redacted.value(settings.clientSecret);
  return (
    viewerId: string | undefined,
  ): Effect.Effect<
    GenieViewerAccess,
    PermissionDenied | ServiceUnavailable<"genie">
  > => {
    if (!app) return Effect.succeed(localAccess);
    const viewer = viewerId?.trim();
    if (!viewer)
      return Effect.fail(permissionDenied("Sign in to use Genie in this app."));
    if (!secret)
      return Effect.fail(
        unavailable(
          "genie",
          "Genie viewer access is unavailable. Try again later.",
        ),
      );

    const grantFor = ({ conversationId, mode }: Conversation) =>
      createHmac("sha256", secret)
        .update(
          JSON.stringify([
            "genie-conversation/v1",
            settings.host,
            app,
            settings.genieSpaceId.trim(),
            viewer,
            mode ?? "chat",
            conversationId,
          ]),
        )
        .digest("base64url");

    return Effect.succeed({
      grantFor,
      requireGrant: (conversation, grant) =>
        grant &&
        /^[A-Za-z0-9_-]{43}$/.test(grant) &&
        timingSafeEqual(Buffer.from(grantFor(conversation)), Buffer.from(grant))
          ? Effect.void
          : Effect.fail(
              permissionDenied(
                "This Genie conversation is unavailable to you. Start a new conversation.",
              ),
            ),
    });
  };
});

export const withGenieAccess = ({
  submit,
  poll,
  cancel,
  result,
  downloadCsv,
}: GenieOperations) =>
  Effect.gen(function* () {
    const accessFor = yield* makeConversationAccess;
    const forViewer = (viewerId: string | undefined) =>
      Effect.map(accessFor(viewerId), ({ requireGrant, grantFor }) => {
        const authorized = <A, E, R>(
          conversation: Conversation,
          grant: string | undefined,
          run: () => Effect.Effect<A, E, R>,
        ) => requireGrant(conversation, grant).pipe(Effect.flatMap(run));

        const withGrant = <A extends Conversation>(value: A) => {
          const grant = grantFor(value);
          return grant === undefined ? value : { ...value, grant };
        };

        return {
          submit: (input: typeof GenieInput.Type, grant?: string) =>
            Effect.gen(function* () {
              if (input.conversationId !== undefined)
                yield* requireGrant(
                  {
                    conversationId: input.conversationId,
                    ...(input.mode === undefined ? {} : { mode: input.mode }),
                  },
                  grant,
                );
              return withGrant<GenieOperation>(yield* submit(input));
            }),
          poll: (operation: GenieOperation, grant?: string) =>
            authorized(operation, grant, () => poll(operation)),
          cancel: (operation: GenieAgentOperation, grant?: string) =>
            authorized(
              { conversationId: operation.conversationId, mode: "agent" },
              grant,
              () => cancel(operation),
            ),
          result: (operation: GenieOperation, grant?: string) =>
            authorized(operation, grant, () => result(operation)).pipe(
              Effect.map(withGrant),
            ),
          downloadCsv: (reference: GenieQueryPath, grant?: string) =>
            authorized(reference, grant, () => downloadCsv(reference)),
        };
      });
    return { forViewer };
  });
