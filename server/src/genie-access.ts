import { createHmac, timingSafeEqual } from "node:crypto";
import { Effect, Redacted } from "effect";
import type { GenieOperation } from "../../shared/genie.js";
import {
  type PermissionDenied,
  type ServiceUnavailable,
  permissionDenied,
  unavailable,
} from "./errors.js";
import { Settings } from "./settings.js";

type Conversation = Pick<GenieOperation, "conversationId" | "mode">;

export type GenieViewerAccess = {
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

export const makeGenieAccess = Effect.gen(function* () {
  const settings = yield* Settings;
  const app = settings.appName.trim();
  const secret = Redacted.value(settings.clientSecret);
  return (
    headers: Readonly<Record<string, string | undefined>>,
  ): Effect.Effect<
    GenieViewerAccess,
    PermissionDenied | ServiceUnavailable
  > => {
    if (!app) return Effect.succeed(localAccess);
    const viewer = headers["x-forwarded-user"]?.trim();
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
