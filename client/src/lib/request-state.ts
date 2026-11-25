import { Schema } from "effect";
import { AsyncData } from "foldkit";

export const AccessDenied = Schema.TaggedStruct("AccessDenied", {
  message: Schema.String,
});
export const Notice = Schema.Union([Schema.String, AccessDenied]);
export type Notice = typeof Notice.Type;

export const fromResponse = <A>({
  data,
  error,
}: {
  readonly data: A | null;
  readonly error: Notice;
}): AsyncData.AsyncData<A, Notice> => {
  if (error) return AsyncData.fail(error);
  return data === null ? AsyncData.Idle() : AsyncData.succeed(data);
};
