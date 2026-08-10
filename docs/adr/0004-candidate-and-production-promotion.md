# ADR 0004: Candidate build and production promotion

- Status: accepted
- Baseline: design v1.1, chapter 25

## Context

Repository and CI tests can prove deterministic engineering behavior, but chapter 25
also requires Staging, provider, managed-service, outage, network, alerting, and
restore evidence. Publishing version image tags or marking a GitHub Release as
latest before those external rows pass turns an engineering candidate into a
deployment signal too early.

## Decision

- A `v*` tag builds one immutable three-image candidate, persists its manifest and
  combined-restore evidence in a draft GitHub Release, and publishes only
  `sha-<commit>` candidate tags.
- Version image tags and the published/latest GitHub Release are created only by the
  manual `promote-production.yml` workflow.
- The promotion job uses the protected `production-acceptance` GitHub Environment.
  It checks out the release tag, validates the candidate manifest, and verifies the
  reviewed SHA-256 of `production-acceptance.json`.
- The acceptance file must bind the source SHA, release tag, all three digest
  references, and exactly the 15 chapter-25 rows. Every row must be passed, have an
  independent reviewer and a stable non-signed HTTPS evidence URI, and have no
  unresolved limitations. Row 15 requires managed-production restore evidence.
- Image-tag creation is collision-safe and repeatable. The Release remains draft if
  any service promotion fails; publication is the final operation.

## Consequences

GitHub Environment reviewers and protection rules must be configured outside the
repository before production promotion. Operators must upload the reviewed evidence
file to the draft Release without replacing an existing asset and dispatch promotion
with its SHA-256. A draft Release, candidate tag, Actions artifact, or successful CI
gate is not a production-ready signal.
