// The section arrow's pick identity. It rides the existing featureHandle layer
// like an edit handle, so the only thing it needs is a stable key; the format
// matches `featureHandleKey` (kept here so importing the key does not pull the
// picking pipeline into a pure test).
export const SECTION_HANDLE_FEATURE_ID = '__section__'
export const SECTION_HANDLE_FIELD = 'offset'
export const SECTION_HANDLE_KEY = `fhandle:${SECTION_HANDLE_FEATURE_ID}:${SECTION_HANDLE_FIELD}`
