// Shared fixtures for the split query test files. Not a test file itself, so
// vitest does not collect it.

export type Payload = Record<string, unknown>

export function makeFacePayload(bodyId: string, createdBy: string, idx: number): Payload {
  return {
    type: "flatface",
    body_id: bodyId,
    created_by: createdBy,
    face_index: idx,
    centroid: [idx, 0.0, 0.0],
    normal: [0.0, 0.0, 1.0],
  }
}
