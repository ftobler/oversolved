import { useCallback } from 'react'
import type { PartDoc, BuildResponse } from '@/types/cad'
import { getCachedBuildResponse, cacheBuildResponse, cacheGeometry } from '@/utils/buildCache'
import type { GeometryHeader } from '@/utils/geometryUnpack'

export function useGeometryCache(uuid: string | undefined) {
  const getCached = useCallback(
    (doc: PartDoc, rollbackPosition: number, pickBoundary: number | null) => {
      if (!uuid) return null
      return getCachedBuildResponse(uuid, doc, rollbackPosition, pickBoundary)
    },
    [uuid],
  )

  const cacheResponse = useCallback(
    (doc: PartDoc, rollbackPosition: number, pickBoundary: number | null, response: BuildResponse) => {
      if (!uuid) return
      return cacheBuildResponse(uuid, doc, rollbackPosition, pickBoundary, response)
    },
    [uuid],
  )

  const cacheGeo = useCallback(
    (doc: PartDoc, rollbackPosition: number, pickBoundary: number | null, geometry: { header: GeometryHeader; buffer: ArrayBuffer; jsonHeaderLen: number }) => {
      if (!uuid) return
      cacheGeometry(uuid, doc, rollbackPosition, pickBoundary, geometry)
    },
    [uuid],
  )

  return {
    getCachedBuildResponse: getCached,
    cacheBuildResponse: cacheResponse,
    cacheGeometry: cacheGeo,
  }
}
