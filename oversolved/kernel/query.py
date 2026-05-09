from dataclasses import dataclass
from typing import Any, Optional
import secrets


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
    """@<feat><eid> or @<feat> (feature-plane reference)."""
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
    type_restriction: Optional[str] = None
    classifier: Optional[str] = None

    @staticmethod
    def from_parts(
        ids: list[str],
        type_restriction: Optional[str] = None,
        classifier: Optional[str] = None,
    ) -> "AncestryQuery":
        return AncestryQuery(
            ancestor_ids=tuple(ids),
            type_restriction=type_restriction,
            classifier=classifier,
        )


def parse_query(s: str) -> "LocalQuery | AbsoluteQuery | AncestryQuery":
    """Central parse entry-point -- replaces every inline startswith check."""
    if s.startswith("$"):
        return LocalQuery.from_string(s)
    if s.startswith("@"):
        return _parse_absolute(s)
    if s.startswith("?"):
        return _parse_ancestry_obj(s)
    raise ValueError(f"Unrecognized query string: {s!r}")


def emit_wire(q: "LocalQuery | AbsoluteQuery | AncestryQuery") -> str:
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
            return "@" + feature_id + eid + sub
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
    body = s[1:]
    for pt in ("start", "end", "center", "xy"):
        # Require the sub-entity suffix to follow a non-alphanumeric boundary
        # so that a feature_id like "sketch_start" is NOT parsed as "sketch_"+"start".
        if body.endswith(pt) and len(body) > len(pt):
            rest = body[: -len(pt)]
            if rest and not rest[-1].isalpha():
                return AbsoluteQuery(feature_id=rest, eid="", sub=pt)
    return AbsoluteQuery(feature_id=body)


def _parse_ancestry_obj(s: str) -> AncestryQuery:
    ids, type_restriction = _parse_ancestry(s)
    classifier: Optional[str] = None
    if type_restriction and "@" in type_restriction:
        type_restriction, classifier = type_restriction.split("@", 1)
    return AncestryQuery(
        ancestor_ids=tuple(ids),
        type_restriction=type_restriction or None,
        classifier=classifier,
    )


def local(eid: str, sub: str = "") -> LocalQuery:
    """Construct a LocalQuery ($<eid><sub>)."""
    return LocalQuery(eid=eid, sub=sub)


def absolute(feature_id: str, eid: str = "", sub: str = "") -> AbsoluteQuery:
    """Construct an AbsoluteQuery (@<feature_id><eid><sub>)."""
    return AbsoluteQuery(feature_id=feature_id, eid=eid, sub=sub)


def ancestry(
    ids: "list[LocalQuery | AbsoluteQuery | AncestryQuery | str]",
    type_restriction: Optional[str] = None,
    classifier: Optional[str] = None,
) -> AncestryQuery:
    """Build an AncestryQuery from typed Query objects or raw wire strings.

    Accepts Query objects so callers never have to call emit_wire themselves
    just to pass something to this function.
    """
    wire_ids = [
        emit_wire(i) if isinstance(i, (LocalQuery, AbsoluteQuery, AncestryQuery)) else i
        for i in ids
    ]
    return AncestryQuery.from_parts(wire_ids, type_restriction, classifier)


def _parse_ancestry(query_str: str) -> tuple[list[str], str | None]:
    """Parse `?A,B;<idA><idB>` or `?A,B;<idA><idB>:<TYPE>`.
    Returns (list_of_id_strings, type_restriction_or_None).
    """
    if not query_str.startswith('?'):
        raise ValueError(f"Invalid ancestry query: {query_str!r}")
    semi = query_str.index(';')
    lengths_hex = query_str[1:semi]
    rest = query_str[semi + 1:]

    lengths = [int(x, 16) for x in lengths_hex.split(',')]

    ids = []
    pos = 0
    for length in lengths:
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


_TYPE_HIERARCHY: dict[str, dict[str, list[str]]] = {
    'solid': {'parents': []},
    'face': {'parents': []},
    'flatface': {'parents': ['face']},
    'cylinderface': {'parents': ['face']},
    'edge': {'parents': []},
    'straightedge': {'parents': ['edge']},
    'vertex': {'parents': []},
}


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
    """Attempt to coerce element to target_type using body_store and repo_elements."""
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
    # Upward: child -> solid
    if target_type == 'solid' and body_store is not None:
        return body_store.get(body_id)
    # Downward / sibling: scan repo for matching child elements by body_id
    for el in repo_elements.values():
        el_type = _obj_type(el)
        if isinstance(el, dict) and el.get('body_id') == body_id:
            if el_type == target_type or _is_subtype(el_type, target_type):
                return el
    return None


class Query:
    def __init__(self, query_str: str):
        self._query_str = query_str

    def resolve(
        self, repo: 'Repository', context: str | None = None, body_store: dict[str, Any] | None = None
    ) -> Any:
        return repo.query(self._query_str, context=context, body_store=body_store)

    def __str__(self) -> str:
        return self._query_str

    def __repr__(self) -> str:
        return f'Query({self._query_str!r})'


