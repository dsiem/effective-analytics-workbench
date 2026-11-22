import assert from "node:assert/strict";
import { Table, tableFromArrays, tableToIPC } from "apache-arrow";

type Row = Record<string, string | number | null>;
type Parameter = { name: string; type: string; value: string | null };

export function inlineResult(rows: readonly Row[], rowLimit = rows.length) {
  const truncated = rows.length > rowLimit;
  rows = rows.slice(0, rowLimit);
  const names = Object.keys(rows[0] ?? {});
  const columns = names.map((name, position) => {
    const value = rows.find((row) => row[name] != null)?.[name];
    const type = typeof value === "number" ? "DOUBLE" : "STRING";
    return { name, position, type_name: type, type_text: type };
  });
  return {
    manifest: {
      format: "JSON_ARRAY",
      schema: { column_count: columns.length, columns },
      total_chunk_count: 1,
      total_row_count: rows.length,
      truncated,
    },
    result: {
      chunk_index: 0,
      row_offset: 0,
      row_count: rows.length,
      data_array: rows.map((row) =>
        names.map((name) => (row[name] == null ? null : String(row[name]))),
      ),
    },
  };
}

// Exercise the real SQL adapter without a workspace or signed storage endpoint.
export const warehouseFetch = (
  beforeStatement: (
    sql: string,
    signal: AbortSignal,
    parameters: ReadonlyArray<Parameter>,
  ) => Promise<void | Table | readonly Row[]> = async () => {},
): typeof globalThis.fetch => {
  const chunks = new Map<string, Uint8Array>();
  let sequence = 0;
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url.startsWith("https://results.invalid/")) {
      const bytes = chunks.get(request.url);
      if (!bytes) throw new Error("Unknown result chunk");
      return new Response(new Uint8Array(bytes));
    }
    if (request.method !== "POST" || !request.url.endsWith("/sql/statements"))
      throw new Error(
        `Unexpected warehouse request: ${request.method} ${request.url}`,
      );
    const {
      statement,
      parameters = [],
      format,
      disposition,
      row_limit,
    } = (await request.json()) as {
      statement: string;
      parameters?: ReadonlyArray<Parameter>;
      format: string;
      disposition: string;
      row_limit?: number;
    };
    const result = await beforeStatement(statement, request.signal, parameters);
    const id = String(++sequence);
    if (format === "JSON_ARRAY") {
      assert.equal(disposition, "INLINE");
      assert.ok(!(result instanceof Table));
      return Response.json({
        statement_id: id,
        status: { state: "SUCCEEDED" },
        ...inlineResult(
          result ??
            (/MIN\(tpep_pickup_datetime\)/.test(statement)
              ? [{ from: "2016-01-01", to: "2016-12-31", trips: 10 }]
              : []),
          row_limit,
        ),
      });
    }
    assert.equal(format, "ARROW_STREAM");
    assert.equal(disposition, "EXTERNAL_LINKS");
    const url = `https://results.invalid/${id}`;
    assert.ok(result === undefined || result instanceof Table);
    chunks.set(url, tableToIPC(result ?? tableFromArrays({})));
    return Response.json({
      statement_id: id,
      status: { state: "SUCCEEDED" },
      manifest: {
        format: "ARROW_STREAM",
        total_chunk_count: 1,
        truncated: false,
      },
      result: { external_links: [{ chunk_index: 0, external_link: url }] },
    });
  };
};
