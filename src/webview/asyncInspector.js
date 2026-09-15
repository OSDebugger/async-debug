(function() {
    const vscode = acquireVsCodeApi();
    let treeData = window.treeData || [];
    let currentTreeMode = window.treeMode === 'snapshot' ? 'snapshot' : 'observer';
    let viewRequestId = window.treeViewRequestId || 0;
    let selectedNode = null;

    // Grouped whitelist state
    let groupedWhitelist = null;
    let enabledCrates = new Set();
    let asyncOnly = false;

    // Observer projects the cumulative History Store from the selected Trace Root.
    let observerRoot = window.observerRoot || null;

    // Flat candidates fallback
    let candidates = [];

    // Initialize UI
    function init() {
        renderTree(treeData);
        renderTreeViewState();
        renderObserverRoot();
        setupEventListeners();
        requestCandidates();
    }

    function setupEventListeners() {
        document.getElementById('resetBtn').addEventListener('click', () => {
            currentTreeMode = 'observer';
            ++viewRequestId;
            selectedNode = null;
            observerRoot = null;
            treeData = [];
            groupedWhitelist = null;
            enabledCrates = new Set();
            candidates = [];
            renderObserverRoot();
            renderTreeViewState();
            renderTree(treeData);
            renderGroupedWhitelist(null);
            vscode.postMessage({ command: 'reset', viewRequestId });
        });

        document.getElementById('genWhitelistBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'genWhitelist' });
        });

        document.getElementById('snapshotBtn').addEventListener('click', () => {
            selectTreeMode('snapshot');
            vscode.postMessage({ command: 'snapshot', viewRequestId });
        });

        document.getElementById('observerBtn').addEventListener('click', () => {
            selectTreeMode('observer');
            vscode.postMessage({ command: 'refreshObserver', viewRequestId });
        });

        document.getElementById('clearHistoryBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'clearHistory' });
        });
    }

    function selectTreeMode(mode) {
        currentTreeMode = mode;
        ++viewRequestId;
        treeData = [];
        selectedNode = null;
        renderTreeViewState();
        renderTree(treeData);
    }

    function renderTreeViewState() {
        const observerBtn = document.getElementById('observerBtn');
        const snapshotBtn = document.getElementById('snapshotBtn');
        const title = document.getElementById('treeViewTitle');
        observerBtn?.classList.toggle('active', currentTreeMode === 'observer');
        snapshotBtn?.classList.toggle('active', currentTreeMode === 'snapshot');
        if (title) {
            title.textContent = `Async Inspector — ${currentTreeMode === 'observer' ? 'Observer' : 'Snapshot'}`;
        }
    }

    // -----------------------------------------------------------------------
    // Tree rendering
    // -----------------------------------------------------------------------

    function renderTree(roots) {
        const container = document.getElementById('treeContainer');
        container.innerHTML = '';

        if (roots.length === 0) {
            container.innerHTML = currentTreeMode === 'observer'
                ? '<div class="placeholder-text">No Observer tree available. Select a Trace Root from the whitelist.</div>'
                : '<div class="placeholder-text">No Snapshot tree available. Pause the program and click Snapshot.</div>';
            return;
        }

        roots.forEach(root => {
            const rootElement = createTreeNode(root, 0);
            container.appendChild(rootElement);
        });
    }

    function createTreeNode(node, depth) {
        const div = document.createElement('div');
        div.className = `tree-node ${node.type} ${selectedNode === node.func ? 'selected' : ''}`;
        div.style.marginLeft = `${depth * 20}px`;

        const content = document.createElement('div');
        content.className = 'node-content';

        const typeBadge = document.createElement('span');
        typeBadge.className = 'node-type';
        typeBadge.textContent = node.type === 'async' ? 'ASYNC' : 'SYNC';
        typeBadge.style.color = node.type === 'async' ? '#ff6b6b' : '#51cf66';

        const info = document.createElement('div');
        info.className = 'node-info';

        const func = document.createElement('div');
        func.className = 'node-func';
        func.textContent = node.func;

        info.appendChild(func);
        content.appendChild(typeBadge);
        content.appendChild(info);
        div.appendChild(content);

        // Add click handler
        div.addEventListener('click', (e) => {
            e.stopPropagation();
            selectNode(node.func);
            vscode.postMessage({
                command: 'selectNode',
                cid: node.cid,
                symbol: node.func,
                snapshotIndex: node.snapshotIndex,
                mode: currentTreeMode,
                viewRequestId,
            });
        });

        // Render children
        if (node.children && node.children.length > 0) {
            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'node-children';
            node.children.forEach(child => {
                childrenContainer.appendChild(createTreeNode(child, depth + 1));
            });
            div.appendChild(childrenContainer);
        }

        return div;
    }

    function selectNode(nodeKey) {
        selectedNode = nodeKey;
        renderTree(treeData);
    }

    function requestCandidates() {
        vscode.postMessage({ command: 'refreshCandidates' });
    }

    // -----------------------------------------------------------------------
    // Observer Root section
    // -----------------------------------------------------------------------

    function renderObserverRoot() {
        const display = document.getElementById('traceRootDisplay');
        if (!display) return;

        if (!observerRoot) {
            display.textContent = 'No trace root set. Use "Trace" in the whitelist to select one.';
            return;
        }

        display.textContent = observerRoot;
    }

    function setObserverRoot(symbol) {
        observerRoot = symbol || null;
        renderObserverRoot();
    }

    // -----------------------------------------------------------------------
    // Grouped Whitelist rendering
    // -----------------------------------------------------------------------

    function renderGroupedWhitelist(grouped) {
        const container = document.getElementById('whitelistContainer');
        if (!container) return;
        container.innerHTML = '';

        if (!grouped || !grouped.crates || Object.keys(grouped.crates).length === 0) {
            container.innerHTML = '<div class="placeholder-text">No whitelist generated. Click "Gen Whitelist" first.</div>';
            return;
        }

        // Sort: user crates first, then framework crates, alphabetical within each group
        const crateNames = Object.keys(grouped.crates);
        const userCrates = crateNames.filter(c => grouped.crates[c].is_user_crate).sort();
        const frameworkCrates = crateNames.filter(c => !grouped.crates[c].is_user_crate).sort();

        // User crates section
        if (userCrates.length > 0) {
            const header = document.createElement('div');
            header.className = 'section-label';
            header.textContent = 'Your Crates';
            container.appendChild(header);
            userCrates.forEach(name => renderCrateGroup(container, name, grouped.crates[name], false));
        }

        // Framework crates section
        if (frameworkCrates.length > 0) {
            const header = document.createElement('div');
            header.className = 'section-label';
            header.textContent = 'Framework / Library';
            container.appendChild(header);
            frameworkCrates.forEach(name => renderCrateGroup(container, name, grouped.crates[name], false));
        }

        // Filtering takes effect only when the user explicitly applies.
        const asyncOnlyLabel = document.createElement('label');
        const asyncOnlyCheckbox = document.createElement('input');
        asyncOnlyCheckbox.type = 'checkbox';
        asyncOnlyCheckbox.checked = asyncOnly;
        asyncOnlyCheckbox.addEventListener('change', () => {
            asyncOnly = asyncOnlyCheckbox.checked;
        });
        asyncOnlyLabel.appendChild(asyncOnlyCheckbox);
        asyncOnlyLabel.appendChild(document.createTextNode(' Async only'));
        container.appendChild(asyncOnlyLabel);

        // Apply button
        const applyBtn = document.createElement('button');
        applyBtn.className = 'btn apply-btn';
        applyBtn.textContent = 'Apply Whitelist';
        applyBtn.addEventListener('click', () => {
            vscode.postMessage({
                command: 'updateWhitelistCrates',
                enabledCrates: Array.from(enabledCrates),
                asyncOnly
            });
        });
        container.appendChild(applyBtn);
    }

    function renderCrateGroup(container, crateName, crateData, defaultExpanded) {
        const group = document.createElement('div');
        group.className = `crate-group ${crateData.is_user_crate ? 'user-crate' : ''}`;

        const isEnabled = enabledCrates.has(crateName);
        const isExpanded = defaultExpanded;

        // 统计异步/同步函数数量
        const asyncCount = crateData.symbols.filter(s => s.kind === 'async').length;
        const syncCount = crateData.symbols.filter(s => s.kind !== 'async').length;

        // Header
        const header = document.createElement('div');
        header.className = 'crate-group-header';

        const chevron = document.createElement('span');
        chevron.className = `crate-chevron ${isExpanded ? '' : 'collapsed'}`;
        chevron.textContent = '\u25BC'; // ▼

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = isEnabled;
        checkbox.addEventListener('change', (e) => {
            e.stopPropagation();
            if (checkbox.checked) {
                enabledCrates.add(crateName);
            } else {
                enabledCrates.delete(crateName);
            }
        });
        checkbox.addEventListener('click', (e) => e.stopPropagation());

        const nameSpan = document.createElement('span');
        nameSpan.className = 'crate-name';
        nameSpan.textContent = crateName;

        const badge = document.createElement('span');
        badge.className = 'crate-badge';
        // 展示异步/同步数量
        const parts = [];
        if (asyncCount > 0) parts.push(`${asyncCount} async`);
        if (syncCount > 0) parts.push(`${syncCount} sync`);
        badge.textContent = parts.join(', ');

        header.appendChild(chevron);
        header.appendChild(checkbox);
        header.appendChild(nameSpan);
        header.appendChild(badge);

        // Body (collapsible)
        const body = document.createElement('div');
        body.className = `crate-group-body ${isExpanded ? '' : 'collapsed'}`;

        // Toggle expand/collapse on header click
        header.addEventListener('click', () => {
            const isCollapsed = body.classList.contains('collapsed');
            body.classList.toggle('collapsed');
            chevron.classList.toggle('collapsed', !isCollapsed);
        });

        // 先渲染异步函数，再渲染同步函数
        const asyncSymbols = crateData.symbols.filter(s => s.kind === 'async');
        const syncSymbols = crateData.symbols.filter(s => s.kind !== 'async');

        if (asyncSymbols.length > 0) {
            const subLabel = document.createElement('div');
            subLabel.className = 'sub-section-label';
            subLabel.textContent = 'Async';
            body.appendChild(subLabel);
            asyncSymbols.forEach(sym => renderSymbolItem(body, sym));
        }

        if (syncSymbols.length > 0) {
            const subLabel = document.createElement('div');
            subLabel.className = 'sub-section-label';
            subLabel.textContent = 'Sync';
            body.appendChild(subLabel);
            syncSymbols.forEach(sym => renderSymbolItem(body, sym));
        }

        group.appendChild(header);
        group.appendChild(body);
        container.appendChild(group);
    }

    function renderSymbolItem(container, sym) {
        const item = document.createElement('div');
        item.className = 'symbol-item';

        const kindBadge = document.createElement('span');
        kindBadge.className = `symbol-kind-badge ${sym.kind === 'async' ? 'kind-async' : 'kind-sync'}`;
        kindBadge.textContent = sym.kind === 'async' ? 'A' : 'S';

        const label = document.createElement('label');
        label.textContent = sym.name;
        label.title = sym.file ? `${sym.file}:${sym.line || '?'}` : sym.name;

        const actions = document.createElement('div');
        actions.className = 'symbol-actions';

        const observerBtn = document.createElement('button');
        observerBtn.className = 'candidate-btn';
        observerBtn.textContent = 'Trace';
        observerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setObserverRoot(sym.name);
            vscode.postMessage({ command: 'trace', symbol: sym.name });
        });

        const locateBtn = document.createElement('button');
        locateBtn.className = 'candidate-btn';
        locateBtn.textContent = 'Locate';
        locateBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'locate', symbol: sym.name });
        });

        actions.appendChild(observerBtn);
        actions.appendChild(locateBtn);
        item.appendChild(kindBadge);
        item.appendChild(label);
        item.appendChild(actions);
        container.appendChild(item);
    }

    // -----------------------------------------------------------------------
    // Flat candidates rendering (fallback for old whitelist format)
    // -----------------------------------------------------------------------

    function renderCandidates(candidatesList) {
        const container = document.getElementById('whitelistContainer');
        if (!container) return;
        container.innerHTML = '';

        if (candidatesList.length === 0) {
            container.innerHTML = '<div class="placeholder-text">No candidates. Generate whitelist first.</div>';
            return;
        }

        candidatesList.forEach(symbol => {
            const item = document.createElement('div');
            item.className = 'candidate-item';

            const symbolSpan = document.createElement('span');
            symbolSpan.className = 'candidate-symbol';
            symbolSpan.textContent = symbol;

            const actions = document.createElement('div');
            actions.className = 'candidate-actions';

            const observerBtn = document.createElement('button');
            observerBtn.className = 'candidate-btn';
            observerBtn.textContent = 'Trace';
            observerBtn.addEventListener('click', () => {
                setObserverRoot(symbol);
                vscode.postMessage({ command: 'trace', symbol: symbol });
            });

            const locateBtn = document.createElement('button');
            locateBtn.className = 'candidate-btn';
            locateBtn.textContent = 'Locate';
            locateBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'locate', symbol: symbol });
            });

            actions.appendChild(observerBtn);
            actions.appendChild(locateBtn);
            item.appendChild(symbolSpan);
            item.appendChild(actions);
            container.appendChild(item);
        });
    }

    // -----------------------------------------------------------------------
    // Message listener
    // -----------------------------------------------------------------------

    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
            case 'updateTreeView':
                if (message.viewRequestId !== undefined && message.viewRequestId !== viewRequestId) break;
                observerRoot = message.observerRoot || null;
                renderTreeViewState();
                renderObserverRoot();
                break;
            case 'updateTree':
                // Already-posted replies can arrive after another click, even
                // when the user has returned to the same mode.
                if (message.mode !== currentTreeMode || message.viewRequestId !== viewRequestId) break;
                treeData = message.treeData || [];
                selectedNode = null;
                renderTree(treeData);
                break;
            case 'updateCandidates':
                candidates = message.candidates;
                renderCandidates(candidates);
                break;
            case 'updateGroupedWhitelist':
                groupedWhitelist = message.groupedWhitelist;
                // 默认不选中任何 crate，用户按需开启
                enabledCrates = new Set();
                renderGroupedWhitelist(groupedWhitelist);
                break;
        }
    });

    // Initialize on load
    init();
})();
