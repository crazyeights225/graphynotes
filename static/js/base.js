// Data model, shared state and persistence.

var STATUSES = ['default', 'todo', 'pass', 'failed'];
var STATUS_LABELS = { default: 'None', todo: 'Todo', pass: 'Pass', failed: 'Failed' };

var colors = {
    "default":  "#586e75",  /* solarized base01  */
    "selected": "#268bd2",  /* solarized blue    */
    "pass":     "#859900",  /* solarized green   */
    "failed":   "#dc322f",  /* solarized red     */
    "todo":     "#b58900",  /* solarized yellow  */
    "text":     "#eee8d5",
    "bg":       "#002b36"
};

// NB: not called `Node` — that would shadow the browser's built-in DOM `Node`.
function GraphNode(id, name, x, y, status, shape) {
    this.id = id;
    this.name = name;
    this.x = x;
    this.y = y;
    this.status = status || 'default';
    this.shape = shape || 'circle';
    this.description = '';
}

function Connector(id, from, to) {
    this.id = id;
    this.from = from;
    this.to = to;
    this.status = 'default';
}

function Label(id, text, x, y) {
    this.id = id;
    this.text = text;
    this.x = x;
    this.y = y;
}

function Group(id, name, nodeIds) {
    this.id = id;
    this.name = name;
    this.nodeIds = nodeIds;
    this.x = 0;
    this.y = 0;
    this.width = 0;
    this.height = 0;
}

var currentGraphName = window.GRAPH_NAME;
var nodes = [];
var connectors = [];
var labels = [];
var groups = [];

// Next free id for a prefix, based on what's actually in the graph, so ids
// never collide after deletions.
function nextId(prefix, list) {
    var max = 0;
    list.forEach(function(item) {
        var n = parseInt(String(item.id).slice(prefix.length), 10);
        if (String(item.id).indexOf(prefix) === 0 && !isNaN(n)) max = Math.max(max, n);
    });
    return prefix + (max + 1);
}

function getNode(id)      { return nodes.find(function(n) { return n.id === id; }); }
function getConnector(id) { return connectors.find(function(c) { return c.id === id; }); }
function getLabel(id)     { return labels.find(function(l) { return l.id === id; }); }
function getGroup(id)     { return groups.find(function(g) { return g.id === id; }); }

// Clean up graphs saved by older versions of the app.
function normalizeGraph(data) {
    nodes = (data.nodes || []).map(function(n) {
        delete n.parents;
        n.status = n.status in colors ? n.status : 'default';
        n.shape = n.shape || 'circle';
        if (n.description === 'Add a description of the step..') n.description = '';
        return n;
    });
    var ids = new Set(nodes.map(function(n) { return n.id; }));
    connectors = (data.connectors || []).filter(function(c) {
        return ids.has(c.from) && ids.has(c.to) && c.from !== c.to;
    });
    labels = data.labels || [];
    groups = (data.groups || []).map(function(g) {
        g.nodeIds = (g.nodeIds || []).filter(function(id) { return ids.has(id); });
        return g;
    }).filter(function(g) { return g.nodeIds.length > 0; });
}

// --- Persistence ---

var autosaveTimer = null;
var dirty = false;
var saveSeq = 0;

function graphPayload() {
    return JSON.stringify({
        name: currentGraphName,
        nodes: nodes,
        connectors: connectors,
        labels: labels,
        groups: groups
    });
}

function setSaveStatus(state, text) {
    var el = document.getElementById('save-status');
    el.dataset.state = state;
    el.textContent = text;
}

function markDirty() {
    dirty = true;
    setSaveStatus('dirty', 'Unsaved changes');
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(saveGraph, 800);
}

function saveGraph() {
    clearTimeout(autosaveTimer);
    var seq = ++saveSeq;
    var wasDirty = dirty;
    dirty = false;
    setSaveStatus('saving', 'Saving…');
    var body = new URLSearchParams({ graph: graphPayload() });
    return fetch('/save', { method: 'POST', body: body })
        .then(function(res) {
            if (!res.ok) return res.text().then(function(t) { throw new Error(t || res.statusText); });
            if (seq === saveSeq && !dirty) setSaveStatus('saved', 'Saved');
        })
        .catch(function(err) {
            dirty = dirty || wasDirty;
            setSaveStatus('error', 'Save failed');
            showToast('Save failed: ' + err.message, true);
        });
}

// Flush pending edits if the user navigates away before the autosave fires.
window.addEventListener('beforeunload', function(e) {
    if (!dirty) return;
    var fd = new FormData();
    fd.append('graph', graphPayload());
    if (navigator.sendBeacon && navigator.sendBeacon('/save', fd)) {
        dirty = false;
        return;
    }
    e.preventDefault();
    e.returnValue = '';
});

var toastTimer = null;
function showToast(msg, isError) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.toggle('is-error', !!isError);
    t.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { t.classList.remove('is-visible'); }, isError ? 5000 : 2500);
}
