"""Documentation routes (no auth required)."""

from pathlib import Path
from flask import Blueprint, jsonify

docs_bp = Blueprint("docs", __name__)


@docs_bp.route("/api/docs", methods=["GET"])
def list_docs():
    docs_path = Path(__file__).parent.parent.parent / "docs"
    if not docs_path.exists():
        return jsonify({"docs": []})
    md_files = sorted([f.stem for f in docs_path.glob("*.md")])
    return jsonify({"docs": md_files})


@docs_bp.route("/api/docs/<doc_name>", methods=["GET"])
def get_doc(doc_name):
    docs_path = Path(__file__).parent.parent.parent / "docs"
    file_path = docs_path / f"{doc_name}.md"
    try:
        file_path = file_path.resolve()
        docs_path = docs_path.resolve()
        if not str(file_path).startswith(str(docs_path)):
            return jsonify({"error": "Invalid doc name"}), 400
    except (OSError, ValueError):
        return jsonify({"error": "Invalid doc name"}), 400
    if not file_path.exists():
        return jsonify({"error": "Documentation not found"}), 404
    try:
        content = file_path.read_text(encoding="utf-8")
        return jsonify({"name": doc_name, "content": content})
    except OSError:
        return jsonify({"error": "Failed to read documentation"}), 500
