interface MigrationAuditRow {
  name: string;
  sha256: string;
  applied_at: Date | string;
}

function migrationAppliedAt(row: MigrationAuditRow): Date {
  const value = row.applied_at;
  const timestamp = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new TypeError(`Migration ${row.name} has an invalid applied_at timestamp`);
  }
  return timestamp;
}

export function summarizeMigrationAudit(rows: readonly MigrationAuditRow[]) {
  const dated = rows.map((row) => ({ row, appliedAt: migrationAppliedAt(row) }));
  return {
    count: rows.length,
    lastAppliedAt: dated.length > 0
      ? new Date(Math.max(...dated.map(({ appliedAt }) => appliedAt.getTime()))).toISOString()
      : null,
    entries: dated.map(({ row, appliedAt }) => ({
      name: row.name,
      sha256: row.sha256,
      appliedAt: appliedAt.toISOString(),
    })),
  };
}
