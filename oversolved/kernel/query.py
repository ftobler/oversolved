from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Callable, TypeAlias, TYPE_CHECKING
import contextvars
import re
import secrets
from oversolved.kernel.solver_constants import _BUILTIN_PLANES

# Feature currently being solved, set by the build loop. Read by the ancestry
# resolver to reject candidates owned by features ordered after this one.
_current_feature_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "current_feature_id", default=None
)

if TYPE_CHECKING:
    from oversolved.kernel.query_heuristics import HeuristicConfig, Outcome

__all__ = [
    "AmbiguousQueryError",
    "LocalQuery",
    "AbsoluteQuery",
    "AncestryQuery",
    "QueryType",
    "Repository",
    "parse_query",
    "emit_wire",
    "ref",
    "index_ref",
    "body_id_of",
    "local",
    "absolute",
    "ancestry",
    "make_ancestry_query",
    "_parse_ancestry",
    "_init_global_repo",
    "_evict_ancestry_and_register",
    "_is_geom_hash_id",
    "_current_feature_id",
]

QueryType: TypeAlias = "LocalQuery | AbsoluteQuery | AncestryQuery"


class AmbiguousQueryError(Exception):
    """Raised when an ancestry query matches more than one element."""


@dataclass(frozen=True)
class LocalQuery:
    """$<eid> or $<eid><sub> -- element within the current feature."""
    eid: str
    sub: str = ""

    @staticmethod
    def from_string(s: str) -> "LocalQuery":
        body = s[1:]
        for pt in ("start", "end", "center", "xy"):
            if body.endswith(pt) and len(body) > len(pt):
                rest = body[: -len(pt)]
                if rest and not rest[-1].isalpha():
                    return LocalQuery(eid=rest, sub=pt)
        return LocalQuery(eid=body)


@dataclass(frozen=True)
class AbsoluteQuery:
    """@<feat> or @<feat>/<eid> or @<feat>/<eid>/<sub>."""
    feature_id: str
    eid: str = ""
    sub: str = ""

    @staticmethod
    def feature_plane(feature_id: str) -> "AbsoluteQuery":
        return AbsoluteQuery(feature_id=feature_id)

    @staticmethod
    def element(feature_id: str, eid: str, sub: str = "") -> "AbsoluteQuery":
        return AbsoluteQuery(feature_id=feature_id, eid=eid, sub=sub)


@dataclass(frozen=True)
class AncestryQuery:
    """?A,B;<id0><id1>...[:<type>][@<classifier>]"""
    ancestor_ids: tuple[str, ...]
    type_restriction: str | None = None
    classifier: str | None = None

    @staticmethod
    def from_parts(
        ids: list[str],
        type_restriction: str | None = None,
        classifier: str | None = None,
    ) -> "AncestryQuery":
        return AncestryQuery(
            ancestor_ids=tuple(ids),
            type_restriction=type_restriction,
            classifier=classifier,
        )


@dataclass(eq=True, frozen=True)
class QueryNode:
    """Recursive ancestral lineage node.

    Each node represents one ancestor in the lineage chain. The flat
    frozenset tag-set for the existing Repository.ancestral resolver
    can be derived via tag_set() so nothing regresses during the
    transition from flat-bag to recursive queries.
    """
    id: str
    parents: tuple["QueryNode", ...] = ()
    leaf_geom: dict[str, Any] | None = None

    def tag_set(self) -> frozenset[str]:
        """Flatten the tree to a flat tag set."""
        tags = {self.id}
        for p in self.parents:
            tags |= p.tag_set()
        return frozenset(tags)

    def ancestor_ids(self) -> tuple[str, ...]:
        """Sorted tuple of all ancestor IDs (for flat AncestryQuery compat)."""
        return tuple(sorted(self.tag_set()))


_QUERY_TYPES = (LocalQuery, AbsoluteQuery, AncestryQuery)


def parse_query(s: str) -> QueryType:
    """Central parse entry-point -- replaces every inline startswith check."""
    if s.startswith("$"):
        return LocalQuery.from_string(s)
    if s.startswith("@"):
        return _parse_absolute(s)
    if s.startswith("?"):
        return _parse_ancestry_obj(s)
    raise ValueError(f"Unrecognized query string: {s!r}")


