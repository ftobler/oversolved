import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import Licenses from '@/pages/Licenses'

// The licenses page renders the deployed notices instead of carrying a copy, so
// what is worth testing is the wiring: that it asks for the published file, that
// relative links in the markdown still land on the published texts, and that a
// failure says where the notices are rather than showing an empty pane.

const MARKDOWN = [
  '# Third-party notices',
  '',
  '**This software makes use of and is based on facilities provided by the Open',
  'CASCADE Technology software.**',
  '',
  'See [the LGPL](opencascade/LICENSE-LGPL-2.1.txt) and',
  '[polyhaven](https://polyhaven.com/a/studio_kominka_02).',
  '',
  '## Open CASCADE Technology',
  '',
  '| Component | License |',
  '| --- | --- |',
  '| OpenCascade | LGPL 2.1 |',
  '',
  '## npm dependencies',
  '',
  'Reproduced in full.',
  '',
  '```',
  '## not a heading, it is in a fence',
  '```',
].join('\n')

describe('licenses page', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(MARKDOWN, { status: 200 })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the notices published with the app', async () => {
    render(<Licenses />)

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Third-party notices' })).toBeInTheDocument())
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('third_party/README.md'))
  })

  it('renders the markdown as markup rather than as text', async () => {
    render(<Licenses />)

    // A table proves remark-gfm is wired up: without it the pipes would render
    // as a paragraph of punctuation.
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
  })

  // The documents live beside the license texts and link to them by relative
  // path, so the page has to resolve those against the notices folder and not
  // against whatever route it is mounted on.
  it('resolves relative links onto the published notices', async () => {
    render(<Licenses />)

    const link = await screen.findByRole('link', { name: 'the LGPL' })
    expect(link).toHaveAttribute('href', '/third_party/opencascade/LICENSE-LGPL-2.1.txt')
  })

  it('leaves absolute links alone', async () => {
    render(<Licenses />)

    const link = await screen.findByRole('link', { name: 'polyhaven' })
    expect(link).toHaveAttribute('href', 'https://polyhaven.com/a/studio_kominka_02')
  })

  it('reads a different document when asked for one', async () => {
    render(<Licenses file="opencascade/README.md" />)

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining('third_party/opencascade/README.md')))
  })

  // The registry page next door has a sidebar for the same reason: these
  // documents are long, and the section a reader wants is usually not the first.
  describe('section sidebar', () => {
    it('lists the document\'s own headings', async () => {
      render(<Licenses />)

      await screen.findByRole('heading', { name: 'Third-party notices' })
      expect(screen.getByRole('button', { name: 'Open CASCADE Technology' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'npm dependencies' })).toBeInTheDocument()
    })

    // A fenced block can hold a line that starts with ##. Treating it as a
    // heading would put an entry in the rail that scrolls nowhere.
    it('ignores a ## inside a code fence', async () => {
      render(<Licenses />)

      await screen.findByRole('heading', { name: 'Third-party notices' })
      expect(screen.queryByRole('button', { name: /not a heading/ })).not.toBeInTheDocument()
    })

    it('scrolls the heading a nav entry names into view', async () => {
      const scrollIntoView = vi.fn()
      Element.prototype.scrollIntoView = scrollIntoView

      render(<Licenses />)
      const entry = await screen.findByRole('button', { name: 'npm dependencies' })

      // The anchor has to exist before the click can reach it, which is the
      // half of this that silently breaks if the slug ever differs between the
      // nav entry and the heading it points at.
      const heading = screen.getByRole('heading', { name: 'npm dependencies' })
      expect(heading).toHaveAttribute('id', 'npm-dependencies')

      fireEvent.click(entry)
      expect(scrollIntoView).toHaveBeenCalled()
    })

    it('shows no rail while there is no document to navigate', () => {
      vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))

      render(<Licenses />)

      expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    })

    // A heading whose text is split across inline markup arrives as a node
    // tree, so the anchor id must be derived from the gathered text. If the
    // gather drops the code span, the nav id no longer matches the rendered
    // heading and the entry scrolls nowhere.
    it('anchors a heading that carries inline markup', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('## The `foo` license\n\nbody', { status: 200 })))
      const scrollIntoView = vi.fn()
      Element.prototype.scrollIntoView = scrollIntoView

      render(<Licenses />)

      const entry = await screen.findByRole('button', { name: 'The `foo` license' })
      const heading = screen.getByRole('heading', { name: 'The foo license' })
      expect(heading).toHaveAttribute('id', 'the-foo-license')

      fireEvent.click(entry)
      expect(scrollIntoView).toHaveBeenCalled()
    })
  })

  // These notices are a condition of shipping the dependencies at all, so a
  // fetch failure must still tell the reader where to find them.
  it('points at the published files when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))

    render(<Licenses />)

    await waitFor(() =>
      expect(screen.getByText(/could not be loaded/)).toBeInTheDocument())
    expect(screen.getByText('frontend/public/third_party/')).toBeInTheDocument()
  })
})
