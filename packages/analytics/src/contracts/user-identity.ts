import { Schema } from "effect";

export const UserIdentity = Schema.Struct({
  name: Schema.NonEmptyString,
  email: Schema.NullOr(Schema.NonEmptyString),
});
export type UserIdentity = typeof UserIdentity.Type;
