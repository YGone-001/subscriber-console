import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isKnowledgeImageUrl } from '../knowledge-format';
import styles from '../../../styles/modules/knowledge.module.css';

const SAFE_LINK = /^(https?:\/\/|mailto:|\/|#)/i;

/**
 * Secure Markdown renderer for knowledge base solution bodies.
 *
 * Raw HTML is never rendered (react-markdown skips it without a rehype-raw
 * plugin), link targets are restricted to http(s)/mailto/in-site paths, and
 * images are limited to knowledge attachments served by the backend. This
 * keeps XSS and external tracking out of authored content.
 */
export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const target = typeof href === 'string' ? href : '';
            if (!SAFE_LINK.test(target)) return <span>{children}</span>;
            return (
              <a href={target} target={target.startsWith('http') ? '_blank' : undefined} rel="noreferrer noopener">
                {children}
              </a>
            );
          },
          img: ({ src, alt }) => {
            const target = typeof src === 'string' ? src : '';
            if (!isKnowledgeImageUrl(target)) return null;
            return <img src={target} alt={typeof alt === 'string' ? alt : ''} loading="lazy" />;
          },
          table: ({ children }) => (
            <div className={styles.tableWrap}>
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {content ?? ''}
      </ReactMarkdown>
    </div>
  );
}
