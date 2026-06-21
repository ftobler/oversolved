import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { DocsSource } from '@/adapters/docs'

// The docs source is mutable so each test can swap in its own fake.
const docsSource: { current: DocsSource | null } = { current: null }
vi.mock('@/adapters/backend', () => ({
  get backendBundle() {
    return { docs: docsSource.current }
  },
}))

import Documentation from '@/pages/Documentation'

function makeSource(files: Record<string, string>): DocsSource {
  return {
    list: vi.fn(async () => Object.keys(files)),
    load: vi.fn(async (name: string) => {
      if (!(name in files)) throw new Error(`NOT_FOUND ${name}`)
      return files[name]
    }),
  }
}

describe('Documentation default doc', () => {
  beforeEach(() => {
    docsSource.current = null
  })

  it('lands on the first available doc when no doc is in the URL', async () => {
    // No "overview" file exists; the page must not request a hardcoded name.
    const source = makeSource({ api: '# API Reference', setup: '# Setup' })
    docsSource.current = source

    render(
      <MemoryRouter initialEntries={['/docs']}>
        <Documentation />
      </MemoryRouter>,
    )

    // The rendered markdown heading (not the nav link) proves which doc loaded.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'API Reference' })).toBeInTheDocument())
    expect(source.load).not.toHaveBeenCalledWith('overview')
    expect(source.load).toHaveBeenCalledWith('api')
  })
})
