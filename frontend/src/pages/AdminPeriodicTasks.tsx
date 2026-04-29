import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import './AdminPeriodicTasks.css'

interface PeriodicTask {
  id: number
  name: string
  task_key: string
  description: string
  schedule: string
  enabled: boolean
  last_run_at: string | null
  last_run_duration_ms: number | null
  last_run_status: string | null
  last_run_error: string | null
  next_run_at: string | null
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
      const response = await fetch('/api/admin/periodic-tasks')
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to fetch tasks')
      }
      const data = await response.json()
      setTasks(data.tasks || [])
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const handleToggle = async (taskKey: string, enabled: boolean) => {
    try {
      const response = await fetch(`/api/admin/periodic-tasks/${taskKey}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to update task')
      }
      fetchTasks()
    } catch (e) {
      setError(String(e))
    }
  }

  const handleForceRun = async (taskKey: string) => {
    setRunningTask(taskKey)
    try {
      const response = await fetch(`/api/admin/periodic-tasks/${taskKey}/run`, {
        method: 'POST',
      })
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to run task')
      }
      fetchTasks()
    } catch (e) {
      setError(String(e))
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

  const formatDuration = (ms: number | null) => {
    if (ms === null) return ''
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }

  const formatSchedule = (schedule: string) => {
    if (schedule === '0 2 * * *') return 'Daily at 2:00 AM'
    return schedule
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
          <div className="task-list">
            {tasks.map(task => (
              <div key={task.task_key} className="task-card">
                <div className="task-card-header">
                  <div className="task-card-title">
                    <span className="task-status-icon">
                      {task.enabled ? (
                        <span className="material-icons task-enabled">check_circle</span>
                      ) : (
                        <span className="material-icons task-disabled">cancel</span>
                      )}
                    </span>
                    <span>{task.name}</span>
                  </div>
                  <div className="task-card-actions">
                    <button
                      className="btn btn-tile-action"
                      onClick={() => handleToggle(task.task_key, !task.enabled)}
                      title={task.enabled ? 'Disable task' : 'Enable task'}
                    >
                      <span className="material-icons">
                        {task.enabled ? 'pause' : 'play_arrow'}
                      </span>
                    </button>
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
                  </div>
                </div>

                <div className="task-card-body">
                  <div className="task-detail">
                    <span className="task-detail-label">Schedule:</span>
                    <span>{formatSchedule(task.schedule)}</span>
                  </div>
                  <div className="task-detail">
                    <span className="task-detail-label">Status:</span>
                    <span className={task.enabled ? 'task-enabled-text' : 'task-disabled-text'}>
                      {task.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                  <div className="task-detail">
                    <span className="task-detail-label">Last Run:</span>
                    <span>{formatDate(task.last_run_at)}</span>
                  </div>
                  {task.last_run_duration_ms !== null && (
                    <div className="task-detail">
                      <span className="task-detail-label">Duration:</span>
                      <span>{formatDuration(task.last_run_duration_ms)}</span>
                    </div>
                  )}
                  {task.last_run_status && (
                    <div className="task-detail">
                      <span className="task-detail-label">Result:</span>
                      <span className={`task-result-${task.last_run_status}`}>
                        {task.last_run_status}
                      </span>
                    </div>
                  )}
                  {task.last_run_error && (
                    <div className="task-detail">
                      <span className="task-detail-label">Error:</span>
                      <span className="task-error-text">{task.last_run_error}</span>
                    </div>
                  )}
                  <div className="task-detail">
                    <span className="task-detail-label">Next Run:</span>
                    <span>{formatDate(task.next_run_at)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
