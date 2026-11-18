import io
import os
import uuid

from flask import Flask, abort, flash, jsonify, redirect, render_template, request, send_file, url_for

from graph_handler import GraphError, GraphHandler

app = Flask(__name__, static_folder="static")
app.secret_key = os.environ.get("AVECTORS_SECRET", os.urandom(16))
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024

UPLOAD_DIR = os.path.join(app.static_folder, "img_uploads")
ALLOWED_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}

graphHandler = GraphHandler("data/graphs", static_dir=app.static_folder)
graphHandler.load_data_file()


@app.route('/')
@app.route('/index')
def index():
    return render_template('index.html', graphs=graphHandler.getSummaries())


@app.route('/editor', methods=["GET"])
def editor():
    name = request.args.get("graph", "")
    if not graphHandler.exists(name):
        flash("Graph '%s' not found." % name)
        return redirect(url_for('index'))
    return render_template('note.html', graph_name=name)


@app.route('/graph', methods=["GET"])
def get_graph_data():
    data = graphHandler.getData(request.args.get("name", ""))
    if data is None:
        abort(404)
    return jsonify(data)


@app.route('/upload/image', methods=["POST"])
def upload_image():
    imagefile = request.files.get('image')
    if imagefile is None or not imagefile.filename:
        return "No image provided.", 400
    ext = os.path.splitext(imagefile.filename)[1].lower()
    if ext not in ALLOWED_IMAGE_EXT:
        return "Unsupported image type.", 400
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    filename = uuid.uuid4().hex + ext
    imagefile.save(os.path.join(UPLOAD_DIR, filename))
    return url_for('static', filename='img_uploads/' + filename)


@app.route('/save', methods=["POST"])
def save_graph_data():
    graph = request.form.get("graph")
    if not graph:
        return "Missing graph data.", 400
    try:
        graphHandler.saveGraph(graph)
    except (GraphError, ValueError) as e:
        return str(e), 400
    return "Graph Data Saved."


@app.route('/new', methods=["POST"])
def new_graph():
    try:
        name = graphHandler.newGraph(request.form.get("name"))
    except GraphError as e:
        flash(str(e))
        return redirect(url_for('index'))
    return redirect(url_for('editor', graph=name))


@app.route('/delete', methods=["POST"])
def delete_graph():
    try:
        graphHandler.deleteGraph(request.form.get("name", ""))
    except GraphError as e:
        flash(str(e))
    return redirect(url_for('index'))


@app.route('/export', methods=["POST"])
def export():
    name = request.form.get("name", "")
    fmt = request.form.get("format", "html")
    try:
        data, mimetype, filename = graphHandler.build_export(name, request.form.get("file", ""), fmt)
    except GraphError as e:
        return str(e), 400
    return send_file(io.BytesIO(data), mimetype=mimetype, as_attachment=True, download_name=filename)


if __name__ == '__main__':
    # Debug mode exposes the Werkzeug debugger; only enable it explicitly.
    app.run(debug=os.environ.get("FLASK_DEBUG") == "1")
