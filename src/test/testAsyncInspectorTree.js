// Run after compile: node src/test/testAsyncInspectorTree.js [P0-fixtures.json]
// Real Panel + webview script; only VS Code, DOM and DAP transport are mocked.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const root = path.resolve(__dirname, '../..');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

class Element {
    constructor(tag) {
        this.tag = tag;
        this.children = [];
        this.listeners = {};
        this.style = {};
        this.className = '';
        this.textContent = '';
        this.classList = {
            contains: name => this.className.split(/\s+/).includes(name),
            add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].join(' ').trim(); },
            remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
            toggle: (name, force) => {
                const add = force === undefined ? !this.classList.contains(name) : force;
                this.classList[add ? 'add' : 'remove'](name);
                return add;
            },
        };
    }
    set innerHTML(value) { this.children = []; this._html = value; this.textContent = ''; }
    get innerHTML() { return this._html || ''; }
    appendChild(child) { this.children.push(child); return child; }
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
    setAttribute(name, value) { this[name] = value; }
    fire(name) { for (const listener of this.listeners[name] || []) listener({ stopPropagation() {} }); }
}
const all = node => [node, ...(node.children || []).flatMap(all)];

function snapshotFixture(name = 'snapshot', observed = true) {
    const nodes = ['parent', 'child'].map((label, index) => ({
        node_id: `async:${index + 1}`, cid: index + 1, kind: 'async', function: `${name}::${label}`,
        future_address: `0x${1000 + index * 10}`, future_type: label, future_type_source: 'dwarf',
        poll: { sequence: 2, state: 3, status: 'ok', error: null, source: 'dwarf' },
        edge_from_parent: index === 0 ? null : observed ? 'await' : 'unknown',
        active: true, privilege: 'unknown', origin: 'runtime', physical: false,
        source: { name: path.basename(__filename), path: __filename, line: index + 1 },
    }));
    nodes[1].relation_from_parent = {
        kind: observed ? 'await' : 'unknown', confidence: observed ? 'observed' : 'unknown',
        parent_cid: 1, child_cid: 2, child_future_address: nodes[1].future_address,
        evidence: observed ? ['current-revalidated'] : [],
    };
    return { session_id: 'fixture', generation: 1, thread_id: 1, empty: false,
        privilege: 'unknown', transition: { kind: 'none', symbol: null, pc: null, path: [] }, async_path: nodes };
}
function observerFixture(name = 'observer') {
    const node = (label, cid) => ({ type: 'async', func: `${name}::${label}`, cid,
        addr: `0x${1000 + cid}`, poll: 2, state: 3, active: true, enter_count: 2,
        source: { path: __filename, line: cid }, children: [] });
    const parent = node('parent', 1);
    parent.children.push(node('child', 2));
    return { type: 'observer_tree', observer_root: parent.func, roots: [parent], relation_annotations: [] };
}

