// Canvas editor: drawing, interaction modes and selection.
//
// Modes:      select | node | connect | label | group
// Selection:  null or { type: 'node'|'connector'|'label'|'group', id }

var NODE_RADIUS = 14;
var MIN_SCALE = 0.2, MAX_SCALE = 4;

var mode = 'select';
var selection = null;
var currentShape = 'circle';
var connectFrom = null;        // node id while drawing a connector
var pendingGroupNodes = [];    // node ids while creating a group
var groupTransformer = null;

var canvasEl = document.getElementById('canvas-area');

var stage = new Konva.Stage({
    container: 'canvas-area',
    width: canvasEl.clientWidth,
    height: canvasEl.clientHeight,
    draggable: true            // drag background to pan
});
var layer = new Konva.Layer();
var groupsLayerG = new Konva.Group();   // group boxes sit underneath
var edgesG = new Konva.Group();
var nodesG = new Konva.Group();         // nodes and free labels
layer.add(groupsLayerG, edgesG, nodesG);
stage.add(layer);

var previewLine = new Konva.Arrow({
    stroke: colors.selected, fill: colors.selected, strokeWidth: 2,
    dash: [6, 4], pointerLength: 8, pointerWidth: 8, listening: false, visible: false
});
layer.add(previewLine);

new ResizeObserver(function() {
    stage.width(canvasEl.clientWidth);
    stage.height(canvasEl.clientHeight);
}).observe(canvasEl);

// ---------------------------------------------------------------- helpers

function pointerPos() {
    return stage.getRelativePointerPosition();   // accounts for pan + zoom
}

function isBackground(target) {
    return target === stage || target.hasName('group-shape');
}

function konvaFor(id) { return layer.findOne('#' + id); }

// Endpoints trimmed so arrows stop at the node edge instead of its centre.
function connectorPoints(from, to) {
    var dx = to.x - from.x, dy = to.y - from.y;
    var dist = Math.hypot(dx, dy) || 1;
    var trimStart = Math.min(NODE_RADIUS + 3, dist / 3);
    var trimEnd = Math.min(NODE_RADIUS + 5, dist / 3);
    return [
        from.x + dx / dist * trimStart, from.y + dy / dist * trimStart,
        to.x - dx / dist * trimEnd,     to.y - dy / dist * trimEnd
    ];
}

// ---------------------------------------------------------------- drawing

function makeBody(shape) {
    var base = { name: 'node-body', strokeWidth: 0 };
    if (shape === 'rect')    return new Konva.Rect(Object.assign(base, { width: 30, height: 22, offsetX: 15, offsetY: 11, cornerRadius: 4 }));
    if (shape === 'diamond') return new Konva.RegularPolygon(Object.assign(base, { sides: 4, radius: NODE_RADIUS + 2 }));
    if (shape === 'hex')     return new Konva.RegularPolygon(Object.assign(base, { sides: 6, radius: NODE_RADIUS }));
    return new Konva.Circle(Object.assign(base, { radius: NODE_RADIUS }));
}

function drawNode(data) {
    var g = new Konva.Group({ id: data.id, name: 'node', x: data.x, y: data.y, draggable: true });
    g.add(makeBody(data.shape));
    g.add(new Konva.Text({
        name: 'node-text', text: data.name, fontSize: 12, fill: colors.text,
        width: 160, offsetX: 80, y: NODE_RADIUS + 6, align: 'center', wrap: 'word'
    }));

    g.on('click tap', function(e) {
        e.cancelBubble = true;
        if (e.evt.button === 2) return;           // right-click is handled by 'contextmenu'
        onNodeClick(data);
    });
    g.on('contextmenu', function(e) {
        e.evt.preventDefault();
        e.cancelBubble = true;
        startInlineRename(data);
    });
    g.on('dblclick dbltap', function(e) {
        e.cancelBubble = true;
        if (mode !== 'select') return;
        select('node', data.id);
        var input = document.getElementById('node-name');
        input.focus(); input.select();
    });
    g.on('dragstart', function() { if (mode === 'select') select('node', data.id); });
    g.on('dragmove', function() {
        data.x = g.x(); data.y = g.y();
        updateEdgesFor(data.id);
        groups.forEach(function(gr) { if (gr.nodeIds.includes(data.id)) fitGroup(gr, false); });
    });
    g.on('dragend', markDirty);
    g.on('mouseenter', function() { setCursor(mode === 'select' ? 'move' : 'pointer'); });
    g.on('mouseleave', function() { setCursor(''); });
    nodesG.add(g);
}

