/*
 * Hierarchy rail for the template editor.
 *
 * A template nests three levels (slice -> PDN session -> PCC rule) and every
 * level renders as its own card, so the form is tall enough that an operator
 * cannot see the shape of what they are editing. This rail shows the shape and
 * jumps to any node; it reports only what the draft already contains.
 */
import { useI18n } from '../../../providers/I18nProvider';
import { typeLabel } from '../../subscribers/components/subscriber/utils';
import styles from '../../../styles/modules/profile.module.css';

type SessionNode = { name?: string; type?: number; pcc_rule?: unknown[] };
type SliceNode = { sst?: number; sd?: string; session_list?: SessionNode[] };

type Translate = (key: string, values?: Record<string, string | number>) => string;

type Entry = { id: string; depth: number; label: string; hint: string };

function buildEntries(slices: SliceNode[], t: Translate): Entry[] {
  const entries: Entry[] = [];
  slices.forEach((slice, sliceIndex) => {
    const sliceId = `slice-card-${sliceIndex}`;
    const sessions = Array.isArray(slice.session_list) ? slice.session_list : [];
    const sd = typeof slice.sd === 'string' && slice.sd !== '' && slice.sd !== '000000' ? ` / SD ${slice.sd}` : '';
    entries.push({
      id: sliceId,
      depth: 0,
      label: `SST ${slice.sst ?? '—'}${sd}`,
      hint: t('prof_content_sessions', { count: sessions.length }),
    });
    sessions.forEach((session, sessionIndex) => {
      const sessionId = `${sliceId}-session-${sessionIndex}`;
      const rules = Array.isArray(session.pcc_rule) ? session.pcc_rule.length : 0;
      entries.push({
        id: sessionId,
        depth: 1,
        label: session.name || t('prof_rail_unnamed_session', { index: sessionIndex + 1 }),
        hint: `${typeLabel(session.type ?? 0)} · ${t('prof_content_pcc', { count: rules })}`,
      });
      for (let ruleIndex = 0; ruleIndex < rules; ruleIndex += 1) {
        entries.push({
          id: `${sessionId}-rule-${ruleIndex}`,
          depth: 2,
          label: t('slice_rule_idx', { idx: ruleIndex + 1 }),
          hint: '',
        });
      }
    });
  });
  return entries;
}

export default function ProfileHierarchyRail({ slices, onJump }: {
  slices: unknown[];
  onJump: (id: string) => void;
}) {
  const { t } = useI18n();
  const entries = buildEntries(Array.isArray(slices) ? slices as SliceNode[] : [], t);
  if (entries.length === 0) return null;

  return (
    <nav className={styles.profileRail} aria-label={t('prof_rail_title')}>
      <span className={styles.profileRailCaption}>{t('prof_rail_title')}</span>
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={`${styles.profileRailItem} ${entry.depth === 2 ? styles.profileRailDepth2 : styles.profileRailDepth1}`}
          onClick={() => onJump(entry.id)}
        >
          <span className={styles.profileRailLabel}>{entry.label}</span>
          {entry.hint ? <span className={styles.profileRailHint}>{entry.hint}</span> : null}
        </button>
      ))}
    </nav>
  );
}
