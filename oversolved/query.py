from typing import Any
import secrets


class Query:
    def __init__(self, query_str):
        self._query_str = query_str

    def resolve():
        ...


class Repository:
    def __init__(self) -> None:
        self.elements: dict[str, Any] = {}
        self.anchestral: dict[str, str] = {}

    def register(self, id: str, obj: Any):
        self.elements[id] = obj

    def register_anchestor(self, anchestor: list[str], obj: Any):
        id = secrets.token_urlsafe(18)
        for a in anchestor:
            self.anchestral[str] = id
        self.elements[id] = obj

    def query(self, query_str: str) -> Any:
        start = query_str[0]
        if start == "$":
            return None
        if start == "@":
            return self.elements.get(query_str[1:])
        if start == "?":