def emit_wire(q: QueryType) -> str:
    """Serialize a typed query to its wire-format string.

    Call this ONLY at true serialization boundaries:
      - writing into a YAML document
      - building a repository key string
      - constructing an ancestry id list for AncestryQuery.from_parts

    Do NOT call to compare queries (use == on frozen dataclasses).
    Do NOT call to inspect kind (use isinstance or match).
    If you find yourself calling this just to pass the result somewhere
    else in Python, keep the Query object instead.
    """
    match q:
        case LocalQuery(eid, sub):
            return "$" + eid + sub
        case AbsoluteQuery(feature_id, eid, sub):
            if eid:
                return "@" + feature_id + "/" + eid + (("/" + sub) if sub else "")
            return "@" + feature_id
        case AncestryQuery(ancestor_ids, type_restriction, classifier):
            lengths = ",".join(format(len(i), "x") for i in ancestor_ids)
            body = "?" + lengths + ";" + "".join(ancestor_ids)
            if type_restriction:
                body += ":" + type_restriction
            if classifier:
                body += "@" + classifier
            return body
    raise TypeError(f"Unknown query type: {type(q)!r}")  # type: ignore[return]


def _parse_absolute(s: str) -> AbsoluteQuery:
    body = s[1:]  # strip "@"
    parts = body.split("/")
    if len(parts) == 1:
        return AbsoluteQuery(feature_id=parts[0])
    if len(parts) == 2:
        return AbsoluteQuery(feature_id=parts[0], eid=parts[1])
    if len(parts) == 3:
        return AbsoluteQuery(feature_id=parts[0], eid=parts[1], sub=parts[2])
    raise ValueError(f"Unrecognized absolute query format: {s!r}")


def _parse_ancestry_obj(s: str) -> AncestryQuery:
    ids, type_restriction = _parse_ancestry(s)
    classifier: str | None = None
    if type_restriction and "@" in type_restriction:
        type_restriction, classifier = type_restriction.split("@", 1)
    return AncestryQuery(
        ancestor_ids=tuple(ids),
        type_restriction=type_restriction or None,
        classifier=classifier,
    )


def ref(element_id: str) -> str:
    """Mint an ancestor token referencing a feature, body, or geom-hash: '@<id>'.

    The single place the '@'-prefix convention for ancestor tokens lives. Pass the
    bare id (feature id, body id, or a geom hash already prefixed with
    gedge_/gface_/gvertex_); the '@' is added here. Consumers must not hand-build
    '@'-prefixed token strings.
    """
    return "@" + element_id


def index_ref(owner_id: str, kind: str, idx: int) -> str:
    """LEGACY ordinal ancestor token: '@<owner><kind><idx>' (concatenated form).

    Positional / OCC-iteration-order identity. Forbidden long-term -- see
    feature/drop-legacy-edge-queries.md. Isolated here so every emission can be
    removed in one place once recursive lineage lands. Do NOT add new callers.
    """
    return f"@{owner_id}{kind}{idx}"


_BODY_AT_RE = re.compile(r"@(body_[^@:;,]+)")


def body_id_of(query_str: str, body_store: dict[str, Any] | None = None) -> str | None:
    """Return the body id ('body_...') a query refers to, or None.

    Engine-side introspection so consumers never regex query strings themselves.
    Handles the ancestry form ('...@body_x...'). When several '@body_' tokens
    are present (an element id like '@body_ex1edge0' plus the real body
    '@body_ex1'), a candidate that exists in body_store is preferred.
    """
    candidates = _BODY_AT_RE.findall(query_str)
    if body_store is not None:
        for c in candidates:
            if c in body_store:
                return c
    return candidates[0] if candidates else None


def build_query(element_id: str, parent_map: dict[str, list[str]]) -> QueryNode:
    """Recursively compose a QueryNode from a parent map.

    parent_map[child_id] = [parent_id, ...] gives the immediate parents.
    Root nodes (no parents) are terminal QueryNodes.
    """
    pid = ref(element_id) if not element_id.startswith("@") else element_id
    parents = parent_map.get(element_id, [])
    return QueryNode(
        id=pid,
        parents=tuple(build_query(p, parent_map) for p in parents),
    )


