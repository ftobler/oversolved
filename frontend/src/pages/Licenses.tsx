import { useMemo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  useNotices, resolveNoticeHref, noticeSections, headingSlug, NOTICES_ROOT,
} from '@/pages/hooks/useNotices'
import '@/pages/Licenses.css'

// The licenses page renders the notices deployed in public/third_party rather
// than carrying its own copy of them. There is exactly one set of license texts
// and it is the one that ships beside the app, so a reader of the repository and
// a user of the running program are looking at the same bytes. A copy inlined
// into this component would be a second version to forget.

// The heading text, for the anchor id. Headings in these documents are plain
// prose, but markdown still hands them over as a node tree whenever one carries
// a link or a code span, so the text is gathered rather than assumed.
function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return nodeText((node as { props: { children?: ReactNode } }).props.children)
  }
  return ''
}

interface LicensesProps {
  // Which document under the notices root to render. Every notice is reachable
  // through the same renderer, so there is one page and not one per document.
  file?: string
}

export default function Licenses({ file = 'README.md' }: LicensesProps) {
  const state = useNotices(file)
  const markdown = state.status === 'ready' ? state.markdown : ''
  const sections = useMemo(() => noticeSections(markdown), [markdown])

  // The content pane is what scrolls, not the window, so the heading is brought
  // into view rather than the page being moved to it.
  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <div className="licenses-page">
      <div className="licenses-container">
        {/* No sidebar until there is a document to navigate: an empty rail
            beside a loading message is furniture, not navigation. */}
        {sections.length > 0 && (
          <nav className="licenses-nav">
            <ul>
              {sections.map(section => (
                <li key={section.id}>
                  <button className="licenses-nav-link" onClick={() => scrollTo(section.id)}>
                    {section.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <div className="licenses-content">
          {state.status === 'loading' && (
            <p className="licenses-status">Loading notices...</p>
          )}

          {/* A failure here is not cosmetic: publishing these notices is a
              condition of shipping the dependencies at all, so the page says
              where they are rather than showing an empty pane. */}
          {state.status === 'failed' && (
            <div className="licenses-status">
              <p>The third-party notices could not be loaded ({state.reason}).</p>
              <p>
                They are published as files at{' '}
                <a href={NOTICES_ROOT}>{NOTICES_ROOT}</a> and in the repository
                under <code>frontend/public/third_party/</code>.
              </p>
            </div>
          )}

          {state.status === 'ready' && (
            <article className="licenses-markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h2: ({ children, ...props }) => (
                    <h2 {...props} id={headingSlug(nodeText(children))}>{children}</h2>
                  ),
                  a: ({ href, children, ...props }) => (
                    <a
                      {...props}
                      href={resolveNoticeHref(href, file)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {children}
                    </a>
                  ),
                }}
              >
                {markdown}
              </ReactMarkdown>
            </article>
          )}
        </div>
      </div>
    </div>
  )
}
