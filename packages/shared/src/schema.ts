import { Schema } from "effect";

export const boundedText = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

export const Id = Schema.String.check(Schema.isUUID(4));

export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const Zip = Schema.String.check(Schema.isPattern(/^\d{5}$/));
export const Day = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter(
    (s) =>
      !Number.isNaN(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s,
  ),
);
