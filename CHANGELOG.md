# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows semantic versioning where practical.

## [Unreleased]

### Added

- OCS management UI: dashboard (`/ocs/dashboard`) with KPI cards, subscriber contracts table (`/ocs/subscribers`).
- Go backend: `GET /api/ocs/subscribers` read implementation.
- Go backend: subscriber batch operations cutover (batch create, batch update, import, bulk delete).
- Go backend: subscriber single CRUD cutover (create, update, delete).
- Go backend: profile CRUD cutover (create, update, delete, restore).
- Go backend: approval governance (approve, reject, cancel, create, legacy compat).
- Go backend: auth and user management read APIs.
- Go backend: subscriber list/detail, search, profiles, OCS, tariff, ratings, analytics, audit read APIs.
- Go backend foundation: config, Mongo client, health, HTTP handler, middleware, rate limiter, graceful shutdown.
- Migration routing matrix and validator tools.
- OCS management domain architecture documentation.
- Initial project documentation, contribution guidelines, security policy, and GitHub templates.
- Development quality gate with `typecheck`, `check`, Node version pinning, and GitHub Actions CI.

## [0.1.0] - 2026-07-06

### Added

- Initial Next.js subscriber operations console source.
- MongoDB-backed IMSI subscriber management.
- Profile, Rating, analytics, audit log, system health, and role-based access features.
