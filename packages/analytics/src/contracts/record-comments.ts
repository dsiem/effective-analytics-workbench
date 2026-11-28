import { Schema } from "effect";
import { UserIdentity } from "./user-identity.js";
import { CursorPage, CursorTimestamp } from "./cursor-page.js";
import { boundedText, Id } from "./fields.js";

export const CommentCursor = Schema.Struct({
  id: Id,
  createdAt: CursorTimestamp,
});
export type CommentCursor = typeof CommentCursor.Type;

export const CommentCounts = Schema.Record(Schema.String, Schema.Natural);
export const commentSchemas = <RecordFields extends Schema.Struct.Fields>(
  fields: RecordFields,
) => {
  const Input = Schema.Struct({
    ...fields,
    id: Id,
    body: boundedText(4000).check(
      Schema.makeFilter((body) => body.trim().length > 0),
    ),
  });
  const Comment = Schema.Struct({
    ...Input.fields,
    author: Schema.NullOr(UserIdentity),
    created_at: Schema.String,
  });
  return { Input, Comment, Page: CursorPage(Comment, CommentCursor) };
};