function harness(fixtures = {}) {
    const h = { requests: [], outbound: [], inbound: [], errors: [], opened: [], queues: new Map(), ids: new Map() };
    h.snapshot = fixtures.validSnapshot || snapshotFixture();
    // Existing P0 fixture calls this historyTree; its payload is an Observer projection.
    h.observerTree = fixtures.historyTree || observerFixture();
    const disposable = { dispose() {} };
    let panelMessage, sessionChanged, receive, mounted = false;
    h.queue = (command, value) => {
        if (!h.queues.has(command)) h.queues.set(command, []);
        h.queues.get(command).push(value);
    };
    h.session = {
        type: 'ardb', id: 'session-1',
        async customRequest(command, args) {
            h.requests.push({ command, args: clone(args) });
            const queue = h.queues.get(command);
            if (queue?.length) return await queue.shift();
            if (command === 'ardb-get-snapshot') return { snapshot: clone(h.snapshot) };
            if (command === 'ardb-get-observer-tree') return { observerTree: clone(h.observerTree) };
            if (command === 'ardb-get-whitelist-grouped') return { groupedWhitelist: { crates: {} } };
            if (command === 'ardb-get-whitelist-candidates') return { candidates: [] };
            if (command === 'ardb-clear-history-tree') return { history: { roots: [], cleared: true } };
            if (command === 'ardb-execute-command') return { result: `Line 2 of "${__filename}"` };
            return {};
        },
    };
    const uri = fsPath => ({ fsPath, toString: () => fsPath });
    const webview = {
        _html: '',
        set html(value) { this._html = value; if (mounted) mount(); },
        get html() { return this._html; },
        asWebviewUri: value => value,
        onDidReceiveMessage(callback) { panelMessage = callback; return disposable; },
        postMessage(message) {
            h.inbound.push(clone(message));
            if (receive) receive({ data: clone(message) });
            return Promise.resolve(true);
        },
    };
    const vscodePanel = { webview, onDidDispose: () => disposable, reveal() {}, dispose() {} };
    const vscode = {
        Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
        ViewColumn: { One: 1, Two: 2 },
        Range: class { constructor(...values) { this.values = values; } },
        debug: { activeDebugSession: h.session, onDidChangeActiveDebugSession(callback) { sessionChanged = callback; return disposable; } },
        workspace: { workspaceFolders: [{ uri: uri(root) }], async openTextDocument(value) { return { uri: value }; } },
        window: { createWebviewPanel: () => vscodePanel,
            async showTextDocument(document, options) { h.opened.push({ file: document.uri.fsPath, options }); },
            showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {} },
    };
    const panelFile = path.join(root, 'out/webview/asyncInspectorPanel.js');
    assert.ok(fs.existsSync(panelFile), 'Run npm run compile before this test');
    delete require.cache[require.resolve(panelFile)];
    const previousLoad = Module._load;
    let exports;
    try {
        Module._load = function (name, parent, isMain) {
            return name === 'vscode' ? vscode : previousLoad.call(this, name, parent, isMain);
        };
        exports = require(panelFile);
    } finally { Module._load = previousLoad; }
    h.buildForest = exports.buildCurrentExecutionForest;
    h.panel = exports.AsyncInspectorPanel.createOrShow(uri(root));
    sessionChanged(h.session);
    function mount() {
        h.ids = new Map();
        for (const match of webview.html.matchAll(/<([a-z0-9]+)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
            const element = new Element(match[1]);
            element.className = match[2].match(/\bclass="([^"]*)"/)?.[1] || '';
            element.textContent = webview.html.slice(match.index + match[0].length).match(/^([^<]*)</)?.[1].trim() || '';
            h.ids.set(match[3], element);
        }
        const window = { addEventListener: (_name, callback) => { receive = callback; } };
        const context = vm.createContext({ window, console,
            document: { getElementById: id => h.ids.get(id), createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }) },
            acquireVsCodeApi: () => ({ postMessage(message) {
                h.outbound.push(clone(message));
                Promise.resolve(panelMessage(clone(message))).catch(error => h.errors.push(error));
            } }),
        });
        for (const match of webview.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
            if (match[1].trim()) vm.runInContext(match[1], context);
        }
        vm.runInContext(fs.readFileSync(path.join(root, 'src/webview/asyncInspector.js'), 'utf8'), context);
    }
    mount();
    mounted = true;
    h.click = id => { assert.ok(h.ids.has(id), `HTML must contain ${id}`); h.ids.get(id).fire('click'); };
    h.settle = async () => { await tick(); await tick(); };
    h.stop = (reason = 'breakpoint') => h.panel.onDebugStopped(h.session, { reason });
    h.switchSession = () => { h.session = { ...h.session, id: 'session-2' }; sessionChanged(h.session); };
    h.functions = () => all(h.ids.get('treeContainer')).filter(element => element.className === 'node-func').map(element => element.textContent);
    h.mode = () => h.ids.get('snapshotBtn').classList.contains('active') ? 'snapshot' : 'observer';
    h.treeMessages = () => h.inbound.filter(message => message.command === 'updateTree');
    h.lastTree = () => h.treeMessages().at(-1);
    h.deliver = message => receive({ data: clone(message) });
    h.close = () => h.panel.dispose();
    return h;
}

