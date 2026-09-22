import { requireAuth } from '@/lib/authz';
import { validateCurrentAccount } from '@/lib/accountSession';
import { listAlerts } from '@/server/repositories/alertRepository';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const user = auth.auth.user;
  const encoder = new TextEncoder();

  let isClosed = false;
  let intervalId: NodeJS.Timeout | null = null;
  let lastAlertsCount = -1;
  let lastHeartbeat = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: string, data: unknown) => {
        if (isClosed) return;
        try {
          const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          cleanup();
        }
      };

      const sendComment = (comment: string) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(`:${comment}\n\n`));
        } catch {
          cleanup();
        }
      };

      const cleanup = () => {
        if (isClosed) return;
        isClosed = true;
        if (intervalId) clearInterval(intervalId);
        try {
          controller.close();
        } catch {}
      };

      request.signal.addEventListener('abort', cleanup);

      // Initial snapshot fetch
      try {
        const alertData = await listAlerts(15).catch(() => ({ alerts: [], activeCriticalCount: 0, activeWarningCount: 0, activeCount: 0 }));

        lastAlertsCount = alertData.activeCount;

        sendEvent('init', {
          timestamp: new Date().toISOString(),
          user,
          role: auth.auth.role,
          alerts: {
            activeCriticalCount: alertData.activeCriticalCount,
            activeWarningCount: alertData.activeWarningCount,
            activeCount: alertData.activeCount,
            recent: alertData.alerts.slice(0, 5),
          },
        });
      } catch (err) {
        sendComment(`init_error: ${String(err)}`);
      }

      // Periodic check every 4 seconds
      intervalId = setInterval(async () => {
        if (isClosed) return;

        try {
          await validateCurrentAccount({ username: user, role: auth.auth.role, sv: auth.auth.sessionVersion });
        } catch {
          sendEvent('session_expired', {});
          cleanup();
          return;
        }

        try {
          const alertData = await listAlerts(10).catch(() => null);

          let hasUpdate = false;

          if (alertData && (alertData.activeCount !== lastAlertsCount)) {
            lastAlertsCount = alertData.activeCount;
            hasUpdate = true;
            sendEvent('alerts_update', {
              timestamp: new Date().toISOString(),
              activeCriticalCount: alertData.activeCriticalCount,
              activeWarningCount: alertData.activeWarningCount,
              activeCount: alertData.activeCount,
              latestAlerts: alertData.alerts.slice(0, 5),
            });
          }

          // Ping heartbeat if no update for 12 seconds
          const now = Date.now();
          if (!hasUpdate && now - lastHeartbeat >= 12000) {
            lastHeartbeat = now;
            sendComment('ping');
          }
        } catch {
          // Keep connection alive even on transient mongo errors
          sendComment('transient_retry');
        }
      }, 4000);
    },
    cancel() {
      isClosed = true;
      if (intervalId) clearInterval(intervalId);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
