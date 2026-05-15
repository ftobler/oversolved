import { useSolverStore } from '@/stores/solverStore'

export function useSolverStatus(): boolean {
  return useSolverStore(s => s.isSolving)
}
