# Deployment

## Environment Requirements

- Node.js 20 or newer
- npm compatible with the checked-in `package-lock.json`
- MongoDB reachable from the Next.js server
- TLS termination in front of the application for production

## Build Steps

```bash
npm ci
npm run mongo:init
npm run build
```

The application uses Next.js server features and API Route Handlers. Use a Node.js deployment target rather than a pure static export.

## Configuration

Create production environment variables in the hosting platform or process manager. Do not commit a real `.env` file.

Required variables:

| Variable | Description |
| --- | --- |
| `MONGODB_URI` | MongoDB connection URI, usually the xCloud MongoDB host |
| `MONGODB_DB` | xCloud data database name, default `xcloud` |
| `MONGODB_APP_DB` | Application operations database for `app_*` collections, default `xcloud_ops` |
| `JWT_SECRET` | JWT signing secret, at least 32 bytes |
| `INITIAL_ADMIN_PASSWORD` | Optional bootstrap password for the first `admin` account |

Optional MongoDB tuning variables:

| Variable | Default |
| --- | --- |
| `MONGODB_MAX_POOL_SIZE` | `20` |
| `MONGODB_MIN_POOL_SIZE` | `0` |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | `5000` |

Security notes:

- Use a unique `JWT_SECRET` for each environment.
- Rotate `INITIAL_ADMIN_PASSWORD` after bootstrap by changing the admin password or disabling bootstrap usage.
- Keep MongoDB private to the application and xCloud network.

## Start Command

```bash
npm run start
```

The default Next.js server listens on port `13333` unless configured otherwise through the runtime environment.

## Recommended Production Flow

1. Provision MongoDB or reuse the xCloud MongoDB host.
2. Configure environment variables in the deployment platform.
3. Run `npm ci`.
4. Run `npm run mongo:init` to create indexes in both the xCloud and application databases.
5. Run `npm run build`.
6. Start with `npm run start`.
7. Log in with the bootstrap `admin` account if needed.
8. Create named operator/viewer accounts and store credentials securely.

## Common Issues

### Login fails with server error

Check that `JWT_SECRET` exists, is not a placeholder, and is at least 32 bytes.

### Admin account is not created

Ensure `INITIAL_ADMIN_PASSWORD` is set in `.env` (at least 8 characters) and run `npm run mongo:init` to bootstrap the root `admin` user.

### Dashboard or API data is empty

Confirm `MONGODB_URI`, `MONGODB_DB`, and `MONGODB_APP_DB` point to the expected databases, then run `npm run mongo:init`.

### Build succeeds but runtime APIs fail

Confirm production environment variables are available to the Node.js process, not only during build.
