import type postgres from "postgres";

type JsonParameterFactory = Pick<postgres.Sql, "json">;

export function jsonParameter(sql: JsonParameterFactory, value: unknown): postgres.Parameter {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Database JSON values must be serializable");
  return sql.json(JSON.parse(encoded) as postgres.JSONValue);
}