function drawConnector(data) {
    var arrow = new Konva.Arrow({
        id: data.id, name: 'connector', strokeWidth: 2.5,
        pointerLength: 9, pointerWidth: 9, hitStrokeWidth: 14
    });
    arrow.on('click tap', function(e) {
        e.cancelBubble = true;
        if (mode === 'select' || mode === 'connect') { setMode('select'); select('connector', data.id); }
    });
    arrow.on('mouseenter', function() { setCursor('pointer'); });
    arrow.on('mouseleave', function() { setCursor(''); });
    edgesG.add(arrow);
    updateEdge(data);
}

function drawLabel(data) {
    var t = new Konva.Text({
        id: data.id, name: 'label-shape', text: data.text, fontSize: 14,
        fill: colors.text, x: data.x, y: data.y, draggable: true, padding: 2
    });
    t.on('click tap', function(e) {
        e.cancelBubble = true;
        if (mode !== 'group') { setMode('select'); select('label', data.id); }
    });
    t.on('dblclick dbltap', function(e) {
        e.cancelBubble = true;
        select('label', data.id);
        var input = document.getElementById('label-text');
        input.focus(); input.select();
    });
    t.on('dragstart', function() { select('label', data.id); });
    t.on('dragmove', function() { data.x = t.x(); data.y = t.y(); });
    t.on('dragend', markDirty);
    t.on('mouseenter', function() { setCursor('move'); });
    t.on('mouseleave', function() { setCursor(''); });
    nodesG.add(t);
}

function drawGroup(data) {
    var rect = new Konva.Rect({
        id: data.id, name: 'group-shape',
        x: data.x, y: data.y, width: data.width, height: data.height,
        fill: 'rgba(38, 139, 210, 0.06)', stroke: colors.selected, strokeWidth: 1.5,
        dash: [7, 4], cornerRadius: 8, draggable: true
    });
    var lbl = new Konva.Text({
        id: 'gl' + data.id, text: data.name, x: data.x + 8, y: data.y + 6,
        fontSize: 11, fill: colors.selected, listening: false
    });

    // Clicks on a group box are handled by the stage click handler, which
    // selects the group, or adds a node to it on double-click / in node mode.

    var start = null;
    rect.on('dragstart', function() {
        select('group', data.id);
        start = { x: rect.x(), y: rect.y(), members: {} };
        data.nodeIds.forEach(function(nid) {
            var n = getNode(nid);
            if (n) start.members[nid] = { x: n.x, y: n.y };
        });
    });
    rect.on('dragmove', function() {
        var dx = rect.x() - start.x, dy = rect.y() - start.y;
        data.x = rect.x(); data.y = rect.y();
        lbl.position({ x: data.x + 8, y: data.y + 6 });
        data.nodeIds.forEach(function(nid) {
            var n = getNode(nid), p = start.members[nid];
            if (!n || !p) return;
            n.x = p.x + dx; n.y = p.y + dy;
            konvaFor(nid).position({ x: n.x, y: n.y });
            updateEdgesFor(nid);
        });
    });
    rect.on('dragend', markDirty);
    rect.on('mouseenter', function() { if (mode === 'select') setCursor('move'); });
    rect.on('mouseleave', function() { setCursor(''); });

    groupsLayerG.add(rect, lbl);
}

function updateEdge(c) {
    var arrow = konvaFor(c.id), a = getNode(c.from), b = getNode(c.to);
    if (arrow && a && b) arrow.points(connectorPoints(a, b));
}

function updateEdgesFor(nodeId) {
    connectors.forEach(function(c) {
        if (c.from === nodeId || c.to === nodeId) updateEdge(c);
    });
}

