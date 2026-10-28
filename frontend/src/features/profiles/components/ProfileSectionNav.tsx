import styles from '../../../styles/modules/profile.module.css';

/*
 * Section jump bar for the template workspace.
 *
 * The page is one long column, so the bar gives every section an address. It
 * jumps only: it never claims to know which section is currently on screen.
 */
export type ProfileSectionAnchor = { id: string; label: string };

export default function ProfileSectionNav({ sections, label, onJump }: {
  sections: ProfileSectionAnchor[];
  label: string;
  onJump: (id: string) => void;
}) {
  return (
    <nav className={styles.profileSectionNav} aria-label={label}>
      {sections.map((section) => (
        <button
          key={section.id}
          type="button"
          className={`btn btn-outline ${styles.profileSectionNavBtn}`}
          onClick={() => onJump(section.id)}
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}