def resolve_query(
    node: QueryNode,
    repo: "Repository",
    cfg: HeuristicConfig | None = None,
) -> tuple[Outcome, Any | None]:
    """Walk a recursive query tree against a Repository.

    Tier 1: exact ancestor-set match via the flat tag_set derived from the tree.
    Tier 2: partial-branch heuristic — score each candidate by ancestor-id
    overlap and pick the best (or mark ambiguous/unresolved).
    """
    from oversolved.kernel.query_heuristics import (
        HeuristicConfig, DEFAULT_HEURISTIC_CONFIG,
        Outcome, score_overlap, pick_best,
    )
    if cfg is None:
        cfg = DEFAULT_HEURISTIC_CONFIG

    tag_set = node.tag_set()
    if not tag_set:
        return Outcome.UNRESOLVED, None

    # Tier 1 — exact match via the existing flat resolver
    exact_hits: list[str] = []
    for key, eids in repo.ancestral.items():
        if tag_set.issubset(key):
            exact_hits.extend(eids)
    if exact_hits:
        # deduplicate while preserving order
        seen: set[str] = set()
        unique: list[str] = []
        for eid in exact_hits:
            if eid not in seen:
                seen.add(eid)
                unique.append(eid)
        if len(unique) == 1:
            return Outcome.RESOLVED, repo.elements.get(unique[0])
        # multiple exact matches — use pick_best to decide
        scores: list[tuple[str, float]] = []
        for eid in unique:
            elem_tags: frozenset[str] = frozenset()
            for k, elist in repo.ancestral.items():
                if eid in elist:
                    elem_tags = k
                    break
            overlap = score_overlap(tag_set, elem_tags)
            scores.append((eid, overlap))
        outcome, winner = pick_best([(repo.elements.get(eid), s) for (eid, s) in scores], cfg)
        return outcome, winner

    # Tier 2 — partial branch heuristic
    all_scores: list[tuple[Any, float]] = []
    for key, eids in repo.ancestral.items():
        overlap = score_overlap(tag_set, key)
        if overlap < cfg.overlap_threshold:
            continue
        for eid in eids:
            all_scores.append((repo.elements.get(eid), overlap))

    return pick_best(all_scores, cfg)


def local(eid: str, sub: str = "") -> LocalQuery:
    """Construct a LocalQuery ($<eid><sub>)."""
    return LocalQuery(eid=eid, sub=sub)


def absolute(feature_id: str, eid: str = "", sub: str = "") -> AbsoluteQuery:
    """Construct an AbsoluteQuery (@<feature_id> or @<feature_id>/<eid>/<sub>)."""
    return AbsoluteQuery(feature_id=feature_id, eid=eid, sub=sub)


def ancestry(
    ids: "list[QueryType | str]",
    type_restriction: str | None = None,
    classifier: str | None = None,
) -> AncestryQuery:
    """Build an AncestryQuery from typed Query objects or raw wire strings.

    Accepts Query objects so callers never have to call emit_wire themselves
    just to pass something to this function.
    """
    wire_ids = [
        emit_wire(i) if isinstance(i, _QUERY_TYPES) else i
        for i in ids
    ]
    return AncestryQuery.from_parts(wire_ids, type_restriction, classifier)


def _parse_ancestry(query_str: str) -> tuple[list[str], str | None]:
    """Parse `?A,B;<idA><idB>` or `?A,B;<idA><idB>:<TYPE>`.
    Returns (list_of_id_strings, type_restriction_or_None).
    """
    if not query_str.startswith('?'):
        raise ValueError(f"Invalid ancestry query: {query_str!r}")
    try:
        semi = query_str.index(';')
    except ValueError:
        raise ValueError(f"ancestry query truncated: missing ';' in {query_str!r}")
    lengths_hex = query_str[1:semi]
    rest = query_str[semi + 1:]

    try:
        lengths = [int(x, 16) for x in lengths_hex.split(',')]
    except ValueError as exc:
        raise ValueError(
            f"invalid hex length field in ancestry query {query_str!r}"
        ) from exc

    ids = []
    pos = 0
    for i, length in enumerate(lengths):
        if pos + length > len(rest):
            raise ValueError(
                f"ancestry string truncated at position {pos}: "
                f"segment {i} needs {length} bytes but only {len(rest) - pos} remain"
            )
        ids.append(rest[pos:pos + length])
        pos += length

    type_restriction = None
    if pos < len(rest) and rest[pos] == ':':
        type_restriction = rest[pos + 1:]

    return ids, type_restriction


