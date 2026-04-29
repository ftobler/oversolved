import { useEffect, useState, useCallback } from 'react'

export interface Org {
  id: number
  slug: string
  display_name: string
  description: string | null
  is_personal: boolean
  owner_id: number
  role: string
  created_at: string
  updated_at: string
}

export interface OrgMember {
  user_id: number
  username: string
  role: string
  joined_at: string
}

export function useOrganizations() {
  const [orgs, setOrgs] = useState<Org[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(() => {
    setLoading(true)
    fetch('/api/users/me/orgs')
      .then(r => (r.ok ? r.json() : { orgs: [] }))
      .then(data => {
        setOrgs(data.orgs ?? [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    fetch('/api/users/me/orgs')
      .then(r => (r.ok ? r.json() : { orgs: [] }))
      .then(data => {
        setOrgs(data.orgs ?? [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  return { orgs, loading, reload }
}
