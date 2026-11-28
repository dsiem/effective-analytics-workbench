import { Schema } from "effect";
export { boundedText, Id } from "@dsiem/analytics/contracts";

export const Zip = Schema.String.check(Schema.isPattern(/^\d{5}$/));
export const Day = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter(
    (s) =>
      !Number.isNaN(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s,
  ),
);
