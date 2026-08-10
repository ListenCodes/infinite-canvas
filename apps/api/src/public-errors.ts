const generationMessages: Readonly<Record<string, string>> = {
  content_moderation_rejected:
    "The provider rejected this request under its content policy.",
  provider_canceled: "The provider confirmed that the request was canceled.",
  provider_empty_result: "The provider completed without returning usable media.",
  business_deadline_exceeded: "The generation deadline expired before completion.",
  dispatch_unavailable: "The generation service could not schedule this request.",
  worker_validation_failed: "The saved generation input is no longer valid.",
  provider_outcome_unknown:
    "The provider outcome is still being reconciled. Credits remain protected.",
};

const importMessages: Readonly<Record<string, string>> = {
  invalid_import_archive: "The migration archive is invalid or unsupported.",
  import_manifest_mismatch: "The migration archive does not match its manifest.",
  import_publish_failed: "The migrated project could not be published.",
  dispatch_unavailable: "The migration service could not schedule this import.",
};

export function publicGenerationErrorMessage(errorCode: string): string {
  return (
    generationMessages[errorCode] ??
    "Generation could not be completed. Retry the affected slot or contact support with the job ID."
  );
}

export function publicImportErrorMessage(errorCode: string): string {
  return (
    importMessages[errorCode] ??
    "The migration could not be completed. Retry it or contact support with the import ID."
  );
}
