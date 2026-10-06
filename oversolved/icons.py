"""Entry script for `just icons`: import the icons package, then render it.

`from icons import draw_all` resolves to the sibling `icons/` package (a
package shadows a top-level module of the same name), so importing it populates
icon_cairo's registry and draw_all writes every SVG. Keeping this file means
the build invocation stays `python oversolved/icons.py`.
"""

from icons import draw_all

if __name__ == "__main__":
    draw_all()
