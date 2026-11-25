import { Schema } from "effect";

export const queryRowsMatchMetadata = (
  rows: ReadonlyArray<ReadonlyArray<string | null>>,
  columnCount: number,
  totalRowCount: number | null | undefined,
) =>
  (totalRowCount == null || rows.length <= totalRowCount) &&
  rows.every((row) => row.length === columnCount);

export type GenieAttachment =
  | {
      readonly kind: "text";
      readonly attachmentId?: string;
      readonly content: string;
    }
  | {
      readonly kind: "suggested-questions";
      readonly attachmentId?: string;
      readonly payload: unknown;
    }
  | {
      readonly kind: "visualization";
      readonly attachmentId?: string;
      readonly payload: unknown;
    }
  | {
      readonly kind: "query";
      readonly attachmentId: string;
      readonly sql: string;
      readonly description?: string;
      readonly columns: ReadonlyArray<{
        readonly name: string;
        readonly typeName?: string;
        readonly typeText?: string;
      }>;
      readonly rows: ReadonlyArray<ReadonlyArray<string | null>>;
      readonly totalRowCount?: number;
      readonly truncated: boolean;
      readonly nextChunkIndex?: number;
    };

export const GenieAttachmentWarning = Schema.Struct({
  kind: Schema.Literal("unsupported-attachments"),
  count: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type GenieAttachmentWarning = typeof GenieAttachmentWarning.Type;

export interface GenieAnswer {
  readonly attachments: ReadonlyArray<GenieAttachment>;
  readonly warning?: GenieAttachmentWarning;
}
