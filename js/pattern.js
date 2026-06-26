/**
 * PwdPal — Pattern Lock Grid Component (v3)
 * 
 * 3×3 grid with Google-colored nodes.
 * Each node cycles through blue, red, yellow, green.
 */

const PatternLock = (() => {

    const GRID_SIZE = 3;
    const TOTAL_NODES = GRID_SIZE * GRID_SIZE;
    let MIN_NODES = 3;

    // Read colors from CSS custom properties (supports dark mode)
    function getColors() {
        const style = getComputedStyle(document.documentElement);
        return {
            node: style.getPropertyValue('--node-color').trim() || '#9aa0a6',
            selected: style.getPropertyValue('--node-selected').trim() || '#5f6368',
            line: style.getPropertyValue('--node-line').trim() || '#dadce0',
            ring: style.getPropertyValue('--node-ring').trim() || '#dadce0'
        };
    }

    let canvas, ctx;
    let nodes = [];
    let selectedNodes = [];
    let isDrawing = false;
    let currentPointer = { x: 0, y: 0 };
    let containerEl;
    let onCompleteCallback = null;
    let onDrawStartCallback = null;
    let onRejectCallback = null;

    let nodeRadius = 0;
    let nodeGap = 0;
    let canvasSize = 0;
    let dpr = 1;

    function init(container, onComplete) {
        containerEl = container;
        onCompleteCallback = onComplete;

        canvas = document.createElement('canvas');
        canvas.className = 'pattern-canvas';
        container.insertBefore(canvas, container.firstChild);

        ctx = canvas.getContext('2d');
        dpr = window.devicePixelRatio || 1;

        resize();
        buildNodes();
        draw();

        canvas.addEventListener('mousedown', onPointerDown);
        canvas.addEventListener('mousemove', onPointerMove);
        canvas.addEventListener('mouseup', onPointerUp);
        canvas.addEventListener('mouseleave', onPointerUp);

        canvas.addEventListener('touchstart', onTouchStart, { passive: false });
        canvas.addEventListener('touchmove', onTouchMove, { passive: false });
        canvas.addEventListener('touchend', onTouchEnd);
        canvas.addEventListener('touchcancel', onTouchEnd);

        window.addEventListener('resize', () => {
            resize();
            buildNodes();
            draw();
        });
    }

    function resize() {
        const rect = containerEl.getBoundingClientRect();
        // Cap derived from the --pattern-size CSS custom property (single source
        // of truth shared with .pattern-container's width/height).
        const cssCap = parseInt(
            getComputedStyle(document.documentElement).getPropertyValue('--pattern-size'),
            10
        ) || 300;
        canvasSize = Math.min(rect.width, rect.height, cssCap);
        canvas.style.width = canvasSize + 'px';
        canvas.style.height = canvasSize + 'px';
        canvas.width = canvasSize * dpr;
        canvas.height = canvasSize * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        nodeRadius = canvasSize * 0.072;
        nodeGap = canvasSize / (GRID_SIZE + 1);
    }

    function buildNodes() {
        nodes = [];
        for (let row = 0; row < GRID_SIZE; row++) {
            for (let col = 0; col < GRID_SIZE; col++) {
                const id = row * GRID_SIZE + col;
                nodes.push({
                    id,
                    x: nodeGap * (col + 1),
                    y: nodeGap * (row + 1),
                    selected: false
                });
            }
        }
    }

    // ── Drawing ──

    function draw() {
        const colors = getColors();
        ctx.clearRect(0, 0, canvasSize, canvasSize);

        // Draw connecting lines
        if (selectedNodes.length > 0) {
            ctx.beginPath();
            ctx.strokeStyle = colors.line;
            ctx.lineWidth = 2.5;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            const first = nodes[selectedNodes[0]];
            ctx.moveTo(first.x, first.y);

            for (let i = 1; i < selectedNodes.length; i++) {
                const node = nodes[selectedNodes[i]];
                ctx.lineTo(node.x, node.y);
            }

            if (isDrawing) {
                ctx.lineTo(currentPointer.x, currentPointer.y);
            }

            ctx.stroke();
        }

        // Draw nodes
        for (const node of nodes) {
            const isSelected = selectedNodes.includes(node.id);
            drawNode(node, isSelected, colors);
        }
    }

    function drawNode(node, isSelected, colors) {
        if (isSelected) {
            // Selected: dark halo + ring + dot
            ctx.beginPath();
            ctx.arc(node.x, node.y, nodeRadius + 4, 0, Math.PI * 2);
            ctx.fillStyle = colors.selected;
            ctx.globalAlpha = 0.08;
            ctx.fill();
            ctx.globalAlpha = 1;

            ctx.beginPath();
            ctx.arc(node.x, node.y, nodeRadius, 0, Math.PI * 2);
            ctx.strokeStyle = colors.selected;
            ctx.lineWidth = 2.5;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(node.x, node.y, nodeRadius * 0.45, 0, Math.PI * 2);
            ctx.fillStyle = colors.selected;
            ctx.fill();
        } else {
            // Unselected: light ring + tiny dot
            ctx.beginPath();
            ctx.arc(node.x, node.y, nodeRadius, 0, Math.PI * 2);
            ctx.strokeStyle = colors.ring;
            ctx.lineWidth = 1.5;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(node.x, node.y, nodeRadius * 0.22, 0, Math.PI * 2);
            ctx.fillStyle = colors.node;
            ctx.globalAlpha = 0.5;
            ctx.fill();
            ctx.globalAlpha = 1;
        }
    }

    // ── Hit detection ──

    function getNodeAtPoint(x, y) {
        const hitRadius = nodeRadius * 2.5;
        for (const node of nodes) {
            const dx = x - node.x;
            const dy = y - node.y;
            if (dx * dx + dy * dy <= hitRadius * hitRadius) {
                return node;
            }
        }
        return null;
    }

    function getCanvasCoords(e) {
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    // ── Pointer ──

    function onPointerDown(e) {
        const coords = getCanvasCoords(e);
        const node = getNodeAtPoint(coords.x, coords.y);
        if (node) {
            isDrawing = true;
            selectedNodes = [node.id];
            node.selected = true;
            currentPointer = coords;
            if (onDrawStartCallback) onDrawStartCallback();
            draw();
        }
    }

    function onPointerMove(e) {
        if (!isDrawing) return;
        const coords = getCanvasCoords(e);
        currentPointer = coords;
        const node = getNodeAtPoint(coords.x, coords.y);
        if (node && !selectedNodes.includes(node.id)) {
            selectedNodes.push(node.id);
            node.selected = true;
        }
        draw();
    }

    function onPointerUp() {
        if (!isDrawing) return;
        isDrawing = false;
        if (selectedNodes.length >= MIN_NODES) {
            if (onCompleteCallback) onCompleteCallback([...selectedNodes]);
            draw();
        } else {
            if (onRejectCallback) onRejectCallback(selectedNodes.length);
            reset();
        }
    }

    function onTouchStart(e) {
        e.preventDefault();
        const t = e.touches[0];
        onPointerDown({ clientX: t.clientX, clientY: t.clientY });
    }

    function onTouchMove(e) {
        e.preventDefault();
        const t = e.touches[0];
        onPointerMove({ clientX: t.clientX, clientY: t.clientY });
    }

    function onTouchEnd() { onPointerUp(); }

    function reset() {
        selectedNodes = [];
        for (const n of nodes) n.selected = false;
        isDrawing = false;
        draw();
    }

    function getPattern() { return [...selectedNodes]; }

    return { init, reset, getPattern, updateTheme: draw, onDrawStart: fn => { onDrawStartCallback = fn; }, onReject: fn => { onRejectCallback = fn; }, setMinNodes: n => { MIN_NODES = n; } };
})();
