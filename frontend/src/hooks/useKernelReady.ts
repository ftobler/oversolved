import { useSyncExternalStore } from 'react'
import { getKernelReadySnapshot, subscribeKernelReady } from '@/kernel/worker/kernelReady'

/** React binding for the kernel readiness signal owned by the kernel. */
export function useKernelReady(): boolean {
  return useSyncExternalStore(subscribeKernelReady, getKernelReadySnapshot, getKernelReadySnapshot)
}
