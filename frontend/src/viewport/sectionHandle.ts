// The section gizmo's pick identities. They ride the existing featureHandle
// layer like an edit handle, so the only thing each needs is a stable key; the
// arrow's format matches `featureHandleKey` (kept here so importing the key
// does not pull the picking pipeline into a pure test). The rings carry their
// own canonical `section:` keys: they are two distinct grab targets, not
// feature fields.
export const SECTION_HANDLE_FEATURE_ID = '__section__'
export const SECTION_HANDLE_FIELD = 'offset'
export const SECTION_HANDLE_KEY = `fhandle:${SECTION_HANDLE_FEATURE_ID}:${SECTION_HANDLE_FIELD}`

// Pitch turns the plane about its in-plane `u`, yaw about the pitched `v`.
// There is no roll key: spinning a plane about its own normal does not change
// the cut.
export const SECTION_PITCH_RING_KEY = 'section:ring:pitch'
export const SECTION_YAW_RING_KEY = 'section:ring:yaw'
