"""Tests for verbose error message reduction."""

import json
from PIL import Image
from io import BytesIO


class TestVerboseUploadErrors:

    def test_upload_unsupported_extension_vague(self, authed_client):
        data = {"file": (BytesIO(b"test"), "malware.exe")}
        resp = authed_client.post("/api/upload", data=data)
        assert resp.status_code == 400
        data_resp = resp.get_json()
        assert data_resp["ok"] is False
        assert data_resp["error"] == "Unsupported file type"


class TestVerbosePreviewErrors:

    def test_preview_size_limit_vague(self, authed_client):
        # PUT no longer implicitly creates documents, so create one first; the
        # preview-size check is only reached on an existing, editable doc.
        uuid = json.loads(
            authed_client.post(
                "/api/documents",
                data=json.dumps({"name": "Doc"}),
                content_type="application/json",
            ).data
        )["uuid"]
        img = Image.new("RGB", (1200, 1200), color="red")
        buf = BytesIO()
        img.save(buf, format="PNG")
        b64 = __import__("base64").b64encode(buf.getvalue()).decode()
        resp = authed_client.put(
            f"/api/documents/{uuid}",
            data=json.dumps({"content": "test", "preview_image": b64}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        data_resp = resp.get_json()
        assert data_resp["ok"] is False
        assert data_resp["error"] == "Invalid image"