// Fit a group's box around its members. With shrink=false it only grows,
// so a manual resize isn't undone by nudging a member node.
function fitGroup(gr, shrink) {
    var pad = 24, top = 16;
    var members = nodes.filter(function(n) { return gr.nodeIds.includes(n.id); });
    if (!members.length) return;
    var xs = members.map(function(n) { return n.x; }), ys = members.map(function(n) { return n.y; });
    var x1 = Math.min.apply(null, xs) - pad, y1 = Math.min.apply(null, ys) - pad - top;
    var x2 = Math.max.apply(null, xs) + pad, y2 = Math.max.apply(null, ys) + pad + 20;
    if (!shrink && gr.width > 0) {
        x1 = Math.min(x1, gr.x); y1 = Math.min(y1, gr.y);
        x2 = Math.max(x2, gr.x + gr.width); y2 = Math.max(y2, gr.y + gr.height);
    }
    gr.x = x1; gr.y = y1; gr.width = x2 - x1; gr.height = y2 - y1;
    var rect = konvaFor(gr.id), lbl = konvaFor('gl' + gr.id);
    if (rect) rect.setAttrs({ x: gr.x, y: gr.y, width: gr.width, height: gr.height });
    if (lbl) lbl.position({ x: gr.x + 8, y: gr.y + 6 });
    if (groupTransformer) groupTransformer.forceUpdate();
}

// Re-apply colours/highlights from current state. Cheap enough to call after any change.
function restyle() {
    var sel = selection || {};
    nodes.forEach(function(n) {
        var body = konvaFor(n.id).findOne('.node-body');
        var hl = (sel.type === 'node' && sel.id === n.id) || connectFrom === n.id || pendingGroupNodes.includes(n.id);
        body.fill(colors[n.status]);
        body.stroke(hl ? colors.selected : colors.text);
        body.strokeWidth(hl ? 3 : 0);
        body.shadowColor(colors.selected);
        body.shadowBlur(hl ? 10 : 0);
        body.shadowOpacity(hl ? 0.8 : 0);
    });
    connectors.forEach(function(c) {
        var a = konvaFor(c.id);
        var col = (sel.type === 'connector' && sel.id === c.id) ? colors.selected : colors[c.status];
        a.stroke(col); a.fill(col);
        a.strokeWidth(sel.id === c.id ? 3.5 : 2.5);
    });
    labels.forEach(function(l) {
        konvaFor(l.id).fill(sel.type === 'label' && sel.id === l.id ? colors.selected : colors.text);
    });
    if (groupTransformer && !(sel.type === 'group' && groupTransformer.groupId === sel.id)) {
        groupTransformer.destroy(); groupTransformer = null;
    }
    if (sel.type === 'group' && !groupTransformer) attachGroupTransformer(getGroup(sel.id));
    document.getElementById('tool-delete').disabled = !selection;
}

// ---------------------------------------------------------------- modes

var MODE_HINTS = {
    select: '',
    node: 'Click the canvas to place a node · Esc to cancel',
    connect: 'Click the source node, then the target · Esc to finish',
    label: 'Click the canvas to place a label · Esc to cancel',
    group: 'Click nodes to include in the group · Esc to cancel'
};

function setMode(m) {
    closeShapeMenu();
    if (mode === 'group' && m !== 'group') pendingGroupNodes = [];
    connectFrom = null;
    previewLine.visible(false);
    mode = m;

    document.querySelectorAll('.tool-sidebar .tool-btn').forEach(function(b) { b.classList.remove('active'); });
    var btn = document.getElementById('tool-' + m);
    if (btn) btn.classList.add('active');
    document.querySelector('.canvas-wrap').dataset.mode = m;

    var hint = document.getElementById('mode-hint');
    hint.textContent = MODE_HINTS[m];
    hint.classList.toggle('is-visible', !!MODE_HINTS[m]);

    if (m === 'group') {
        selection = null;
        updateGroupCount();
    }
    if (m !== 'select' && m !== 'group' && selection) selection = null;
    showPanel();
    restyle();
}

function updateConnectHint() {
    var hint = document.getElementById('mode-hint');
    if (mode !== 'connect') return;
    hint.textContent = connectFrom
        ? 'From "' + getNode(connectFrom).name + '" — now click the target node · Esc to cancel'
        : MODE_HINTS.connect;
}

function setCursor(c) { stage.container().style.cursor = c; }

// ---------------------------------------------------------------- selection + panel

function select(type, id) {
    selection = { type: type, id: id };
    showPanel();
    restyle();
}

function clearSelection() {
    selection = null;
    showPanel();
    restyle();
}

var PANELS = ['panel-empty', 'panel-node', 'panel-connector', 'panel-label', 'panel-group', 'panel-group-create'];
var PANEL_TITLES = {
    'panel-empty': 'Graph', 'panel-node': 'Node', 'panel-connector': 'Connector',
    'panel-label': 'Label', 'panel-group': 'Group', 'panel-group-create': 'New group'
};

