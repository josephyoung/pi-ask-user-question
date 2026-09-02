const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseOneLevel(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** Pi 0.82.1 compatibility shim that runs before TypeBox validation. */
export function prepareArguments(raw: unknown): Record<string, unknown> {
  const parsed = parseOneLevel(raw);
  if (!isRecord(parsed)) return { __invalidRequest: parsed };

  const prepared = { ...parsed };
  for (const key of ["questions", "options", "choices", "dataSource", "data_source"] as const) {
    if (key in prepared) prepared[key] = parseOneLevel(prepared[key]);
  }
  return prepared;
}
