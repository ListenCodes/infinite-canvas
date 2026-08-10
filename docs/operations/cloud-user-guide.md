# Cloud User Guide

Cloud mode keeps the canvas in the existing React application while moving account,
project, generation task, asset, and credit state to the service. Legacy browser-only
channels remain available only when the deployment feature policy permits them.

## Sign in and projects

Sign in through the account menu. The first successful session creates a personal
workspace and wallet. Cloud projects synchronize by project version; a conflicting
newer server version must be reviewed instead of overwritten blindly.

The local-data import flow uploads an export without deleting or modifying the
browser copy. Repeating the same export is idempotent. Keep the original local data
until the imported project and assets have been verified on another signed-in device.

## Generation tasks

A three-image request creates one batch with three independent slots. Slots run in
parallel and keep their own status and error. Successful slots remain available when
another slot fails. Retry creates a new attempt only for the selected failed/canceled
slot and may reserve credits again.

Closing or refreshing the browser does not cancel server-side work. The Tasks page
and canvas reload from the batch snapshot and SSE cursor. During temporary SSE
failure, the application polls snapshots; it does not submit the generation again.

`outcome_unknown` means a paid provider request may have been accepted but the
response could not be proven. Credits remain reserved while the platform checks the
provider. This state cannot be retried by the user. It is resolved by authoritative
evidence or, after at most 24 hours, released with platform risk recorded.

## Cancellation and assets

- Before provider submission, cancellation releases all reserved credits.
- After provider acceptance, cancellation is requested but the platform waits for a
  confirmed terminal state.
- If an asset is stored successfully, the user keeps it and the full reservation is
  settled even if cancellation was requested concurrently.

Ready assets use short-lived signed download URLs. A download error does not trigger
another provider generation. The canvas retries materialization a bounded number of
times and then displays a local recovery error while the server task remains visible.

## Security

Never enter platform provider keys or Hatchet tokens in the browser. The only public
Supabase value is the anon/publishable key. Report any response, log, browser storage,
or bundle containing a service-role key, credential master key, provider platform
key, or Hatchet token as a security incident.