function showPanel() {
    var id = 'panel-empty';
    if (mode === 'group') id = 'panel-group-create';
    else if (selection) id = 'panel-' + selection.type;
    PANELS.forEach(function(p) { document.getElementById(p).hidden = (p !== id); });
    document.getElementById('panel-header').textContent = PANEL_TITLES[id];

    if (!selection) return;
    if (selection.type === 'node') {
        var n = getNode(selection.id);
        document.getElementById('node-name').value = n.name;
        setStatusButtons('node', n.status);
        document.querySelectorAll('.shape-row .shape-dot').forEach(function(b) {
            b.classList.toggle('active', b.dataset.shape === n.shape);
        });
        setEditorValue(n.description || '');
    } else if (selection.type === 'connector') {
        var c = getConnector(selection.id);
        document.getElementById('connector-summary').textContent = getNode(c.from).name + '  →  ' + getNode(c.to).name;
        setStatusButtons('connector', c.status);
    } else if (selection.type === 'label') {
        document.getElementById('label-text').value = getLabel(selection.id).text;
    } else if (selection.type === 'group') {
        document.getElementById('group-name').value = getGroup(selection.id).name;
    }
}

function buildStatusRows() {
    document.querySelectorAll('.status-row').forEach(function(row) {
        STATUSES.forEach(function(s) {
            var b = document.createElement('button');
            b.className = 'status-pill';
            b.dataset.status = s;
            b.innerHTML = '<span class="status-dot" style="background:' + colors[s] + '"></span>' + STATUS_LABELS[s];
            b.onclick = function() { changeStatus(s); };
            row.appendChild(b);
        });
    });
}

function setStatusButtons(target, status) {
    document.querySelectorAll('.status-row[data-target="' + target + '"] .status-pill').forEach(function(b) {
        b.classList.toggle('active', b.dataset.status === status);
    });
}

// ---------------------------------------------------------------- canvas events

// Konva's dblclick fires for any two clicks within 400ms, even far apart or across
// modes, so track background double-clicks ourselves.
var lastBgClick = null;

stage.on('click tap', function(e) {
    if (e.evt.button === 2) return;
    var bg = isBackground(e.target);
    var screen = stage.getPointerPosition();
    var prev = lastBgClick;
    lastBgClick = (bg && mode === 'select') ? { t: Date.now(), x: screen.x, y: screen.y } : null;
    if (!bg) return;
    var p = pointerPos();
    var inGroup = e.target.hasName('group-shape') ? getGroup(e.target.id()) : null;
    if (mode === 'node') addNodeAt(p, inGroup);
    else if (mode === 'label') addLabelAt(p);
    else if (mode === 'connect') { connectFrom = null; previewLine.visible(false); updateConnectHint(); restyle(); }
    else if (mode === 'select') {
        if (prev && Date.now() - prev.t < 400 && Math.hypot(prev.x - screen.x, prev.y - screen.y) < 6) {
            lastBgClick = null;
            addNodeAt(p, inGroup);          // double-click: new node (joins the group if inside one)
        } else if (inGroup) {
            select('group', inGroup.id);
        } else {
            clearSelection();
        }
    }
});

stage.on('mousemove', function() {
    if (mode !== 'connect' || !connectFrom) return;
    var a = getNode(connectFrom), p = pointerPos();
    previewLine.points(connectorPoints(a, p).slice(0, 2).concat([p.x, p.y]));
    previewLine.visible(true);
});

stage.on('wheel', function(e) {
    e.evt.preventDefault();
    var old = stage.scaleX();
    var pointer = stage.getPointerPosition();
    var anchor = { x: (pointer.x - stage.x()) / old, y: (pointer.y - stage.y()) / old };
    var factor = Math.pow(1.0015, -e.evt.deltaY);       // scroll up = zoom in, smooth on trackpads
    var scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, old * factor));
    stage.scale({ x: scale, y: scale });
    stage.position({ x: pointer.x - anchor.x * scale, y: pointer.y - anchor.y * scale });
    updateZoomIndicator();
});

stage.on('dragend', function(e) { if (e.target === stage) updateZoomIndicator(); });

function updateZoomIndicator() {
    document.getElementById('zoom-indicator').textContent = Math.round(stage.scaleX() * 100) + '%';
}

