# Deployment

## Environment Requirements

- Node.js 20 or newer
- npm compatible with the checked-in `package-lock.json`
- Redis 6 or newer
- Network access from the Next.js server to Redis
- TLS termination in front of the application for production

## Build Steps

```bash
npm ci
npm run build
```

The application uses Next.js server features and API Route Handlers. Use a Node.js deployment target rather than a pure static export.

## Configuration

Create production environment variables in the hosting platform or process manager. Do not commit a real `.env` file.

Required variables:

| Variable | Description |
| --- | --- |
| `REDIS_HOST` | Redis host |
| `REDIS_PORT` | Redis port |
| `JWT_SECRET` | JWT signing secret, at least 32 bytes |
| `INITIAL_ADMIN_PASSWORD` | Optional bootstrap password for the first `admin` account |

Security notes:

- Use a unique `JWT_SECRET` for each environment.
- Rotate `INITIAL_ADMIN_PASSWORD` after bootstrap by changing the admin password or disabling bootstrap usage.
- Keep Redis private to the application network.

## Start Command

```bash
npm run start
```

The default Next.js server listens on port `3000` unless configured otherwise through the runtime environment.

## Recommended Production Flow

1. Provision Redis.
2. Configure environment variables in the deployment platform.
3. Run `npm ci`.
4. Run `npm run build`.
5. Start with `npm run start`.
6. Log in with the bootstrap `admin` account if needed.
7. Create named operator/viewer accounts and store credentials securely.

## Common Issues

### Login fails with server error

Check that `JWT_SECRET` exists, is not a placeholder, and is at least 32 bytes.

### Admin account is not created

Ensure `INITIAL_ADMIN_PASSWORD` is set and satisfies the password policy: at least 10 characters with uppercase, lowercase, number, and symbol.

### Dashboard or API data is empty

Verify Redis connectivity and confirm the expected subscriber, profile, rating, and analytics keys exist.

### Build succeeds but runtime APIs fail

Confirm production environment variables are available to the Node.js process, not only during build.
