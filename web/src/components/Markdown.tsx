import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './Markdown.module.css';

/**
 * Renders agent, Notion and PR text as React elements. Raw HTML is never interpreted (SEC-03): react-markdown
 * shows it as text, and no raw-HTML plugin is installed. `remark-gfm` adds tables, strikethrough and
 * task lists; task-list checkboxes come out disabled.
 */

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  li: ({ className, children }) => (
    <li className={className?.includes('task-list-item') ? styles.task : className}>{children}</li>
  ),
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