function onNodeClick(n) {
    if (mode === 'connect') {
        if (!connectFrom) {
            connectFrom = n.id;
        } else if (connectFrom !== n.id) {
            addConnector(connectFrom, n.id);
            connectFrom = null;
            previewLine.visible(false);
        }
        updateConnectHint();
        restyle();
    } else if (mode === 'group') {
        var i = pendingGroupNodes.indexOf(n.id);
        if (i >= 0) pendingGroupNodes.splice(i, 1); else pendingGroupNodes.push(n.id);
        updateGroupCount();
        restyle();
    } else {
        setMode('select');
        select('node', n.id);
    }
}

// ---------------------------------------------------------------- create

function addNodeAt(p, group) {
    var n = new GraphNode(nextId('n', nodes), 'New Node', Math.round(p.x), Math.round(p.y), 'default', currentShape);
    nodes.push(n);
    drawNode(n);
    if (group) { group.nodeIds.push(n.id); fitGroup(group, false); }
    setMode('select');
    select('node', n.id);
    var input = document.getElementById('node-name');
    input.focus(); input.select();
    markDirty();
}

function addLabelAt(p) {
    var l = new Label(nextId('lb', labels), 'Label', Math.round(p.x), Math.round(p.y));
    labels.push(l);
    drawLabel(l);
    setMode('select');
    select('label', l.id);
    var input = document.getElementById('label-text');
    input.focus(); input.select();
    markDirty();
}

function addConnector(from, to) {
    var exists = connectors.find(function(c) { return c.from === from && c.to === to; });
    if (exists) { showToast('Those nodes are already connected.'); return; }
    var c = new Connector(nextId('c', connectors), from, to);
    connectors.push(c);
    drawConnector(c);
    markDirty();
}

function toggleShapeMenu(e) {
    e.stopPropagation();
    document.getElementById('shape-submenu').classList.toggle('is-open');
}

function closeShapeMenu() {
    document.getElementById('shape-submenu').classList.remove('is-open');
}

function selectShape(shape) {
    currentShape = shape;
    document.querySelectorAll('.submenu-shape').forEach(function(b) {
        b.classList.toggle('active', b.dataset.shape === shape);
    });
    setMode('node');
}

// ---------------------------------------------------------------- groups

function updateGroupCount() {
    var n = pendingGroupNodes.length;
    document.getElementById('group-selection-count').textContent = n + ' node' + (n === 1 ? '' : 's') + ' selected';
    document.getElementById('confirm-group').disabled = n < 1;
}

function confirmCreateGroup() {
    if (!pendingGroupNodes.length) return;
    var id = nextId('g', groups);
    var gr = new Group(id, 'Group ' + id.slice(1), pendingGroupNodes.slice());
    groups.push(gr);
    drawGroup(gr);
    fitGroup(gr, true);
    pendingGroupNodes = [];
    setMode('select');
    select('group', gr.id);
    var input = document.getElementById('group-name');
    input.focus(); input.select();
    markDirty();
}

function attachGroupTransformer(gr) {
    var rect = konvaFor(gr.id);
    groupTransformer = new Konva.Transformer({
        nodes: [rect], rotateEnabled: false, keepRatio: false,
        borderStroke: colors.selected, anchorStroke: colors.selected, anchorFill: '#073642',
        anchorSize: 8, anchorCornerRadius: 2,
        boundBoxFunc: function(oldBox, box) { return (box.width < 44 || box.height < 44) ? oldBox : box; }
    });
    groupTransformer.groupId = gr.id;
    layer.add(groupTransformer);
    groupTransformer.on('transform', function() {
        konvaFor('gl' + gr.id).position({ x: rect.x() + 8, y: rect.y() + 6 });
    });
    groupTransformer.on('transformend', function() {
        gr.x = rect.x(); gr.y = rect.y();
        gr.width = rect.width() * rect.scaleX();
        gr.height = rect.height() * rect.scaleY();
        rect.setAttrs({ width: gr.width, height: gr.height, scaleX: 1, scaleY: 1 });
        groupTransformer.forceUpdate();
        markDirty();
    });
}

function ungroupSelected() {
    if (selection && selection.type === 'group') deleteSelection();
}

// ---------------------------------------------------------------- edit selection

