"""Regression guards: typed construction helpers must produce the same strings
as the old ad-hoc string concatenation they replaced.
"""
from oversolved.query import emit_wire, absolute, ancestry, make_ancestry_query, LocalQuery, Repository

FEAT = "A" * 18
ELE = "B" * 12


def test_topology_edge_id_format():
    assert emit_wire(absolute(FEAT, ELE + "line")) == "@" + FEAT + ELE + "line"


def test_topology_face_id_format():
    assert emit_wire(absolute(FEAT, ELE)) == "@" + FEAT + ELE


def test_builder_face_id_format():
    assert emit_wire(absolute("extrude1", "face0")) == "@extrude1face0"


def test_builder_edge_id_format():
    assert emit_wire(absolute("extrude1", "edge3")) == "@extrude1edge3"


def test_builder_vertex_id_format():
    assert emit_wire(absolute("extrude1", "vertex7")) == "@extrude1vertex7"


def test_solver_local_registration_start():
    assert emit_wire(absolute(FEAT, ELE, "start")) == "@" + FEAT + ELE + "start"


def test_solver_local_registration_end():
    assert emit_wire(absolute(FEAT, ELE, "end")) == "@" + FEAT + ELE + "end"


def test_solver_local_registration_center():
    assert emit_wire(absolute(FEAT, ELE, "center")) == "@" + FEAT + ELE + "center"


def test_solver_local_registration_xy():
    assert emit_wire(absolute(FEAT, ELE, "xy")) == "@" + FEAT + ELE + "xy"


def test_ancestry_face_format_unchanged():
    ids = sorted(["@sk1a", "@sk1b"])
    assert emit_wire(ancestry(ids, "flatface")) == make_ancestry_query(ids, "flatface")


# Repository.query accepts typed query objects

def test_repo_query_accepts_local_query_object():
    repo = Repository()
    obj = {"v": 1}
    repo.register(FEAT + "e1", obj)
    assert repo.query(LocalQuery("e1"), context=FEAT) is obj


def test_repo_query_accepts_absolute_query_object():
    repo = Repository()
    obj = {"v": 2}
    repo.register(FEAT + ELE, obj)
    from oversolved.query import AbsoluteQuery
    assert repo.query(AbsoluteQuery(FEAT, ELE)) is obj


def test_repo_query_accepts_ancestry_query_object():
    from oversolved.query import AncestryQuery
    repo = Repository()
    obj = {"type": "pt"}
    ids = ["@a", "@b"]
    repo.register_anchestor(ids, obj)
    aq = AncestryQuery(ancestor_ids=tuple(ids), type_restriction="pt")
    assert repo.query(aq) is obj


def test_repo_query_string_still_works():
    repo = Repository()
    obj = {"v": 3}
    repo.register(FEAT + "e1", obj)
    assert repo.query("$e1", context=FEAT) is obj
    assert repo.query("@" + FEAT + "e1") is obj
