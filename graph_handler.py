import base64
import glob
import html
import io
import json
import mimetypes
import os
import re
import time
import zipfile

import markdown

# Graph names become file names, so keep them to a safe, readable subset.
NAME_RE = re.compile(r"^[\w][\w .\-]{0,63}$")
PLACEHOLDER_DESCRIPTION = "Add a description of the step.."

STATUS_COLORS = {
    "default": "#586e75",
    "pass": "#859900",
    "failed": "#dc322f",
    "todo": "#b58900",
}


class GraphError(ValueError):
    pass


def validate_name(name):
    name = (name or "").strip()
    if not NAME_RE.match(name):
        raise GraphError(
            "Graph names must be 1-64 characters: letters, numbers, spaces, '.', '_' or '-', "
            "and can't start with a space or dot."
        )
    return name


class GraphHandler:
    def __init__(self, directory, static_dir="static"):
        self.directory = directory
        self.static_dir = static_dir
        self.data = {}

    def _graph_path(self, name):
        return os.path.join(self.directory, validate_name(name) + ".json")

    def _write(self, name):
        path = self._graph_path(name)
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.data[name], f, indent=1)
        os.replace(tmp, path)  # atomic: a crash mid-write can't corrupt the graph

    def load_data_file(self):
        os.makedirs(self.directory, exist_ok=True)
        for path in glob.glob(os.path.join(self.directory, "*.json")):
            name = os.path.splitext(os.path.basename(path))[0]
            if not NAME_RE.match(name):
                continue
            with open(path) as f:
                self.data[name] = json.load(f)

    def getGraphNames(self):
        return sorted(self.data.keys(), key=str.lower)

    def getSummaries(self):
        out = []
        for name in self.getGraphNames():
            g = self.data[name]
            try:
                mtime = os.path.getmtime(self._graph_path(name))
            except OSError:
                mtime = 0
            out.append({
                "name": name,
                "nodes": len(g.get("nodes", [])),
                "connectors": len(g.get("connectors", [])),
                "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(mtime)) if mtime else "",
            })
        return out

    def exists(self, name):
        return name in self.data

    def getData(self, name):
        if name in self.data:
            return {"name": name, **self.data[name]}
        return None

    def _normalize(self, graph):
        """Drop the redundant name and fields the editor no longer uses; round coordinates."""
        out = {
            "nodes": graph.get("nodes", []),
            "connectors": graph.get("connectors", []),
            "labels": graph.get("labels", []),
            "groups": graph.get("groups", []),
        }
        for key in ("nodes", "labels", "groups"):
            for item in out[key]:
                for coord in ("x", "y", "width", "height"):
                    if isinstance(item.get(coord), (int, float)):
                        item[coord] = round(item[coord], 2)
        for node in out["nodes"]:
            node.pop("parents", None)
        return out

    def newGraph(self, name):
        name = validate_name(name)
        if name in self.data:
            raise GraphError("A graph called '%s' already exists." % name)
        self.data[name] = self._normalize({})
        self._write(name)
        return name

    def saveGraph(self, graph):
        if isinstance(graph, str):
            graph = json.loads(graph)
        name = validate_name(graph.get("name"))
        if name not in self.data:
            raise GraphError("Unknown graph '%s'." % name)
        self.data[name] = self._normalize(graph)
        self._write(name)

    def deleteGraph(self, name):
        if name not in self.data:
            raise GraphError("Unknown graph '%s'." % name)
        os.remove(self._graph_path(name))
        del self.data[name]

    # --- Report export -------------------------------------------------

    EXPORT_FORMATS = ("html", "md", "pdf")

    def _upload_path(self, src):
        """Map an <img> src / markdown image URL to a file under static/, or None."""
        rel = src.split("?")[0].lstrip("/")
        if rel.startswith("static/"):
            rel = rel[len("static/"):]
        root = os.path.normpath(self.static_dir)
        path = os.path.normpath(os.path.join(root, rel))
        if path.startswith(root + os.sep) and os.path.isfile(path):
            return path
        return None

    def _rewrite_images(self, text, replace):
        """Call replace(path) for every local image in HTML src="..." or markdown ![](...)
        and substitute the returned URL."""
        def html_repl(m):
            path = self._upload_path(m.group(2))
            return '%ssrc="%s"' % (m.group(1), replace(path)) if path else m.group(0)

        def md_repl(m):
            path = self._upload_path(m.group(2))
            return "![%s](%s)" % (m.group(1), replace(path)) if path else m.group(0)

        text = re.sub(r'(<img[^>]*?\s)src="([^"]+)"', html_repl, text)
        return re.sub(r'!\[([^\]]*)\]\(([^)\s]+)\)', md_repl, text)

    @staticmethod
    def _data_uri(path):
        mime = mimetypes.guess_type(path)[0] or "image/png"
        with open(path, "rb") as f:
            return "data:%s;base64,%s" % (mime, base64.b64encode(f.read()).decode())

    def _nodes_for_export(self, graph):
        out = []
        for node in graph.get("nodes", []):
            descr = node.get("description") or ""
            if descr.strip() == PLACEHOLDER_DESCRIPTION:
                descr = ""
            out.append((node.get("name", ""), node.get("status", "default"), descr))
        return out

    @staticmethod
    def _md_to_html(descr):
        return markdown.markdown(descr, extensions=["fenced_code", "tables", "nl2br"])

    def build_export(self, name, image_data, fmt):
        """Returns (bytes, mimetype, filename)."""
        graph = self.getData(name)
        if graph is None:
            raise GraphError("Unknown graph '%s'." % name)
        if not image_data.startswith("data:image/png;base64,"):
            raise GraphError("Diagram image missing.")
        if fmt == "html":
            return self._build_html(name, graph, image_data).encode(), "text/html", name + ".html"
        if fmt == "md":
            return self._build_markdown_zip(name, graph, image_data), "application/zip", name + ".zip"
        if fmt == "pdf":
            return self._build_pdf(name, graph, image_data), "application/pdf", name + ".pdf"
        raise GraphError("Unknown export format '%s'." % fmt)

    def _build_html(self, name, graph, image_data):
        sections = []
        for node_name, status, descr in self._nodes_for_export(graph):
            body = self._rewrite_images(self._md_to_html(descr), self._data_uri)
            sections.append(
                '<section class="node"><h2><span class="dot" style="background:%s"></span>%s</h2>'
                '<p class="status">Status: %s</p><div class="body">%s</div></section>'
                % (STATUS_COLORS.get(status, STATUS_COLORS["default"]),
                   html.escape(node_name), html.escape(status),
                   body or '<p class="empty">No notes.</p>'))
        return REPORT_TEMPLATE % {
            "title": html.escape(name),
            "image": image_data,
            "date": time.strftime("%Y-%m-%d %H:%M"),
            "sections": "\n".join(sections),
        }

    def _build_markdown_zip(self, name, graph, image_data):
        """A zip with <name>.md and an images/ folder, so images work in any markdown viewer."""
        files = {"images/diagram.png": base64.b64decode(image_data.split(",", 1)[1])}

        def add_image(path):
            arc = "images/" + os.path.basename(path)
            if arc not in files:
                with open(path, "rb") as f:
                    files[arc] = f.read()
            return arc

        lines = ["# %s" % name, "", "_Exported %s_" % time.strftime("%Y-%m-%d %H:%M"), "",
                 "![Graph diagram](images/diagram.png)", ""]
        for node_name, status, descr in self._nodes_for_export(graph):
            lines += ["## %s" % node_name, "", "**Status:** %s" % status, ""]
            lines += [self._rewrite_images(descr, add_image).strip() or "_No notes._", ""]

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("%s/%s.md" % (name, name), "\n".join(lines))
            for arc, data in files.items():
                z.writestr("%s/%s" % (name, arc), data)
        return buf.getvalue()

    @staticmethod
    def _wrap_pre(content, width=88):
        """xhtml2pdf doesn't wrap <pre>, so long lines (commands, tool output) would be
        cut off at the page edge. Hard-wrap them; 88 Courier chars fit the PDF's width."""
        text = html.unescape(re.sub(r"</?code[^>]*>", "", content))
        out = []
        for line in text.split("\n"):
            while len(line) > width:
                out.append(line[:width])
                line = "  " + line[width:]
            out.append(line)
        return html.escape("\n".join(out), quote=False)

    def _build_pdf(self, name, graph, image_data):
        try:
            from xhtml2pdf import pisa
            from reportlab.lib.utils import ImageReader
        except ImportError:
            raise GraphError("PDF export needs xhtml2pdf: pip install -r requirements.txt")

        max_w = 480.0  # usable width in points on A4 with the margins below

        def sized_img(src, size):
            w, h = size
            scale = min(1.0, max_w / w) if w else 1.0
            return '<img src="%s" width="%d" height="%d">' % (src, w * scale, h * scale)

        diagram = base64.b64decode(image_data.split(",", 1)[1])
        dw, dh = ImageReader(io.BytesIO(diagram)).getSize()
        # The canvas is rendered at 2x pixel ratio; scale to fit the page width.
        diagram_tag = sized_img(image_data, (dw / 2, dh / 2))

        sections = []
        for node_name, status, descr in self._nodes_for_export(graph):
            body = self._md_to_html(descr)

            # xhtml2pdf needs explicit image sizes, and only reads local files reliably.
            def img_repl(m):
                path = self._upload_path(m.group(1))
                if not path:
                    return ""
                try:
                    return sized_img(os.path.abspath(path), ImageReader(path).getSize())
                except Exception:
                    return ""
            body = re.sub(r'<img[^>]*?\ssrc="([^"]+)"[^>]*>', img_repl, body)
            body = re.sub(r'(<pre[^>]*>)(.*?)(</pre>)',
                          lambda m: m.group(1) + self._wrap_pre(m.group(2)) + m.group(3),
                          body, flags=re.S)

            color = STATUS_COLORS.get(status, STATUS_COLORS["default"])
            sections.append(
                '<div class="node"><h2>%s</h2>'
                '<p class="status">Status: <span style="color:%s"><b>%s</b></span></p>%s</div>'
                % (html.escape(node_name), color, html.escape(status),
                   body or '<p class="empty">No notes.</p>'))

        doc = PDF_TEMPLATE % {
            "title": html.escape(name),
            "date": time.strftime("%Y-%m-%d %H:%M"),
            "diagram": diagram_tag,
            "sections": "\n".join(sections),
        }
        out = io.BytesIO()
        result = pisa.CreatePDF(doc, dest=out, encoding="utf-8")
        if result.err:
            raise GraphError("PDF generation failed.")
        return out.getvalue()