function changeStatus(status) {
    if (!selection) return;
    var item = selection.type === 'node' ? getNode(selection.id)
             : selection.type === 'connector' ? getConnector(selection.id) : null;
    if (!item) return;
    item.status = status;
    setStatusButtons(selection.type, status);
    restyle();
    markDirty();
}

function changeShape(shape) {
    if (!selection || selection.type !== 'node') return;
    var n = getNode(selection.id);
    n.shape = shape;
    var g = konvaFor(n.id);
    g.findOne('.node-body').destroy();
    var body = makeBody(shape);
    g.add(body);
    body.moveToBottom();
    showPanel();
    restyle();
    markDirty();
}

function reverseConnector() {
    if (!selection || selection.type !== 'connector') return;
    var c = getConnector(selection.id);
    var tmp = c.from; c.from = c.to; c.to = tmp;
    updateEdge(c);
    showPanel();
    markDirty();
}

document.getElementById('node-name').addEventListener('input', function() {
    if (!selection || selection.type !== 'node') return;
    renameNode(getNode(selection.id), this.value);
});

document.getElementById('label-text').addEventListener('input', function() {
    if (!selection || selection.type !== 'label') return;
    getLabel(selection.id).text = this.value;
    konvaFor(selection.id).text(this.value || ' ');
    markDirty();
});

document.getElementById('group-name').addEventListener('input', function() {
    if (!selection || selection.type !== 'group') return;
    getGroup(selection.id).name = this.value;
    konvaFor('gl' + selection.id).text(this.value);
    markDirty();
});

['node-name', 'label-text', 'group-name'].forEach(function(id) {
    document.getElementById(id).addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === 'Escape') this.blur();
    });
});

function renameNode(n, name) {
    n.name = name;
    konvaFor(n.id).findOne('.node-text').text(name);
    if (selection && selection.type === 'node' && selection.id === n.id) {
        var panelInput = document.getElementById('node-name');
        if (panelInput.value !== name) panelInput.value = name;
    }
    markDirty();
}

// ---------------------------------------------------------------- inline rename (right-click)

// No browser context menu on the canvas; right-click on a node renames it.
stage.on('contextmenu', function(e) { e.evt.preventDefault(); });

var inlineEditor = null;   // { input, node, original }

function startInlineRename(n) {
    finishInlineRename(true);
    setMode('select');
    select('node', n.id);

    var text = konvaFor(n.id).findOne('.node-text');
    var scale = stage.scaleX();
    var pos = text.getAbsolutePosition();   // top-left of the text box, in canvas pixels
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-rename';
    input.value = n.name;
    input.style.left = (pos.x - text.offsetX() * scale) + 'px';
    input.style.top = (pos.y - 3) + 'px';
    input.style.width = (text.width() * scale) + 'px';
    input.style.fontSize = Math.max(11, 12 * scale) + 'px';
    document.querySelector('.canvas-wrap').appendChild(input);
    text.visible(false);

    inlineEditor = { input: input, node: n, original: n.name, text: text };
    input.addEventListener('input', function() { renameNode(n, input.value); });
    input.addEventListener('keydown', function(e) {
        e.stopPropagation();
        if (e.key === 'Enter') finishInlineRename(true);
        else if (e.key === 'Escape') finishInlineRename(false);
    });
    input.addEventListener('blur', function() { finishInlineRename(true); });
    input.focus();
    input.select();
}

function finishInlineRename(commit) {
    if (!inlineEditor) return;
    var ed = inlineEditor;
    inlineEditor = null;                    // set first: removing the input fires blur
    if (!commit && ed.node.name !== ed.original) renameNode(ed.node, ed.original);
    ed.text.visible(true);
    ed.input.remove();
}

// The overlay doesn't follow the canvas, so close it if the view changes.
stage.on('wheel dragstart', function() { finishInlineRename(true); });

// ---------------------------------------------------------------- delete

