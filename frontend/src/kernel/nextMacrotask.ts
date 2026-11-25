/**
 * A macrotask yield, shared by the Worker's job queue (`WorkerActor`) and the
 * abortable build driver (`buildAbortable`). Messages that arrived while the
 * thread was busy are still undelivered events; awaiting this lets them land,
 * so a newer request can flush or abort the work it obsoletes.
 *
 * MessageChannel rather than setTimeout because timers are throttled hard in
 * background tabs and a queued solve must not wait on that. The timer is only
 * the fallback for a runtime without MessageChannel.
 */
export function nextMacrotask(): Promise<void> {
  if (typeof MessageChannel === 'undefined') {
    return new Promise(resolve => { setTimeout(resolve, 0) })
  }
  return new Promise(resolve => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}
