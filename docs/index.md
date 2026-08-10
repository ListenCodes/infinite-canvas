# Infinite Canvas Documentation Index

## Overview

- [Quick Start](/docs/overview/quick-start)
- [Features](/docs/overview/features)
- [Deploy on Render](/docs/overview/render)
- [Docker Deployment](/docs/overview/docker)
- [Third-party GitHub Prompt Repositories](/docs/overview/third-party-prompt-repositories)

## Canvas Guide

- [Canvas Node Guide](/docs/canvas/canvas-node-manual)
- [Canvas Shortcuts](/docs/canvas/canvas-shortcuts)

## Development and Data

- [Local Development](/docs/development/local-development)
- [Canvas Data Structure](/docs/development/canvas-data-structure)
- [How the Local Codex Connection Works](/docs/development/local-codex-canvas)
- [Hatchet Architecture ADR](adr/0001-hatchet-service-architecture.md)
- [Reliability and Billing ADR](adr/0002-reliability-billing-and-schema-resolutions.md)
- [Local Data Export v1](implementation/local-data-export-v1.md)
- [Generation Error Catalog](implementation/error-catalog.md)
- [Capacity and Environment Baseline](implementation/capacity-and-environments.md)

## Cloud Operations

- [Deployment Runbook](operations/deployment.md)
- [Configuration Reference](operations/configuration.md)
- [Database Migrations](operations/database-migrations.md)
- [Worker Upgrade and Drain](operations/upgrade-and-drain.md)
- [Backup and Restore](operations/backup-restore.md)
- [Rollback](operations/rollback.md)
- [Administrator Guide](operations/admin-guide.md)
- [Cloud User Guide](operations/cloud-user-guide.md)
- [Release Acceptance](operations/release-acceptance.md)

## Business

- [Open-source License](/docs/business/license)
- [Business Cooperation](/docs/business/business)

## Support and Security

- [Report a Vulnerability](/docs/support/security)
- [Sponsor the Project](/docs/support/sponsor)

## Project Progress

- [Changelog](/docs/progress/changelog)
- [Pending Tests](/docs/progress/pending-test)
- [TODO](/docs/progress/todo)

## Notes

- Legacy mode stores canvas projects, assets, and user-provided API keys in the browser.
- Cloud mode stores projects, tasks, assets, permissions, and credits in the service; platform provider keys and Hatchet tokens remain server-side only.