def make_ancestry_query(ids: list[str], type_restriction: str | None = None) -> str:
    """Build an ancestry query string from a list of id strings."""
    lengths = ','.join(format(len(i), 'x') for i in ids)
    s = '?' + lengths + ';' + ''.join(ids)
    if type_restriction is not None:
        s += ':' + type_restriction
    return s


# When adding a new geometry type, add it here and list any parent types.
# _validate_type_hierarchy() below raises AssertionError at import if the
# dict and the known_types set diverge.
_TYPE_HIERARCHY: dict[str, dict[str, list[str]]] = {
    'solid': {'parents': []},
    'face': {'parents': []},
    'flatface': {'parents': ['face']},
    'cylinderface': {'parents': ['face']},
    'edge': {'parents': []},
    'straightedge': {'parents': ['edge']},
    'vertex': {'parents': []},
}

_KNOWN_GEOMETRY_TYPES = {
    'solid', 'face', 'flatface', 'cylinderface',
    'edge', 'straightedge', 'vertex',
}


def _validate_type_hierarchy() -> None:
    registered = set(_TYPE_HIERARCHY.keys())
    missing = _KNOWN_GEOMETRY_TYPES - registered
    if missing:
        raise AssertionError(
            f"_TYPE_HIERARCHY is missing types: {missing}. "
            "Update _TYPE_HIERARCHY when adding new geometry types."
        )
    for type_name, meta in _TYPE_HIERARCHY.items():
        for parent in meta.get('parents', []):
            if parent not in registered:
                raise AssertionError(
                    f"_TYPE_HIERARCHY: type '{type_name}' references unknown parent '{parent}'."
                )


_validate_type_hierarchy()


def _is_subtype(actual_type: str | None, target_type: str) -> bool:
    if actual_type is None:
        return False
    if actual_type == target_type:
        return True
    return target_type in _TYPE_HIERARCHY.get(actual_type, {}).get('parents', [])


def _obj_type(obj: Any) -> str | None:
    if isinstance(obj, dict):
        return obj.get('type')
    return getattr(obj, 'type', None)


def _coerce_type(
    element: Any, target_type: str, body_store: dict[str, Any] | None, repo_elements: dict[str, Any]
) -> Any:
    """Attempt to coerce element to target_type using body_store and repo_elements.

    Downward/sibling scans are scoped to elements with the same ``created_by``
    field to prevent cross-feature body_id collisions from returning a match
    from the wrong feature.
    """
    if element is None:
        return None
    obj_type = _obj_type(element)
    if obj_type is None:
        return None
    if obj_type == target_type or _is_subtype(obj_type, target_type):
        return element
    if not isinstance(element, dict):
        return None
    body_id = element.get('body_id')
    if body_id is None:
        return None
    created_by = element.get('created_by')
    if created_by is None:
        return None
    # Upward: child -> solid
    if target_type == 'solid' and body_store is not None:
        return body_store.get(body_id)
    # Downward / sibling: scope search to same feature to prevent cross-feature collisions
    for el in repo_elements.values():
        el_type = _obj_type(el)
        if (isinstance(el, dict)
                and el.get('body_id') == body_id
                and el.get('created_by') == created_by):
            if el_type == target_type or _is_subtype(el_type, target_type):
                return el
    return None


def _is_geom_hash_id(id_str: str) -> bool:
    """Return True if id_str is a wire-format geom_hash reference (@gface_*, @gedge_*, @gvertex_*)."""
    return (
        id_str.startswith("@gface_")
        or id_str.startswith("@gedge_")
        or id_str.startswith("@gvertex_")
    )


def _feature_idx_of_element(repo: "Repository", eid: str) -> int | None:
    """Return the build-order index of the element's owning feature.

    Returns None for built-in geometry (origin, planes, reference geometry)
    that carries no owning feature -- such elements are never ordering-gated.
    """
    el = repo.elements.get(eid)
    if not isinstance(el, dict):
        return None
    owner = el.get("created_by") or el.get("sketch_id")
    if not owner:
        return None
    return repo._feature_index.get(owner)


