import { Effect, Schema } from "effect";
import type { CurrentUser } from "../../shared/current-user.js";
import { Settings } from "./settings.js";
import { Workspace } from "./workspace.js";

const WorkspaceUser = Schema.Struct({
  displayName: Schema.optionalKey(Schema.String),
  userName: Schema.NonEmptyString,
});

export const makeCurrentUser = Effect.gen(function* () {
  const settings = yield* Settings;
  const workspace = yield* Workspace;
  const localUser = yield* Effect.suspend(() =>
    workspace.request("/api/2.0/preview/scim/v2/Me"),
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(WorkspaceUser)),
    Effect.map((user): CurrentUser => ({
      name: user.displayName?.trim() || user.userName,
      email: user.userName,
    })),
    Effect.catch(() => Effect.succeed(null)),
    Effect.cachedWithTTL("5 minutes"),
  );

  return (
    headers: Readonly<Record<string, string | undefined>>,
  ): Effect.Effect<CurrentUser | null> => {
    const email = headers["x-forwarded-email"]?.trim() || null;
    const name = headers["x-forwarded-preferred-username"]?.trim() || email;
    if (name) return Effect.succeed({ name, email });

    // A workspace API call with app credentials would identify the service
    // principal, not the viewer. Only use /Me for a local developer identity.
    if (settings.clientId || !settings.host || headers["x-forwarded-user"])
      return Effect.succeed(null);
    return localUser;
  };
});
