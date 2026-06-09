import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { http, HttpError } from '@/utils/core/httpClient'
import '@/pages/AdminPeriodicTasks.css'

interface PeriodicTask {
  id: number
  task_key: string
  last_run_at: string | null
  last_run_status: string | null
}

export default function AdminPeriodicTasks() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [tasks, setTasks] = useState<PeriodicTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [runningTask, setRunningTask] = useState<string | null>(null)

  useEffect(() => {
    if (!user?.is_admin) {
      navigate('/documents')
      return
    }
    fetchTasks()
  }, [user, navigate])

  const fetchTasks = async () => {
    setLoading(true)
    try {
      const data = await http.getJson<{ tasks: PeriodicTask[] }>('/api/admin/periodic-tasks')
      setTasks(data.tasks || [])
      setError(null)
    } catch (e) {
      if (e instanceof HttpError) {
        const parsed = JSON.parse(e.body || '{}') as { error?: string }
        setError(parsed.error || 'Failed to fetch tasks')
      } else {
        setError(String(e))
      }
    } finally {
      setLoading(false)
    }
  }

  const handleForceRun = async (taskKey: string) => {
    setRunningTask(taskKey)
    try {
      await http.postJson(`/api/admin/periodic-tasks/${taskKey}/run`)
      fetchTasks()
    } catch (e) {
      if (e instanceof HttpError) {
        const parsed = JSON.parse(e.body || '{}') as { error?: string }
        setError(parsed.error || 'Failed to run task')
      } else {
        setError(String(e))
      }
    } finally {
      setRunningTask(null)
    }
  }

  const formatDate = (isoString: string | null) => {
    if (!isoString) return 'Never'
    const date = new Date(isoString)
    return date.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  }


  if (!user?.is_admin) {
    return null
  }

  return (
    <div className="admin-periodic-tasks">
      <div className="admin-periodic-tasks-container">
        {error && <p className="admin-periodic-tasks-error">{error}</p>}

        {loading ? (
          <p className="admin-periodic-tasks-status">Loading tasks...</p>
        ) : (
          <table className="setting-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Last Run</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map(task => (
                <tr key={task.task_key}>
                  <td>{task.task_key}</td>
                  <td>{formatDate(task.last_run_at)}</td>
                  <td>
                    {task.last_run_status ? (
                      <span className={`task-result-${task.last_run_status}`}>
                        {task.last_run_status}
                      </span>
                    ) : '-'}
                  </td>
                  <td>
                    <button
                      className="btn btn-tile-action"
                      onClick={() => handleForceRun(task.task_key)}
                      disabled={runningTask === task.task_key}
                      title="Run now"
                    >
                      <span className="material-icons">
                        {runningTask === task.task_key ? 'hourglass_empty' : 'play_arrow'}
                      </span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
