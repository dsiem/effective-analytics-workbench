import { Config, Schema } from "effect";

export const ServerConfig = Config.all({
  host: Config.String("APP_BIND_HOST").pipe(Config.withDefault("0.0.0.0")),
  // Port 0 lets the OS select an available port for the built-app smoke check.
  port: Config.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
    "DATABRICKS_APP_PORT",
  ).pipe(Config.withDefault(3000)),
});
