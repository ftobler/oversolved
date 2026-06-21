import { useEffect } from 'react'
import type { NavigateFunction } from 'react-router-dom'

export function useAdminGuard(
  user: { is_admin?: boolean } | null,
  navigate: NavigateFunction,
): boolean {
  const isAdmin = user?.is_admin ?? false
  useEffect(() => {
    if (!isAdmin) navigate('/documents')
  }, [isAdmin, navigate])
  return isAdmin
}
