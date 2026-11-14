import { Fragment } from 'react';
import styles from '../../../styles/modules/knowledge.module.css';

/** Renders text with case-insensitive matches of query wrapped in a highlight. */
export function HighlightText({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'ig'));
  const lower = needle.toLowerCase();
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === lower ? (
          <mark key={index} className={styles.highlight}>{part}</mark>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}