REPORT_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>%(title)s</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; color: #222; line-height: 1.5; }
  h1 { color: #268bd2; margin-bottom: 0; }
  .meta { color: #888; margin-top: 4px; }
  .diagram { width: 100%%; border-radius: 6px; margin: 20px 0 32px; }
  .node { border: 1px solid #ddd; border-radius: 6px; padding: 4px 20px 12px; margin-bottom: 16px; page-break-inside: avoid; }
  .node h2 { font-size: 1.15rem; display: flex; align-items: center; gap: 10px; }
  .dot { width: 12px; height: 12px; border-radius: 50%%; display: inline-block; }
  .status { color: #777; font-size: .85rem; margin-top: -10px; text-transform: capitalize; }
  .empty { color: #aaa; font-style: italic; }
  pre { background: #f4f4f4; padding: 10px; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; }
  code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; }
  img { max-width: 100%%; }
  table { border-collapse: collapse; } td, th { border: 1px solid #ddd; padding: 4px 8px; }
</style>
</head>
<body>
<h1>%(title)s</h1>
<p class="meta">Exported %(date)s</p>
<img class="diagram" src="%(image)s" alt="Graph diagram">
%(sections)s
</body>
</html>
"""

# xhtml2pdf supports only a subset of CSS (no flexbox, explicit image sizes).
PDF_TEMPLATE = """<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: a4; margin: 1.6cm; }
  body { font-family: Helvetica; font-size: 10pt; color: #222; }
  h1 { color: #268bd2; font-size: 20pt; margin-bottom: 0; }
  .meta { color: #888; }
  h2 { font-size: 13pt; margin: 0; padding-top: 4pt; border-top: 1px solid #ccc; }
  .node { margin-top: 12pt; }
  .status { color: #666; margin: 2pt 0 6pt 0; }
  .empty { color: #aaa; }
  pre { font-family: Courier; font-size: 8.5pt; background-color: #f4f4f4; padding: 6pt; }
  code { font-family: Courier; }
  td, th { border: 1px solid #ccc; padding: 3pt; }
</style>
</head>
<body>
<h1>%(title)s</h1>
<p class="meta">Exported %(date)s</p>
<p>%(diagram)s</p>
%(sections)s
</body>
</html>
"""
