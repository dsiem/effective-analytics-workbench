import { Schema } from "effect";

export const CurrentUser = Schema.Struct({
  name: Schema.NonEmptyString,
  email: Schema.NullOr(Schema.NonEmptyString),
});
export type CurrentUser = typeof CurrentUser.Type;
