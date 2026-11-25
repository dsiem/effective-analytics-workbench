import type { RecordBatch, Table } from "apache-arrow";
import {
  Config,
  Context,
  type Duration,
  Effect,
  Layer,
  Option,
  type Redacted,
  Stream,
} from "effect";
import type { HttpClient } from "effect/http";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";
import { makeExecution } from "./internal/execution.js";
import {
  failure,
  TypedParameter,
  UnsupportedSqlFragment,
} from "./internal/protocol.js";

export { isStatementTimeout } from "./internal/protocol.js";

/** Ordinary statements use inline JSON. Both the default result and .raw collect named rows. */
export interface DatabricksClient extends Client.Base {
  /** Streams inline JSON_ARRAY chunks as named rows. Each SQL value is a string or null. */
  readonly jsonStream: (
    statement: Statement.Statement<unknown>,
  ) => Stream.Stream<Record<string, string | null>, SqlError>;
  /** Reads the first inline JSON chunk as named rows and exposes a paged reader. */
  readonly jsonPage: (
    statement: Statement.Statement<unknown>,
    options: { readonly rowLimit: number },
  ) => Effect.Effect<
    {
      readonly rows: ReadonlyArray<Record<string, string | null>>;
      readonly pageCount: number;
      readonly truncated: boolean;
      /** Fetches a continuation using the row count accumulated through earlier chunks. */
      readonly readChunk: (
        index: number,
        offset: number,
      ) => Effect.Effect<
        ReadonlyArray<Record<string, string | null>>,
        SqlError
      >;
    },
    SqlError
  >;
  /** Materializes all result chunks as one columnar Arrow table. */
  readonly arrow: (
    statement: Statement.Statement<unknown>,
  ) => Effect.Effect<Table, SqlError>;
  /** Pulls one Databricks result chunk at a time, preserving its Arrow schema. */
  readonly arrowChunks: (
    statement: Statement.Statement<unknown>,
  ) => Stream.Stream<Table, SqlError>;
  /** Emits record batches without constructing JavaScript row objects. */
  readonly arrowStream: (
    statement: Statement.Statement<unknown>,
  ) => Stream.Stream<RecordBatch, SqlError>;
  /** Each element is an independent, complete Arrow IPC stream. Do not concatenate. */
  readonly ipcStream: (
    statement: Statement.Statement<unknown>,
    limits?: { readonly maxBytes: number },
  ) => Stream.Stream<Uint8Array, SqlError>;
  /** Applies queryTimeout to a complete consumer, including downstream work. */
  readonly withQueryTimeout: <A, E, R>(
    consumer: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError, R>;
  /** Bind e.g. DECIMAL(38, 2), DATE, or a typed NULL without lossy conversion. */
  readonly param: (type: string, value: string | null) => Statement.Fragment;
}

export const DatabricksClient = Context.Service<
  DatabricksClient,
  DatabricksClient & Client.SqlClient
>("@dsiem/sql-warehouse/DatabricksClient");

export interface DatabricksClientConfig {
  readonly host: string;
  readonly warehouseId: string;
  /** Evaluated for every workspace request, allowing expiry-aware token providers. */
  readonly accessToken: Effect.Effect<Redacted.Redacted<string>, SqlError>;
  readonly catalog?: string;
  readonly schema?: string;
  readonly pollInterval?: Duration.Input;
  /** Source deadline for submission, polling, and downloads. Use withQueryTimeout for downstream work. Default: 2 minutes. */
  readonly queryTimeout?: Duration.Input;
  /** Deadline per HTTP request, including its body. Default: 30 seconds. */
  readonly requestTimeout?: Duration.Input;
  /** Optional server result limit. Truncation is always reported as an error. */
  readonly byteLimit?: number;
  /** Handles Statement Execution requests only. Configure middleware to send each submission once. */
  readonly workspaceHttpClient?: HttpClient.HttpClient;
  readonly fetch?: typeof globalThis.fetch;
  /** Opt in only inside Databricks Apps, whose managed network rewrites signed result links to this exact internal HTTP proxy. Workspace credentials are never forwarded. */
  readonly allowDatabricksStorageProxy?: boolean;
}

// Effect's compiler is synchronous. Carry unsupported syntax to the bind step
// so executing a statement fails in its SqlError channel before submission.
const unsupportedFragment = (message: string) =>
  [
    "/* unsupported SQL fragment */",
    [new UnsupportedSqlFragment(message)],
  ] as const;

/** Spark SQL uses backticks and the REST API requires named parameter markers. */
const makeCompiler = (): Statement.Compiler =>
  Statement.makeCompiler({
    // Effect 4.1's closed dialect union has no Spark entry. The mysql branch
    // supplies compatible generic helper behavior; this is still a Spark compiler.
    dialect: "mysql",
    placeholder: (index) => `:p${index}`,
    onIdentifier: Statement.defaultEscape("`"),
    onRecordUpdate() {
      return unsupportedFragment(
        "Databricks does not support Effect's updateValues helper",
      );
    },
    onCustom() {
      return unsupportedFragment(
        "Unsupported custom SQL fragment for Databricks",
      );
    },
  });

// Spark is absent from Effect's dialect union. Never dispatch a caller's MySQL SQL.
const sparkDialect: Pick<
  Statement.Constructor,
  "onDialect" | "onDialectOrElse"
> = {
  onDialect: () => {
    throw new Error(
      "Spark SQL has no Effect dialect branch; use onDialectOrElse or sql.driver",
    );
  },
  onDialectOrElse: (options) => options.orElse(),
};

export const make = (
  options: DatabricksClientConfig,
): Effect.Effect<
  DatabricksClient & Client.SqlClient,
  SqlError,
  Reactivity.Reactivity
> =>
  Effect.gen(function* () {
    const { connection, page, chunks, ipc, collectTable, withQueryTimeout } =
      yield* makeExecution(options);
    const compiler = makeCompiler();
    const spanAttributes: ReadonlyArray<readonly [string, unknown]> = [
      ["db.system.name", "databricks"],
      ["db.namespace", options.warehouseId],
    ];
    const client = yield* Client.make({
      acquirer: Effect.succeed(connection),
      compiler,
      driver: "databricks",
      spanAttributes,
      // Independent REST statements do not share a transaction/session.
      transactionAcquirer: Effect.fail(
        failure(
          "Transactions are not supported by this Databricks REST adapter",
          "transaction",
        ),
      ),
    });
    // Reuse Statement's execution boundary for transformers and client spans.
    // These connections change only the streaming result shape, not row queries
    // that a transformer might execute with the constructor it receives.
    const streamStatement = <A extends object>(
      executeStream: (
        text: string,
        params: ReadonlyArray<unknown>,
      ) => Stream.Stream<A, SqlError>,
    ) => {
      const sql = Object.assign(
        Statement.make(
          Effect.succeed({ ...connection, executeStream }),
          compiler,
          spanAttributes,
          undefined,
        ),
        sparkDialect,
      );
      return (statement: Statement.Statement<unknown>) =>
        sql<A>`${statement}`.stream;
    };
    const arrowChunks = streamStatement(chunks);
    return Object.assign(client, {
      ...sparkDialect,
      reserve: Effect.fail(
        failure(
          "Databricks REST does not support reserving a session",
          "reserve",
        ),
      ),
      // There are no name or row transforms to remove. Keep the driver's APIs
      // and Spark dialect dispatch when generic consumers request this view.
      withoutTransforms: () => client,
      arrow: (statement: Statement.Statement<unknown>) =>
        collectTable(arrowChunks(statement)),
      jsonStream: (statement: Statement.Statement<unknown>) =>
        client<Record<string, string | null>>`${statement}`.stream,
      jsonPage: (
        statement: Statement.Statement<unknown>,
        { rowLimit }: { readonly rowLimit: number },
      ) =>
        streamStatement((text, params) => page(text, params, rowLimit))(
          statement,
        ).pipe(
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onSome: Effect.succeed,
              onNone: () =>
                Effect.fail(failure("Missing inline JSON page", "decodeJson")),
            }),
          ),
        ),
      arrowChunks,
      arrowStream: (statement: Statement.Statement<unknown>) =>
        arrowChunks(statement).pipe(
          Stream.flatMap((table) => Stream.fromIterable(table.batches)),
        ),
      ipcStream: (
        statement: Statement.Statement<unknown>,
        limits?: { readonly maxBytes: number },
      ) =>
        streamStatement((text, params) => ipc(text, params, limits?.maxBytes))(
          statement,
        ),
      withQueryTimeout,
      param: (type: string, value: string | null) =>
        Statement.fragment([
          Statement.parameter(new TypedParameter(type, value)),
        ]),
    });
  });

const layerFrom = <E>(
  acquire: Effect.Effect<
    DatabricksClient & Client.SqlClient,
    E,
    Reactivity.Reactivity
  >,
): Layer.Layer<DatabricksClient | Client.SqlClient, E> =>
  Layer.effectContext(
    Effect.map(acquire, (client) =>
      Context.make(DatabricksClient, client).pipe(
        Context.add(Client.SqlClient, client),
      ),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

/** Provides both driver-specific and generic SQL services with shared client state. */
export const layer = (
  options: DatabricksClientConfig,
): Layer.Layer<DatabricksClient | Client.SqlClient, SqlError> =>
  layerFrom(make(options));

/** Loads client options from the active Effect ConfigProvider. */
export const layerConfig = (
  options: Config.Wrap<DatabricksClientConfig>,
): Layer.Layer<
  DatabricksClient | Client.SqlClient,
  Config.ConfigError | SqlError
> => layerFrom(Effect.flatMap(Config.unwrap(options), make));
