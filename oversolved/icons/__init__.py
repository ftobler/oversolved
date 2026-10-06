"""The icon set, split by family so no module grows past a screenful.

Importing this package runs every `@icon` decorator against icon_cairo's
module-level registry; `just icons` walks that registry to write the SVGs. The
drawing helpers and the entry point are re-exported here for convenience; the
individual icon functions stay in their family modules (`icons.toolbar`,
`icons.features`, and so on). The sibling `icons.py` script is the
`python oversolved/icons.py` entry path.
"""

from icon_cairo import draw_all, icon, px, stroke  # noqa: F401
from . import constraints, features, mate, toolbar, ui  # noqa: F401
from .helpers import _arrowhead, _copy_icon_back_rect, _draw_arrow, _draw_plane_grid, _draw_rect_outline, _draw_x, _pencil, _rotation_arc, _trashcan, draw_dotted_line  # noqa: F401