class Repository:
    def __init__(self) -> None:
        self.elements: dict[str, Any] = {}
        # frozenset of ancestor ids -> list of element ids
        # (multiple elements can share the same ancestor set, e.g. two circle intersections)
        self.ancestral: dict[frozenset, list[str]] = {}

    def register(self, id: str, obj: Any):
        self.elements[id] = obj

    def register_ancestor(self, ancestors: list[str], obj: Any) -> str:
        id = secrets.token_urlsafe(9)
        key = frozenset(ancestors)
        self.ancestral.setdefault(key, []).append(id)
        self.elements[id] = obj
        return id

    def clear_by_sketch_id(self, sketch_id: str) -> None:
        """Remove all direct elements whose payload contains the given sketch_id."""
        keys_to_remove = [
            k for k, v in self.elements.items()
            if isinstance(v, dict) and v.get("sketch_id") == sketch_id
        ]
        for k in keys_to_remove:
            del self.elements[k]

    def query(
        self,
        query_str: "str | LocalQuery | AbsoluteQuery | AncestryQuery",
        context: str | None = None,
        body_store: dict[str, Any] | None = None,
    ) -> Any:
        if isinstance(query_str, (LocalQuery, AbsoluteQuery, AncestryQuery)):
            return self._query_typed(query_str, context, body_store)
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
            ids, type_restriction = _parse_ancestry(query_str)
            return self._resolve_ancestry_ids(ids, type_restriction, None, body_store)

        return None

    def _query_typed(
        self,
        q: "LocalQuery | AbsoluteQuery | AncestryQuery",
        context: str | None,
        body_store: dict[str, Any] | None = None,
    ) -> Any:
        match q:
            case LocalQuery(eid, sub):
                if context is None:
                    return None
                return self.elements.get(context + eid + sub)
            case AbsoluteQuery(feature_id, eid, sub):
                return self.elements.get(feature_id + eid + sub)
            case AncestryQuery(ancestor_ids, type_restriction, classifier):
                return self._resolve_ancestry_ids(
                    list(ancestor_ids), type_restriction, classifier, body_store
                )
        return None  # type: ignore[return-value]

    def _resolve_ancestry_ids(
        self,
        ids: list[str],
        type_restriction: Optional[str],
        classifier: Optional[str],
        body_store: dict[str, Any] | None = None,
    ) -> Any:
        query_set = frozenset(ids)

        # Collect all registered elements whose tag set is a superset of the query set.
        # Exact match is included (the query set is a subset of itself).
        # This enables partial resolve: a query with fewer tags still resolves
        # if the element has been re-registered with additional tags (e.g. a hash tag).
        candidate_ids: list[str] = []
        for registered_key, element_ids in self.ancestral.items():
            if query_set <= registered_key:
                candidate_ids.extend(element_ids)

        if not candidate_ids:
            return None

        # Filter by type restriction if given.
        effective_type = type_restriction
        if classifier is not None and effective_type is not None:
            effective_type = effective_type  # classifier handled by future resolver
        if effective_type is not None:
            exact_matches = [
                eid for eid in candidate_ids
                if _obj_type(self.elements.get(eid)) == effective_type
            ]
            if exact_matches:
                candidate_ids = exact_matches
            else:
                # Coercion: no exact match, try to resolve from candidates.
                for eid in candidate_ids:
                    element = self.elements.get(eid)
                    coerced = _coerce_type(element, effective_type, body_store, self.elements)
                    if coerced is not None:
                        return coerced
                return None

        if len(candidate_ids) == 0:
            return None
        if len(candidate_ids) > 1:
            raise AmbiguousQueryError(
                f"Query matched {len(candidate_ids)} elements: {candidate_ids}"
            )
        return self.elements.get(candidate_ids[0])

    def query_all(self, query_str: str) -> list[Any]:
        """Return all elements whose ancestor set is a superset of the query's IDs.

        The inverse of query(): where query() finds a single element given its full
        ancestry, query_all() enumerates all elements that belong to a given ancestor
        (e.g. all flat faces of a feature). A type restriction in the query string
        filters by element type.
        """
        if not query_str or query_str[0] != '?':
            return []
        ids, type_restriction = _parse_ancestry(query_str)
        query_set = frozenset(ids)
        candidate_ids: list[str] = []
        for registered_key, element_ids in self.ancestral.items():
            if query_set <= registered_key:  # query IDs are contained in registered ancestry
                candidate_ids.extend(element_ids)
        if type_restriction is not None:
            candidate_ids = [
                eid for eid in candidate_ids
                if _obj_type(self.elements.get(eid)) == type_restriction
            ]
        return [self.elements[eid] for eid in candidate_ids if eid in self.elements]

    def query_all_typed(
        self,
        q: "AncestryQuery",
    ) -> list[Any]:
        """Typed variant of query_all accepting an AncestryQuery object."""
        query_set = frozenset(q.ancestor_ids)
        candidate_ids: list[str] = []
        for registered_key, element_ids in self.ancestral.items():
            if query_set <= registered_key:
                candidate_ids.extend(element_ids)
        if q.type_restriction is not None:
            candidate_ids = [
                eid for eid in candidate_ids
                if _obj_type(self.elements.get(eid)) == q.type_restriction
            ]
        return [self.elements[eid] for eid in candidate_ids if eid in self.elements]