class Repository:
    def __init__(self) -> None:
        self.elements: dict[str, Any] = {}
        # frozenset of ancestor ids -> list of element ids
        # (multiple elements can share the same ancestor set, e.g. two circle intersections)
        self.ancestral: dict[frozenset, list[str]] = {}
        # secondary hash index: geom_hash string (without "@") -> list of element ids
        # consulted only when ancestral resolution is ambiguous or empty
        self.by_geom_hash: dict[str, list[str]] = {}
        # feature_id -> position in the current build order; empty means the
        # ordering guard is inactive (e.g. a standalone solve()).
        self._feature_index: dict[str, int] = {}

    def set_feature_order(self, feature_order: list[str]) -> None:
        """Record the current feature build order for the ordering guard."""
        self._feature_index = {fid: i for i, fid in enumerate(feature_order)}

    def register(self, element_id: str, obj: Any):
        self.elements[element_id] = obj

    def register_ancestor(self, ancestors: list[str], obj: Any, geom_hash: str | None = None) -> str:
        id = secrets.token_urlsafe(9)
        key = frozenset(ancestors)
        self.ancestral.setdefault(key, []).append(id)
        self.elements[id] = obj
        if geom_hash is not None:
            self.by_geom_hash.setdefault(geom_hash, []).append(id)
        return id

    def clear_by_sketch_id(self, sketch_id: str) -> None:
        """Remove all direct elements whose payload contains the given sketch_id."""
        keys_to_remove = [
            k for k, v in self.elements.items()
            if isinstance(v, dict) and v.get("sketch_id") == sketch_id
        ]
        for k in keys_to_remove:
            del self.elements[k]

    def gc(self, active_fids: set[str]) -> None:
        """Evict ancestry entries for features not in active_fids.

        Ancestry keys that contain an @-prefixed tag are considered feature-owned.
        An entry is stale when all its feature references are absent from active_fids.
        Entries with no @-prefixed tags (e.g. built-in planes) are always kept.
        """
        stale_keys = [
            key for key in self.ancestral
            if (refs := {tag[1:] for tag in key if tag.startswith('@')})
            and not refs.intersection(active_fids)
        ]
        for key in stale_keys:
            for eid in self.ancestral.pop(key):
                self.elements.pop(eid, None)
        # Prune by_geom_hash entries whose element IDs are all evicted.
        stale_hashes = [h for h, eids in self.by_geom_hash.items() if not any(eid in self.elements for eid in eids)]
        for h in stale_hashes:
            del self.by_geom_hash[h]

    def query(
        self,
        query_str: "str | QueryType",
        context: str | None = None,
        body_store: dict[str, Any] | None = None,
        current_feature_id: str | None = None,
    ) -> Any:
        if isinstance(query_str, _QUERY_TYPES):
            return self._query_typed(query_str, context, body_store, current_feature_id)
        if not query_str:
            return None
        start = query_str[0]

        if start == '$':
            if context is None:
                return None
            return self.elements.get(context + query_str[1:])

        if start == '@':
            return self.elements.get(query_str[1:])

        if start == '?':
            q = _parse_ancestry_obj(query_str)
            return self._resolve_ancestry_ids(
                list(q.ancestor_ids), q.type_restriction, q.classifier,
                body_store, current_feature_id,
            )

        return None

    def _query_typed(
        self,
        q: QueryType,
        context: str | None,
        body_store: dict[str, Any] | None = None,
        current_feature_id: str | None = None,
    ) -> Any:
        match q:
            case LocalQuery(eid, sub):
                if context is None:
                    return None
                return self.elements.get(context + eid + sub)
            case AbsoluteQuery(feature_id, eid, sub):
                if eid:
                    key = feature_id + "/" + eid + (("/" + sub) if sub else "")
                else:
                    key = feature_id
                return self.elements.get(key)
            case AncestryQuery(ancestor_ids, type_restriction, classifier):
                return self._resolve_ancestry_ids(
                    list(ancestor_ids), type_restriction, classifier,
                    body_store, current_feature_id,
                )
        return None  # type: ignore[return-value]

    def _order_filter(self, current_feature_id: str | None) -> "Callable[[list[str]], list[str]]":
        """Build a candidate filter that rejects elements owned by features
        ordered after current_feature_id.

        The querying feature defaults to the contextvar set by the build loop.
        When no order is known (no index, or the feature is absent from it) the
        filter is the identity, preserving standalone-solve behavior.
        """
        if current_feature_id is None:
            current_feature_id = _current_feature_id.get()
        current_idx: int | None = None
        if current_feature_id is not None and self._feature_index:
            current_idx = self._feature_index.get(current_feature_id)
        if current_idx is None:
            return lambda eids: eids

        def _filter(eids: list[str]) -> list[str]:
            kept = []
            for eid in eids:
                owner_idx = _feature_idx_of_element(self, eid)
                if owner_idx is None or owner_idx <= current_idx:
                    kept.append(eid)
            return kept

        return _filter

    def _resolve_ancestry_ids(
        self,
        ids: list[str],
        type_restriction: str | None,
        classifier: str | None,
        body_store: dict[str, Any] | None = None,
        current_feature_id: str | None = None,
    ) -> Any:
        order_filter = self._order_filter(current_feature_id)

        # Separate geom_hash IDs from structural ancestor IDs.
        # Ancestral index is keyed only by structural IDs; hash is a secondary fallback.
        hash_ids = [i for i in ids if _is_geom_hash_id(i)]
        non_hash_ids = [i for i in ids if not _is_geom_hash_id(i)]

        # Tier 1: ancestral resolution with structural (non-hash) IDs.
        candidate_ids: list[str] = []
        if non_hash_ids:
            query_set = frozenset(non_hash_ids)
            for registered_key, element_ids in self.ancestral.items():
                if query_set <= registered_key:
                    candidate_ids.extend(element_ids)
        candidate_ids = order_filter(candidate_ids)

        # Apply type restriction filter.
        if type_restriction is not None and candidate_ids:
            exact_matches = [
                eid for eid in candidate_ids
                if _obj_type(self.elements.get(eid)) == type_restriction
            ]
            if exact_matches:
                candidate_ids = exact_matches
            else:
                # Coercion: no exact type match, try to resolve from candidates.
                for eid in candidate_ids:
                    element = self.elements.get(eid)
                    coerced = _coerce_type(element, type_restriction, body_store, self.elements)
                    if coerced is not None:
                        return coerced
                candidate_ids = []

        # Apply classifier filter.
        if classifier is not None and candidate_ids:
            candidate_ids = [
                eid for eid in candidate_ids
                if self.elements.get(eid, {}).get("classifier") == classifier
            ]

        # Hash narrowing: if ambiguous and a hash is present, narrow by by_geom_hash.
        if len(candidate_ids) > 1 and hash_ids:
            geom_hash_str = hash_ids[0][1:]  # strip leading '@'
            hash_set = {eid for eid in self.by_geom_hash.get(geom_hash_str, []) if eid in self.elements}
            narrowed = [eid for eid in candidate_ids if eid in hash_set]
            if narrowed:
                candidate_ids = narrowed

        # Tier 2: partial ancestral (reverse direction) -- only if unique.
        # After a feature rename or upstream edit, the query may carry ancestors
        # that were never registered.  When tier 1 (query <= key) finds nothing,
        # try the complement direction (key <= query): a registered key that is a
        # subset of the query means the core ancestors still match.
        if not candidate_ids and non_hash_ids:
            partial_candidates: list[str] = []
            for key, element_ids in self.ancestral.items():
                if key <= query_set:
                    partial_candidates.extend(element_ids)
            partial_candidates = order_filter(list(dict.fromkeys(partial_candidates)))
            if type_restriction is not None:
                partial_candidates = [
                    eid for eid in partial_candidates
                    if _obj_type(self.elements.get(eid)) == type_restriction
                ]
            if classifier is not None:
                partial_candidates = [
                    eid for eid in partial_candidates
                    if self.elements.get(eid, {}).get("classifier") == classifier
                ]
            # Only accept if exactly one unique candidate; ambiguity falls through to hash.
            if len(partial_candidates) == 1:
                return self.elements.get(partial_candidates[0])

        # Tier 3: hash fallback -- when ancestral yields nothing, consult by_geom_hash directly.
        if not candidate_ids and hash_ids:
            geom_hash_str = hash_ids[0][1:]
            fallback_ids = [eid for eid in self.by_geom_hash.get(geom_hash_str, []) if eid in self.elements]
            if type_restriction is not None:
                fallback_ids = [eid for eid in fallback_ids if _obj_type(self.elements.get(eid)) == type_restriction]
            if classifier is not None:
                fallback_ids = [eid for eid in fallback_ids if self.elements.get(eid, {}).get("classifier") == classifier]
            candidate_ids = order_filter(fallback_ids)

        if not candidate_ids:
            return None
        if len(candidate_ids) > 1:
            raise AmbiguousQueryError(
                f"Query matched {len(candidate_ids)} elements: {candidate_ids}"
            )
        return self.elements.get(candidate_ids[0])

    def query_all(self, query_str: str, current_feature_id: str | None = None) -> list[Any]:
        """Return all elements whose ancestor set is a superset of the query's IDs.

        The inverse of query(): where query() finds a single element given its full
        ancestry, query_all() enumerates all elements that belong to a given ancestor
        (e.g. all flat faces of a feature). A type restriction in the query string
        filters by element type.
        """
        if not query_str or query_str[0] != '?':
            return []
        order_filter = self._order_filter(current_feature_id)
        ids, type_restriction = _parse_ancestry(query_str)
        query_set = frozenset(ids)
        candidate_ids: list[str] = []
        for registered_key, element_ids in self.ancestral.items():
            if query_set <= registered_key:  # query IDs are contained in registered ancestry
                candidate_ids.extend(element_ids)
        candidate_ids = order_filter(candidate_ids)
        if type_restriction is not None:
            candidate_ids = [
                eid for eid in candidate_ids
                if _obj_type(self.elements.get(eid)) == type_restriction
            ]
        return [self.elements[eid] for eid in candidate_ids if eid in self.elements]

    def query_all_typed(
        self,
        q: "AncestryQuery",
        current_feature_id: str | None = None,
    ) -> list[Any]:
        """Typed variant of query_all accepting an AncestryQuery object."""
        order_filter = self._order_filter(current_feature_id)
        query_set = frozenset(q.ancestor_ids)
        candidate_ids: list[str] = []
        for registered_key, element_ids in self.ancestral.items():
            if query_set <= registered_key:
                candidate_ids.extend(element_ids)
        candidate_ids = order_filter(candidate_ids)
        if q.type_restriction is not None:
            candidate_ids = [
                eid for eid in candidate_ids
                if _obj_type(self.elements.get(eid)) == q.type_restriction
            ]
        if q.classifier is not None:
            candidate_ids = [
                eid for eid in candidate_ids
                if self.elements.get(eid, {}).get("classifier") == q.classifier
            ]
        return [self.elements[eid] for eid in candidate_ids if eid in self.elements]