let scenarios = 0;
async function check(name, body, fixtures) {
    const h = harness(fixtures);
    try {
        await h.settle();
        await body(h);
        assert.ok(h.errors.every(error => error.message.startsWith('expected ')),
            `Unexpected Panel errors: ${h.errors.map(error => error.stack).join('\n')}`);
        assert.ok(!h.requests.some(request => request.command === 'ardb-get-history-tree'),
            'The main Observer tree must use ardb-get-observer-tree');
        scenarios++;
        console.log(`PASS ${name}`);
    } finally { h.close(); }
}
function assertView(h, mode, functions) {
    assert.equal(h.mode(), mode);
    assert.equal(h.ids.get('treeViewTitle').textContent, `Async Inspector — ${mode === 'snapshot' ? 'Snapshot' : 'Observer'}`);
    assert.deepStrictEqual(h.functions(), functions);
}

async function main() {
    await check('Observer / Snapshot buttons share the renderer and switch O → S → O → S', async h => {
        assert.equal(h.ids.get('observerBtn').textContent, 'Observer');
        assert.equal(h.ids.get('snapshotBtn').textContent, 'Snapshot');
        assert.equal(h.ids.get('clearHistoryBtn').textContent, 'Clear History');
        const container = h.ids.get('treeContainer');
        for (const [id, command, mode, prefix] of [
            ['observerBtn', 'refreshObserver', 'observer', 'observer'], ['snapshotBtn', 'snapshot', 'snapshot', 'snapshot'],
            ['observerBtn', 'refreshObserver', 'observer', 'observer'], ['snapshotBtn', 'snapshot', 'snapshot', 'snapshot'],
        ]) {
            h.click(id);
            assert.equal(h.outbound.at(-1).command, command);
            assertView(h, mode, []);
            await h.settle();
            assertView(h, mode, [`${prefix}::parent`, `${prefix}::child`]);
            assert.strictEqual(h.ids.get('treeContainer'), container, 'both payloads must use the same tree container');
            assert.equal(h.lastTree().mode, mode);
        }
        assert.ok(h.requests.some(request => request.command === 'ardb-get-observer-tree'));
        assert.ok(h.requests.some(request => request.command === 'ardb-get-snapshot'));
    });
    await check('current invalid / unknown relations remain separate roots without mutating input', async h => {
        const before = clone(h.snapshot);
        const valid = h.buildForest(h.snapshot);
        assert.equal(valid.length, 1);
        assert.equal(valid[0].children.length, 1);
        assert.deepStrictEqual(h.snapshot, before);
        h.snapshot = snapshotFixture('stale', false);
        h.click('snapshotBtn'); await h.settle();
        const roots = h.lastTree().treeData;
        assert.equal(roots.length, 2);
        assert.ok(roots.every(node => node.children.length === 0));
        assert.ok(roots.every(node => node.relationFromParent?.kind !== 'await'));
        h.click('observerBtn'); await h.settle();
        assert.equal(h.lastTree().treeData[0].children.length, 1, 'Observer tree keeps the recorded History relationship');
    });
    await check('entry does not refresh; real stopped refreshes only Observer', async h => {
        h.requests.length = 0;
        h.stop('entry'); await h.settle();
        assert.equal(h.requests.length, 0);
        h.stop(); await h.settle();
        assert.equal(h.requests.filter(request => request.command === 'ardb-get-observer-tree').length, 1);
        h.click('snapshotBtn'); await h.settle();
        const before = clone(h.requests);
        h.stop(); await h.settle();
        assert.deepStrictEqual(clone(h.requests), before, 'Snapshot stopped must not make any automatic tree request');
        assertView(h, 'snapshot', ['snapshot::parent', 'snapshot::child']);
    });
    await check('Clear History clears the Observer tree and preserves the visible Snapshot', async h => {
        h.click('observerBtn'); await h.settle();
        h.click('snapshotBtn'); await h.settle();
        const snapshotBefore = clone(h.lastTree());
        h.requests.length = 0;
        h.click('clearHistoryBtn'); await h.settle();
        assert.equal(h.outbound.at(-1).command, 'clearHistory');
        assert.deepStrictEqual(h.requests.map(request => request.command), ['ardb-clear-history-tree']);
        assertView(h, 'snapshot', ['snapshot::parent', 'snapshot::child']);
        assert.deepStrictEqual(h.lastTree(), snapshotBefore);
        h.observerTree = { type: 'observer_tree', observer_root: null, roots: [] };
        h.click('observerBtn'); await h.settle();
        assertView(h, 'observer', []);
        h.click('clearHistoryBtn'); await h.settle();
        assertView(h, 'observer', []);
    });
    await check('empty, unavailable and rejected requests never reuse another mode’s tree', async h => {
        h.click('observerBtn'); await h.settle();
        for (const payload of [{ snapshot: null }, { snapshot: { ...snapshotFixture(), empty: true, async_path: [] } }, {}]) {
            h.queue('ardb-get-snapshot', payload);
            h.click('snapshotBtn'); await h.settle();
            assertView(h, 'snapshot', []);
        }
        const failure = deferred();
        h.queue('ardb-get-snapshot', failure.promise);
        h.click('snapshotBtn'); failure.reject(new Error('expected snapshot transport failure'));
        await h.settle(); assertView(h, 'snapshot', []);
        h.queue('ardb-get-observer-tree', { observerTree: null });
        h.click('observerBtn'); await h.settle(); assertView(h, 'observer', []);
        const observerFailure = deferred();
        h.queue('ardb-get-observer-tree', observerFailure.promise);
        h.click('observerBtn'); observerFailure.reject(new Error('expected observer transport failure'));
        await h.settle(); assertView(h, 'observer', []);
        assert.ok(h.requests.every(request => !['ardb-reset', 'ardb-trace', 'continue', 'evaluate'].includes(request.command)));
    });
    await check('late Observer response and metadata cannot replace Snapshot', async h => {
        const old = deferred(); h.queue('ardb-get-observer-tree', old.promise);
        h.click('observerBtn');
        h.click('snapshotBtn'); await h.settle();
        old.resolve({ observerTree: observerFixture('late-observer') }); await h.settle();
        assertView(h, 'snapshot', ['snapshot::parent', 'snapshot::child']);
        h.deliver({ command: 'updateTreeView', mode: 'observer', observerRoot: 'late-observer::parent' });
        h.deliver({ command: 'updateTree', mode: 'observer', treeData: [] });
        assertView(h, 'snapshot', ['snapshot::parent', 'snapshot::child']);
    });
    await check('same-mode request ordering survives O1 → S → O2 and S1 → O → S2', async h => {
        for (const [command, first, other, mode, key, fixture] of [
            ['ardb-get-observer-tree', 'observerBtn', 'snapshotBtn', 'observer', 'observerTree', observerFixture],
            ['ardb-get-snapshot', 'snapshotBtn', 'observerBtn', 'snapshot', 'snapshot', snapshotFixture],
        ]) {
            const old = deferred(); h.queue(command, old.promise);
            h.click(first); h.click(other); await h.settle();
            h.queue(command, { [key]: fixture('newest') });
            h.click(first); await h.settle();
            old.resolve({ [key]: fixture('oldest') }); await h.settle();
            assertView(h, mode, ['newest::parent', 'newest::child']);
        }
    });
    await check('already-posted same-mode tree messages cannot refill a newer pending view', async h => {
        for (const [id, command, mode, key, fixture, intermediate] of [
            ['observerBtn', 'ardb-get-observer-tree', 'observer', 'observerTree', observerFixture, null],
            ['snapshotBtn', 'ardb-get-snapshot', 'snapshot', 'snapshot', snapshotFixture, null],
            ['observerBtn', 'ardb-get-observer-tree', 'observer', 'observerTree', observerFixture, 'snapshotBtn'],
        ]) {
            h.click(id); await h.settle();
            const postedTree = clone(h.lastTree());
            const postedMetadata = clone(h.inbound.filter(message => message.command === 'updateTreeView').at(-1));
            assert.ok(Number.isInteger(postedTree.viewRequestId), 'tree response must echo the initiating UI request');
            if (intermediate) { h.click(intermediate); await h.settle(); }
            const fresh = deferred(); h.queue(command, fresh.promise);
            h.click(id);
            assertView(h, mode, []);
            h.deliver(postedMetadata);
            h.deliver(postedTree);
            assertView(h, mode, []);
            fresh.resolve({ [key]: fixture('fresh-view') }); await h.settle();
            assertView(h, mode, ['fresh-view::parent', 'fresh-view::child']);
        }
    });
    await check('Clear History invalidates pending Observer responses without cancelling Snapshot', async h => {
        const old = deferred(); h.queue('ardb-get-observer-tree', old.promise);
        h.click('observerBtn'); h.click('clearHistoryBtn'); await h.settle();
        old.resolve({ observerTree: observerFixture('before-clear') }); await h.settle();
        assertView(h, 'observer', []);
        const snapshot = deferred(); h.queue('ardb-get-snapshot', snapshot.promise);
        h.click('snapshotBtn'); h.click('clearHistoryBtn'); await h.settle();
        snapshot.resolve({ snapshot: snapshotFixture('after-clear') }); await h.settle();
        assertView(h, 'snapshot', ['after-clear::parent', 'after-clear::child']);
    });
    await check('responses from a previous debug session are discarded', async h => {
        const old = deferred(); h.queue('ardb-get-snapshot', old.promise);
        h.click('snapshotBtn'); h.switchSession();
        old.resolve({ snapshot: snapshotFixture('old-session') }); await h.settle();
        assert.ok(!h.functions().some(name => name.startsWith('old-session')));
    });
    await check('Reset clears both modes and rejects requests made before reset', async h => {
        const old = deferred(); h.queue('ardb-get-snapshot', old.promise);
        h.click('observerBtn'); await h.settle();
        h.click('snapshotBtn'); h.click('resetBtn'); await h.settle();
        old.resolve({ snapshot: snapshotFixture('before-reset') }); await h.settle();
        assert.deepStrictEqual(h.functions(), []);
        assert.ok(h.requests.some(request => request.command === 'ardb-reset'));
    });
    await check('repeated Snapshot clicks issue only read requests and preserve their input', async h => {
        const before = clone({ snapshot: h.snapshot, observerTree: h.observerTree });
        h.requests.length = 0;
        for (let index = 0; index < 4; index++) { h.click('snapshotBtn'); await h.settle(); }
        assert.deepStrictEqual(h.requests.map(request => request.command), Array(4).fill('ardb-get-snapshot'));
        assert.deepStrictEqual({ snapshot: h.snapshot, observerTree: h.observerTree }, before);
    });
    await check('Snapshot and Observer node navigation uses displayed source, never cached GDB frame indices', async h => {
        for (const id of ['snapshotBtn', 'observerBtn', 'snapshotBtn']) {
            h.click(id); await h.settle(); h.stop(); await h.settle();
            const node = all(h.ids.get('treeContainer')).find(element => element.className?.split(/\s+/).includes('tree-node'));
            assert.ok(node); h.requests.length = 0; h.opened.length = 0;
            node.fire('click'); await h.settle();
            assert.equal(h.opened[0]?.file, __filename);
            assert.ok(!h.requests.some(request => ['stackTrace', 'evaluate'].includes(request.command)));
        }
        h.snapshot = snapshotFixture('without-source');
        h.snapshot.async_path.forEach(node => { node.source = null; });
        h.click('snapshotBtn'); await h.settle(); h.requests.length = 0;
        all(h.ids.get('treeContainer')).find(element => element.className?.split(/\s+/).includes('tree-node')).fire('click');
        await h.settle();
        assert.ok(h.requests.some(request => request.command === 'ardb-execute-command'));
        assert.ok(!h.requests.some(request => ['stackTrace', 'evaluate'].includes(request.command)));
    });
    if (process.argv[2]) {
        const fixtures = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
        await check('real P0 fixture: Observer retains the historical edge; current invalid Snapshot has no await child', async h => {
            h.click('observerBtn'); await h.settle();
            assert.ok(h.lastTree().treeData.some(node => node.children.length > 0));
            h.click('snapshotBtn'); await h.settle();
            assert.ok(h.lastTree().treeData.some(node => node.children.length > 0), 'valid current fixture must render its observed edge');
            h.snapshot = fixtures.staleSnapshot;
            h.click('snapshotBtn'); await h.settle();
            assert.ok(h.lastTree().treeData.length > 0);
            assert.ok(h.lastTree().treeData.every(node => node.children.length === 0));
            h.click('observerBtn'); await h.settle();
            assert.ok(h.lastTree().treeData.some(node => node.children.length > 0));
        }, fixtures);
    }
    console.log(`Async Inspector unified tree: ${scenarios} scenarios PASS`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
