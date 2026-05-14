"""Binary geometry packing for WebSocket transport.

Provides helpers to pack tessellated body mesh data into a compact binary
frame.  Used by both the solver daemon (to pack before sending) and Flask
(to forward the pre-packed bytes to the browser).

Wire format:
    [4B big-endian padded_json_len][JSON header padded to 4-byte boundary][binary data]

Offsets in the header are relative to the start of the binary data section.
"""

import array as _array
import json
import struct


def _float32_bytes(values):
    return _array.array('f', values).tobytes()


def _uint32_bytes(values):
    return _array.array('I', values).tobytes()


def _pack_body_section(body, body_offset, header_bodies, binary_chunks):
    """Pack one body into binary chunks and write its header metadata."""
    mesh = body.get("mesh", {}) or {}
    raw_verts = mesh.get("vertices", []) or []
    raw_faces = mesh.get("faces", []) or []
    raw_tri2face = mesh.get("triangle_to_face", []) or []

    for i, v in enumerate(raw_verts):
        if len(v) != 3:
            raise ValueError(f"vertex {i} has {len(v)} components, expected 3")
    flat_verts = [coord for v in raw_verts for coord in v]
    flat_faces = [idx for f in raw_faces for idx in f]

    verts_bytes = _float32_bytes(flat_verts)
    faces_bytes = _uint32_bytes(flat_faces)
    tri2face_bytes = _uint32_bytes(raw_tri2face)

    v_len = len(verts_bytes)
    f_len = len(faces_bytes)
    t_len = len(tri2face_bytes)

    header_bodies[body.get("id", "")] = {
        "created_by": body.get("created_by"),
        "modified_by": body.get("modified_by", []),
        "face_data": mesh.get("face_data", []),
        "face_queries": mesh.get("face_queries", []),
        "edges": body.get("edges", []),
        "edge_queries": body.get("edge_queries", []),
        "brep_vertex_queries": body.get("vertex_queries", []),
        "vertices": body.get("vertices", []),
        "offsets": {
            "vertices": [body_offset, v_len],
            "faces": [body_offset + v_len, f_len],
            "tri2face": [body_offset + v_len + f_len, t_len],
        },
        "counts": {
            "vertices": len(raw_verts),
            "faces": len(raw_faces),
            "tri2face": len(raw_tri2face),
        },
    }

    binary_chunks.extend([verts_bytes, faces_bytes, tri2face_bytes])
    return body_offset + v_len + f_len + t_len


def pack_geometry_update(msg_id, bodies, pick_bodies=None, *, request_id=None) -> bytes:
    """Pack geometry data into a binary WebSocket frame.

    Layout: [4B padded_json_len][JSON header (padded to 4B alignment)][binary data]
    Offsets in the header are relative to the start of the binary data section.
    Returns bytes suitable for ws.send().

    When request_id is provided it is embedded in the JSON header for
    internal correlation; the browser ignores unknown header fields.
    """
    header: dict = {"msgId": msg_id, "bodies": {}, "pick_bodies": {}}
    if request_id is not None:
        header["request_id"] = request_id

    binary_chunks: list[bytes] = []
    body_offset = 0

    for body_id, body in (bodies or {}).items():
        body_with_id = {**body, "id": body_id}
        body_offset = _pack_body_section(
            body_with_id, body_offset, header["bodies"], binary_chunks
        )

    for body_id, body in (pick_bodies or {}).items():
        body_with_id = {**body, "id": body_id}
        body_offset = _pack_body_section(
            body_with_id, body_offset, header["pick_bodies"], binary_chunks
        )

    header_bytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
    padded_len = ((len(header_bytes) + 3) // 4) * 4
    header_bytes = header_bytes.ljust(padded_len, b"\x00")

    return struct.pack(">I", padded_len) + header_bytes + b"".join(binary_chunks)
