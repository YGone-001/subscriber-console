# API Documentation

This project uses Next.js App Router Route Handlers under `src/app/api`.

## Recommended API Documentation Structure

For each endpoint, document:

- Method and path
- Required role
- Request body or query parameters
- Response shape
- Error responses
- Redis keys touched
- Audit action emitted

## Current Endpoint Groups

### Authentication

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/auth/users`
- `POST /api/auth/users`
- `PUT /api/auth/users/[username]`
- `DELETE /api/auth/users/[username]`

### Subscribers

- `GET /api/subscribers`
- `POST /api/subscribers`
- `GET /api/subscribers/[imsi]`
- `PUT /api/subscribers/[imsi]`
- `DELETE /api/subscribers/[imsi]`
- `POST /api/subscribers/import`
- `POST /api/subscribers/batch/precheck`
- `POST /api/subscribers/batch`

### Profiles

- `GET /api/profiles`
- `POST /api/profiles`
- `GET /api/profiles/[name]`
- `PUT /api/profiles/[name]`
- `DELETE /api/profiles/[name]`
- `GET /api/profiles/[name]/versions`
- `POST /api/profiles/[name]/versions/[versionId]/restore`

### Ratings

- `GET /api/ratings`
- `POST /api/ratings`
- `PUT /api/ratings/[id]`
- `DELETE /api/ratings/[id]`

### Analytics, Audit, Alerts, and Health

- `POST /api/analytics/init`
- `GET /api/analytics/metrics`
- `GET /api/analytics/sparkline`
- `GET /api/audit`
- `GET /api/alerts`
- `POST /api/alerts/acknowledge`
- `GET /api/system/audit/status`
- `POST /api/system/audit/scan`
- `POST /api/system/audit/heal`

## TODO

- Add exact request and response schemas.
- Add role matrix for every endpoint.
- Add example payloads for subscriber import, profile templates, rating policies, and repair actions.
- Consider generating OpenAPI output from typed route metadata.
