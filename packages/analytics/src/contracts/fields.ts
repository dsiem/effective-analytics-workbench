import { Schema } from "effect";

export const boundedText = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

export const Id = Schema.String.check(Schema.isUUID(4));
