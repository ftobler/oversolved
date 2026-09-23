// The in-memory File System Access directory is both the single-file library's
// real bookkeeping backend and the base every directory-store test runs on, so
// its write/abort atomicity and NotFound semantics are load-bearing: a fake
// that was laxer than this would let the store lean on behaviour real Chromium
// does not have.
import { describe, it, expect } from 'vitest'
import { MemoryDirectory, fileFrom, toBytes } from './memoryDirectory'

const decoder = new TextDecoder()

async function writeFile(dir: MemoryDirectory, name: string, text: string): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  await writable.write(text)
  await writable.close()
}

async function readText(dir: MemoryDirectory, name: string): Promise<string> {
  const handle = await dir.getFileHandle(name)
  return (await handle.getFile()).text()
}

describe('MemoryDirectory', () => {
  it('a write swaps in only at close, so a read mid-write sees the old bytes', async () => {
    const dir = new MemoryDirectory('root')
    await writeFile(dir, 'a.txt', 'old')

    const handle = await dir.getFileHandle('a.txt')
    const writable = await handle.createWritable()
    await writable.write('new')
    expect(await readText(dir, 'a.txt')).toBe('old')

    await writable.close()
    expect(await readText(dir, 'a.txt')).toBe('new')
  })

  it('abort discards the swap buffer and leaves the previous contents standing', async () => {
    const dir = new MemoryDirectory('root')
    await writeFile(dir, 'a.txt', 'first')

    const handle = await dir.getFileHandle('a.txt')
    const writable = await handle.createWritable()
    await writable.write('second')
    await writable.abort()

    expect(await readText(dir, 'a.txt')).toBe('first')
  })

  it('getFileHandle rejects NotFoundError unless create is asked for', async () => {
    const dir = new MemoryDirectory('root')
    await expect(dir.getFileHandle('missing.txt')).rejects.toHaveProperty('name', 'NotFoundError')
    await expect(dir.getFileHandle('missing.txt', { create: true })).resolves.toBeTruthy()
  })

  it('removeEntry drops a file or a directory and rejects a missing name', async () => {
    const dir = new MemoryDirectory('root')
    await writeFile(dir, 'a.txt', 'x')
    await dir.getDirectoryHandle('sub', { create: true })

    await expect(dir.removeEntry('a.txt')).resolves.toBeUndefined()
    await expect(dir.removeEntry('sub')).resolves.toBeUndefined()
    await expect(dir.removeEntry('gone')).rejects.toHaveProperty('name', 'NotFoundError')
  })

  it('values yields the files then the directories', async () => {
    const dir = new MemoryDirectory('root')
    await writeFile(dir, 'a.txt', 'x')
    await dir.getDirectoryHandle('sub', { create: true })

    const names: string[] = []
    for await (const handle of dir.values()) names.push(handle.name)
    expect(names).toEqual(['a.txt', 'sub'])
  })

  it('a subclass keeps its write hook on created subdirectories', async () => {
    class Counting extends MemoryDirectory {
      writes = 0
      protected override beforeWrite(): void { this.writes += 1 }
      protected override makeChild(name: string): MemoryDirectory { return new Counting(name) }
    }
    const root = new Counting('root')
    const child = await root.getDirectoryHandle('sub', { create: true }) as unknown as Counting

    await writeFile(child, 'a.txt', 'x')
    expect(child.writes).toBe(1)
  })

  it('fileFrom reports the wrapped bytes, size and modification time', async () => {
    const bytes = new TextEncoder().encode('hello')
    const file = fileFrom({ bytes, mtime: 1234 }, 'a.txt')

    expect(file.name).toBe('a.txt')
    expect(file.size).toBe(5)
    expect(file.lastModified).toBe(1234)
    expect(await file.text()).toBe('hello')
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([104, 101, 108, 108, 111])
  })

  it('toBytes normalizes a string, a view and a bare buffer', async () => {
    expect(decoder.decode(await toBytes('hi'))).toBe('hi')
    expect(await toBytes(new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]))
    expect(await toBytes(new Uint8Array([3, 4]).buffer)).toEqual(new Uint8Array([3, 4]))
  })

  it('toBytes drains a Blob-shaped payload through arrayBuffer', async () => {
    // jsdom's Blob implements neither text() nor arrayBuffer(), and this module is
    // written to the real browser shape, so the branch is driven by the smallest
    // object that offers the one method it reads.
    const source = new TextEncoder().encode('blobbed')
    const blobLike = { arrayBuffer: async () => source.slice().buffer }
    // Compare element-wise: jsdom's TextEncoder hands back a Uint8Array from
    // another realm, which toEqual treats as a different type.
    expect(Array.from(await toBytes(blobLike as unknown as Blob))).toEqual(Array.from(source))
  })
})