function deleteSelection() {
    if (!selection) return;
    finishInlineRename(true);
    var id = selection.id;
    if (selection.type === 'node') {
        connectors = connectors.filter(function(c) {
            if (c.from === id || c.to === id) { konvaFor(c.id).destroy(); return false; }
            return true;
        });
        nodes = nodes.filter(function(n) { return n.id !== id; });
        konvaFor(id).destroy();
        groups = groups.filter(function(gr) {
            gr.nodeIds = gr.nodeIds.filter(function(nid) { return nid !== id; });
            if (gr.nodeIds.length) return true;
            removeGroupShapes(gr);
            return false;
        });
    } else if (selection.type === 'connector') {
        connectors = connectors.filter(function(c) { return c.id !== id; });
        konvaFor(id).destroy();
    } else if (selection.type === 'label') {
        labels = labels.filter(function(l) { return l.id !== id; });
        konvaFor(id).destroy();
    } else if (selection.type === 'group') {
        removeGroupShapes(getGroup(id));
        groups = groups.filter(function(gr) { return gr.id !== id; });
    }
    clearSelection();
    markDirty();
}

function removeGroupShapes(gr) {
    if (groupTransformer) { groupTransformer.destroy(); groupTransformer = null; }
    var r = konvaFor(gr.id), l = konvaFor('gl' + gr.id);
    if (r) r.destroy();
    if (l) l.destroy();
}

// ---------------------------------------------------------------- view

function contentRect() {
    if (!nodes.length && !labels.length && !groups.length) return null;
    return [groupsLayerG, edgesG, nodesG].reduce(function(acc, g) {
        if (!g.hasChildren()) return acc;
        var b = g.getClientRect({ relativeTo: layer });
        if (!acc) return b;
        var x1 = Math.min(acc.x, b.x), y1 = Math.min(acc.y, b.y);
        return {
            x: x1, y: y1,
            width: Math.max(acc.x + acc.width, b.x + b.width) - x1,
            height: Math.max(acc.y + acc.height, b.y + b.height) - y1
        };
    }, null);
}

function fitView() {
    var r = contentRect();
    if (!r) { stage.scale({ x: 1, y: 1 }); stage.position({ x: 0, y: 0 }); updateZoomIndicator(); return; }
    var pad = 60;
    var scale = Math.min((stage.width() - pad * 2) / Math.max(r.width, 1),
                         (stage.height() - pad * 2) / Math.max(r.height, 1), 1.5);
    scale = Math.max(MIN_SCALE, scale);
    stage.scale({ x: scale, y: scale });
    stage.position({
        x: stage.width() / 2 - (r.x + r.width / 2) * scale,
        y: stage.height() / 2 - (r.y + r.height / 2) * scale
    });
    updateZoomIndicator();
}

// Render the whole graph (not just the visible viewport) to a PNG data URL.
function renderDiagram() {
    var r = contentRect();
    if (!r) return null;
    var pad = 30;
    var saved = { scale: stage.scale(), pos: stage.position(), sel: selection };
    selection = null; connectFrom = null; previewLine.visible(false);
    restyle();
    stage.scale({ x: 1, y: 1 }); stage.position({ x: 0, y: 0 });
    var bg = new Konva.Rect({ x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2, fill: colors.bg });
    layer.add(bg); bg.moveToBottom();
    var url = stage.toDataURL({ x: bg.x(), y: bg.y(), width: bg.width(), height: bg.height(), pixelRatio: 2 });
    bg.destroy();
    stage.scale(saved.scale); stage.position(saved.pos);
    selection = saved.sel;
    restyle();
    return url;
}

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', function(e) {
    var t = e.target;
    var typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveGraph();
        return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
        case 'Escape':
            if (mode === 'connect' && connectFrom) { connectFrom = null; previewLine.visible(false); updateConnectHint(); restyle(); }
            else if (mode !== 'select') setMode('select');
            else clearSelection();
            break;
        case 'Delete': case 'Backspace':
            e.preventDefault(); deleteSelection(); break;
        case 'v': setMode('select'); break;
        case 'n': setMode('node'); break;
        case 'c': setMode('connect'); break;
        case 'l': setMode('label'); break;
        case 'g': setMode('group'); break;
        case 'f': fitView(); break;
        case 'Enter': if (mode === 'group') confirmCreateGroup(); break;
    }
});

document.addEventListener('click', function(e) {
    var group = document.getElementById('add-node-group');
    if (group && !group.contains(e.target)) closeShapeMenu();
});

// ---------------------------------------------------------------- init

function initGraph() {
    groups.forEach(drawGroup);
    nodes.forEach(drawNode);
    connectors.forEach(drawConnector);
    labels.forEach(drawLabel);
    groups.forEach(function(gr) { if (!gr.width || !gr.height) fitGroup(gr, true); });
    buildStatusRows();
    setMode('select');
    fitView();
}
