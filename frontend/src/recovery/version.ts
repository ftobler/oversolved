// The build identity a crash report carries. A release stamps VITE_APP_VERSION
// at build time; an unstamped build reports its mode instead, so two reports
// from different builds at least say how they differ.
export const APP_VERSION: string =
  (import.meta.env.VITE_APP_VERSION as string | undefined) ?? import.meta.env.MODE
