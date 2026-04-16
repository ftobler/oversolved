# Feature Rebuild Optimization

## Problem Statement

Currently, the backend solves ALL features regardless of:
1. **Rollback position** - User has set a visual rollback bar, but backend ignores it
2. **Visibility** - User has toggled feature visibility, but backend ignores it

This wastes CPU time solving features that aren't needed for the current viewport.

## Goals

1. Backend receives rollback position and visibility from frontend
2. Backend only solves features needed for the current view
3. Partial rebuilds leverage cached result layers
4. Cache has configurable TTL (default: 5 minutes)

## Current Architecture

### Frontend
- `rollbackPosition: number | null` - how many features to render
- `visibleFeatures: Set<string>` - which feature IDs are visible

### Backend
- `_build_state_cache: dict` keyed by document ID (app.py:323)
- `FeatureCheckpoint` stores: spec, result, repo_snapshot, body_store_snapshot
- `build()` uses `_find_first_dirty()` for partial rebuilds
- No TTL - cache lives until server restart

## Proposed Changes

### 1. API Contract Change

**Request payload adds:**
```typescript
interface SolveRequest {
  id: string
  features: Feature[]
  rollbackPosition: number | null  // NEW: index of rollback bar
  visibleFeatureIds: string[]     // NEW: visible feature IDs
}
```

**Response unchanged** (solver returns same format)

### 2. Frontend Changes

**File: `frontend/src/hooks/usePartDoc.ts`**

Send `rollbackPosition` and `visibleFeatures` in solve request:
```typescript
const response = await fetch("/api/solve", {
  method: "POST",
  body: JSON.stringify({
    id: doc.id,
    features: doc.features,
    rollbackPosition,      // NEW
    visibleFeatureIds: [...visibleFeatures],  // NEW
  })
})
```

### 3. Backend Changes

#### 3a. Filter features before solving

**File: `oversolved/builder.py`**

```python
def build(
    spec: dict,
    prev_state: BuildState | None = None,
    rollback_position: int | None = None,
    visible_ids: set[str] | None = None,
) -> dict:
    features: list[dict] = spec.get("features", [])

    # Apply rollback: only solve up to rollback position
    if rollback_position is not None:
        features = features[:rollback_position]

    # Apply visibility: only solve visible features + their dependencies
    if visible_ids is not None:
        features = _filter_visible_features(features, visible_ids)

    # ... existing partial rebuild logic ...
```

#### 3b. Dependency-aware visibility filtering

Features required by visible features must also be solved (e.g., visible extrusion needs its sketch).

```python
def _filter_visible_features(features: list[dict], visible_ids: set[str]) -> list[dict]:
    """Return features needed to compute visible_ids, including dependencies."""
    needed = set()
    for fid in visible_ids:
        needed.update(_get_dependencies(fid, features))
    needed.update(visible_ids)
    return [f for f in features if f.get("id") in needed]
```

#### 3c. TTL-based cache

**File: `oversolved/app.py`**

```python
from dataclasses import dataclass, field
from datetime import datetime, timedelta
import threading

CACHE_TTL_SECONDS = 300  # 5 minutes, configurable

@dataclass
class CacheEntry:
    build_state: BuildState
    timestamp: datetime

_build_state_cache: dict[str, CacheEntry] = {}
_cache_lock = threading.Lock()

def _get_cached_state(doc_id: str) -> BuildState | None:
    with _cache_lock:
        entry = _build_state_cache.get(doc_id)
        if entry is None:
            return None
        if datetime.now() - entry.timestamp > timedelta(seconds=CACHE_TTL_SECONDS):
            del _build_state_cache[doc_id]
            return None
        return entry.build_state

def _set_cached_state(doc_id: str, state: BuildState) -> None:
    with _cache_lock:
        _build_state_cache[doc_id] = CacheEntry(build_state=state, timestamp=datetime.now())
```

### 4. Thread Safety

Waitress uses multiple threads. The existing `_build_state_cache` is a plain dict without synchronization.

**Options:**

A) **Global lock** (simplest, sufficient for moderate load)
   - Add `threading.Lock()` around all cache access
   - Low contention since solve requests are brief

B) **Per-doc locks** (better for high concurrency)
   - Dict of locks keyed by doc_id
   - More complex but less contention

C) **Router layer / sticky sessions** (user mentioned)
   - Load balancer routes same session to same worker
   - Out of scope for now per user: "not concerned about scaling"

**Recommendation:** Option A - global lock for now. Revisit if profiling shows lock contention.

### 5. Session Routing (Future Consideration)

User mentioned: "a session should probably route to the same instance of python"

This is only needed if we want to:
- Share state across Python workers
- Have longer-lived caches than single-worker lifetime

**Current approach:** Each worker has its own cache. Cache is lost when worker dies, but:
- Users typically stay on same browser tab
- Rebuild within 5 min TTL happens on same worker

**If needed later:** Add sticky session config to Waitress or nginx.

## Implementation Order

1. **API contract** - Update frontend to send rollback/visibility
2. **Backend filtering** - builder.py filters features
3. **TTL cache** - Add expiration to cache
4. **Thread safety** - Add lock to cache access
5. **Test** - Verify partial rebuild works with new params

## Open Questions

1. **Dependency detection**: How do we get `_get_dependencies()`?
   - Option A: Parse feature `sketchId`/`profileId` references
   - Option B: Run solver with just visible IDs and let it fail, then add deps

2. **Cache key**: Should include rollback/visibility in cache key?
   - Pro: Different rollback positions get separate caches
   - Con: More cache entries, less reuse

3. **Visible but rolled-back**: If a feature is visible but beyond rollback position?
   - Current thinking: Rollback takes precedence (user wants to see earlier state)

## Files to Modify

| File | Changes |
|------|---------|
| `frontend/src/hooks/usePartDoc.ts` | Send new params in solve request |
| `oversolved/builder.py` | Filter by rollback/visibility |
| `oversolved/app.py` | TTL cache, thread safety |
| `oversolved/types3d.py` | Add request type hints |
