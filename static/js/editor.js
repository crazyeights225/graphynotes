// Page wiring: markdown editor, graph loading, export.

var easyMDE;
var suppressEditorChange = false;

function setEditorValue(v) {
    suppressEditorChange = true;
    easyMDE.value(v);
    suppressEditorChange = false;
}

document.addEventListener('DOMContentLoaded', function() {
    easyMDE = new EasyMDE({
        element: document.getElementById('description-editor'),
        placeholder: 'Notes, commands, output… (Markdown)',
        spellChecker: false,
        status: false,
        autosave: { enabled: false },
        forceSync: false,
        minHeight: '220px',
        uploadImage: true,
        toolbar: [
            'bold', 'italic', 'heading', '|',
            'code', 'quote', 'unordered-list', 'ordered-list', '|',
            'link', 'upload-image', 'table', '|',
            'preview', 'side-by-side', 'fullscreen'
        ],
        imageUploadFunction: function(file, onSuccess, onError) {
            var data = new FormData();
            data.append('image', file);
            fetch('/upload/image', { method: 'POST', body: data })
                .then(function(res) {
                    return res.text().then(function(t) { if (!res.ok) throw new Error(t); return t; });
                })
                .then(onSuccess)
                .catch(function(err) { onError('Image upload failed: ' + err.message); });
        }
    });

    easyMDE.codemirror.on('change', function() {
        if (suppressEditorChange || !selection || selection.type !== 'node') return;
        getNode(selection.id).description = easyMDE.value();
        markDirty();
    });

    fetch('/graph?' + new URLSearchParams({ name: currentGraphName }))
        .then(function(res) {
            if (!res.ok) throw new Error(res.status === 404 ? 'Graph not found.' : res.statusText);
            return res.json();
        })
        .then(function(data) {
            normalizeGraph(data);
            initGraph();
        })
        .catch(function(err) {
            showToast('Could not load graph: ' + err.message, true);
        });
});

var EXPORT_EXT = { html: '.html', md: '.zip', pdf: '.pdf' };
var EXPORT_NAMES = { html: 'HTML report', md: 'Markdown export', pdf: 'PDF report' };

function toggleExportMenu(e) {
    e.stopPropagation();
    document.getElementById('export-dropdown').classList.toggle('is-open');
}

function closeExportMenu() {
    document.getElementById('export-dropdown').classList.remove('is-open');
}

document.addEventListener('click', function(e) {
    if (!document.getElementById('export-menu').contains(e.target)) closeExportMenu();
});
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeExportMenu(); });

function exportGraph(format) {
    closeExportMenu();
    var img = renderDiagram();
    if (!img) { showToast('Nothing to export yet — add some nodes first.'); return; }
    var btn = document.getElementById('export-btn');
    btn.classList.add('is-loading');

    saveGraph()
        .then(function() {
            var body = new URLSearchParams({ name: currentGraphName, file: img, format: format });
            return fetch('/export', { method: 'POST', body: body });
        })
        .then(function(res) {
            if (!res.ok) return res.text().then(function(t) { throw new Error(t); });
            return res.blob();
        })
        .then(function(blob) {
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = currentGraphName + EXPORT_EXT[format];
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function() { URL.revokeObjectURL(a.href); }, 1000);
            showToast(EXPORT_NAMES[format] + ' downloaded.');
        })
        .catch(function(err) { showToast('Export failed: ' + err.message, true); })
        .finally(function() { btn.classList.remove('is-loading'); });
}