def _init_global_repo() -> "Repository":
    """Create and populate the global repository with built-in planes and origin."""
    repo = Repository()
    repo.register("builtin_origin", {"external_xy": [0.0, 0.0]})
    for name, plane in _BUILTIN_PLANES.items():
        repo.register(name, plane)
    return repo


def _evict_ancestry_and_register(
    repo: Repository,
    ancestor_ids: list[str],
    payload: dict,
    index_tag: str | None = None,
    geom_hash: str | None = None,
) -> str:
    """Evict stale ancestry entries and register a new one.

    If index_tag is provided, all ancestry keys containing that tag but
    different from the new key are evicted (stale position-based entries).
    The exact-key entry (if any) is always evicted before re-registering.
    geom_hash, if given, is registered into Repository.by_geom_hash as a
    fallback index (not included in the ancestral key frozenset).
    """
    key = frozenset(ancestor_ids)

    if index_tag is not None:
        stale_keys = [k for k in repo.ancestral if index_tag in k and k != key]
        for stale_key in stale_keys:
            for eid in repo.ancestral.pop(stale_key, []):
                repo.elements.pop(eid, None)

    for old_id in repo.ancestral.pop(key, []):
        repo.elements.pop(old_id, None)

    # Prune by_geom_hash entries whose element IDs were just evicted.
    if repo.by_geom_hash:
        stale_hashes = [
            h for h, eids in repo.by_geom_hash.items()
            if not any(eid in repo.elements for eid in eids)
        ]
        for h in stale_hashes:
            del repo.by_geom_hash[h]

    return repo.register_ancestor(ancestor_ids, payload, geom_hash=geom_hash)
