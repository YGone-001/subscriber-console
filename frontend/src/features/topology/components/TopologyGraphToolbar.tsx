/*
 * Shared graph toolbar.
 *
 * All controls are controlled by the owning view. A control group is rendered
 * only when the view provides its handlers, so moving a source into the shell
 * never invents a capability that source does not have yet.
 */
import type { ReactNode } from 'react';
import { Expand, Minimize, Minus, RotateCcw, Scan, Search, ZoomIn } from 'lucide-react';
import { useI18n } from '../../../providers/I18nProvider';
import styles from '../../../styles/modules/topology.module.css';

export type TopologyGraphSearch = {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
};

export type TopologyGraphZoom = {
  value: number;
  min: number;
  max: number;
  onIn: () => void;
  onOut: () => void;
  onFit: () => void;
  onReset: () => void;
};

export type TopologyGraphFullscreen = {
  active: boolean;
  onToggle: () => void;
};

export type TopologyGraphToolbarProps = {
  search?: TopologyGraphSearch;
  filters?: ReactNode;
  actions?: ReactNode;
  zoom?: TopologyGraphZoom;
  fullscreen?: TopologyGraphFullscreen;
};

export function TopologyGraphToolbar({
  search,
  filters,
  actions,
  zoom,
  fullscreen,
}: TopologyGraphToolbarProps) {
  const { t } = useI18n();
  return (
    <div className={styles.graphToolbar} data-topology-toolbar="true">
      {search ? (
        <label className={styles.graphSearch}>
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">{search.label}</span>
          <input
            type="search"
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            placeholder={search.placeholder}
          />
        </label>
      ) : null}
      {filters ? <div className={styles.graphFilters}>{filters}</div> : null}
      <div className={styles.graphToolbarSpacer} />
      {actions}
      {zoom || fullscreen ? (
        <div className={styles.graphControls} role="group" aria-label={t('topology_canvas_controls')}>
          {zoom ? (
            <>
              <button
                type="button"
                data-action="zoom-out"
                onClick={zoom.onOut}
                disabled={zoom.value <= zoom.min}
                aria-label={t('topology_zoom_out')}
                title={t('topology_zoom_out')}
              >
                <Minus size={15} aria-hidden="true" />
              </button>
              <span aria-live="polite">{Math.round(zoom.value * 100)}%</span>
              <button
                type="button"
                data-action="zoom-in"
                onClick={zoom.onIn}
                disabled={zoom.value >= zoom.max}
                aria-label={t('topology_zoom_in')}
                title={t('topology_zoom_in')}
              >
                <ZoomIn size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                data-action="fit"
                onClick={zoom.onFit}
                aria-label={t('topology_fit_view')}
                title={t('topology_fit_view')}
              >
                <Scan size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                data-action="reset"
                onClick={zoom.onReset}
                aria-label={t('topology_reset_view')}
                title={t('topology_reset_view')}
              >
                <RotateCcw size={15} aria-hidden="true" />
              </button>
            </>
          ) : null}
          {fullscreen ? (
            <button
              type="button"
              data-action="fullscreen"
              onClick={fullscreen.onToggle}
              aria-label={t(fullscreen.active ? 'topology_exit_fullscreen' : 'topology_fullscreen')}
              title={t(fullscreen.active ? 'topology_exit_fullscreen' : 'topology_fullscreen')}
            >
              {fullscreen.active
                ? <Minimize size={15} aria-hidden="true" />
                : <Expand size={15} aria-hidden="true" />}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default TopologyGraphToolbar;
