// The name a clone gets when nobody says otherwise. Shared so the name the
// clone prompt prefills is exactly the name a store would have picked on its
// own -- confirming the prompt unchanged must be a no-op on the outcome.
export function suggestedCloneName(sourceName: string): string {
  return `${sourceName} (Clone)`
}
