/*
 * Route module loading and failure states.
 *
 * Business pages are loaded through `route.lazy`, so a navigation can pause on
 * a module download and a download can fail. Both situations need an honest,
 * accessible surface:
 *
 *   - `InitialRouteFallback` is the boot state for a cold deep link. React
 *     Router renders it instead of an empty document while the first route
 *     module is resolved.
 *   - `RouteLoadingAnnouncer` is the polite live region the shell exposes while
 *     an in-app navigation waits for its module. The previously rendered page
 *     stays on screen, so no skeleton and no layout flash is introduced.
 *   - `RouteLoadError` is the error boundary element for a failed route module.
 *     It never claims the session is invalid, never re-issues a business
 *     request, and offers a single user-initiated reload instead of retrying in
 *     a loop.
 */
import { useNavigation, useRouteError } from 'react-router-dom';
import { useI18n } from '../providers/I18nProvider';
import { ErrorState, LoadingState } from '../components/ui/StatePanel';

/**
 * Browser messages for a failed dynamic import. Chromium, Firefox and WebKit
 * each phrase it differently; the transport failure ("Failed to fetch") is
 * included because a chunk request that cannot complete surfaces that way.
 */
const MODULE_FAILURE_PATTERN =
  /dynamically imported module|module script failed|failed to fetch|error loading dynamically imported module|importing a module script failed/i;

function isModuleLoadFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return MODULE_FAILURE_PATTERN.test(error.message);
}

/** Full-page boot state shown while the first route module is downloaded. */
export function InitialRouteFallback() {
  const { t } = useI18n();
  return (
    <div className="state-page">
      <LoadingState label={t('route_loading')} />
    </div>
  );
}

/** Polite announcement rendered by the shell while a route module loads. */
export function RouteLoadingAnnouncer() {
  const { t } = useI18n();
  const navigation = useNavigation();
  const pending = navigation.state !== 'idle';
  return (
    <span className="visually-hidden" role="status" aria-live="polite">
      {pending ? t('route_loading') : ''}
    </span>
  );
}

/**
 * Error boundary for a route that could not be loaded or rendered.
 *
 * A chunk download failure is reported as an asset problem, not as an
 * authorization problem: the operator keeps their session and is told to
 * reload. Anything else is reported as an unexpected page error.
 */
export function RouteLoadError() {
  const { t } = useI18n();
  const error = useRouteError();
  const moduleFailure = isModuleLoadFailure(error);

  return (
    <div className="state-page">
      <ErrorState
        title={moduleFailure ? t('route_load_failed_title') : t('route_error_title')}
        message={moduleFailure ? t('route_load_failed_desc') : t('route_error_desc')}
        retryLabel={t('route_load_retry')}
        onRetry={() => window.location.reload()}
      />
    </div>
  );
}
