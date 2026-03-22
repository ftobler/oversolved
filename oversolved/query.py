from typing import Any
import secrets


class AmbiguousQueryError(Exception):
    """Raised when an ancestry query matches more than one element."""


def _parse_ancestry(query_str: str) -> tuple[list[str], str | None]:
    """Parse `?A,B;<idA><idB>` or `?A,B;<idA><idB>:<TYPE>`.
    Returns (list_of_id_strings, type_restriction_or_None).
    """
    assert query_str[0] == '?'
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


def _obj_type(obj: Any) -> str | None:
    if isinstance(obj, dict):
        return obj.get('type')
    return getattr(obj, 'type', None)


class Query:
    def __init__(self, query_str: str):
        self._query_str = query_str

    def resolve(self, repo: 'Repository', context: str | None = None) -> Any:
        return repo.query(self._query_str, context=context)

    def __str__(self) -> str:
        return self._query_str

    def __repr__(self) -> str:
        return f'Query({self._query_str!r})'


class Repository:
    def __init__(self) -> None:
        self.elements: dict[str, Any] = {}
        # frozenset of ancestor ids -> list of element ids
        # (multiple elements can share the same ancestor set, e.g. two circle intersections)
        self.anchestral: dict[frozenset, list[str]] = {}

    def register(self, id: str, obj: Any):
        self.elements[id] = obj

    def register_anchestor(self, anchestors: list[str], obj: Any) -> str:
        id = secrets.token_urlsafe(9)
        key = frozenset(anchestors)
        self.anchestral.setdefault(key, []).append(id)
        self.elements[id] = obj
        return id

    def query(self, query_str: str, context: str | None = None) -> Any:
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
            query_set = frozenset(ids)

            # Collect all registered elements whose ancestor set is a subset of the query set.
            # Exact match is included (it is a subset of itself).
            # This enables partial resolve: a query with more ids than needed still resolves
            # if the element was re-registered with a smaller ancestor set.
            candidate_ids: list[str] = []
            for registered_key, element_ids in self.anchestral.items():
                if registered_key <= query_set:
                    candidate_ids.extend(element_ids)

            if not candidate_ids:
                return None

            # Filter by type restriction if given.
            if type_restriction is not None:
                candidate_ids = [
                    eid for eid in candidate_ids
                    if _obj_type(self.elements.get(eid)) == type_restriction
                ]

            if len(candidate_ids) == 0:
                return None
            if len(candidate_ids) > 1:
                raise AmbiguousQueryError(
                    f"Query {query_str!r} matched {len(candidate_ids)} elements: {candidate_ids}"
                )
            return self.elements.get(candidate_ids[0])

        return None
