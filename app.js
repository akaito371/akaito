/* ==========================================================
   VST DOMAIN MANAGER V11.1
========================================================== */

const App = {
    computers: [],
    filtered: [],
    selected: new Set(),
    sortField: "Name",
    sortAsc: true,
    page: 1,
    pageSize: 50,
    loading: false,
    refreshTimer: null,
    statusRefreshRunning: false,
    lastDirectoryLoad: null,
    currentView: "dashboard",
    detailLoadedTabs: new Set(),
    services: [],
    serviceActionPending: new Set(),
    processes: [],
    processActionPending: new Set(),
    software: [],
    events: [],
    selectedEvent: null,
    remoteSessions: [],
    remotePrinters: [],
    adUsers: [],
    selectedAdUser: null,
    adSelectedOu: "",
    contextComputer: null,
    pendingAction: null,
    scanToken: 0,
    scanStats: {
        total: 0,
        completed: 0,
        online: 0,
        offline: 0,
        timeout: 0
    }
};

const $ = id => document.getElementById(id);

function normalize(value) {
    return String(value ?? "").toLowerCase().trim();
}

function escapeHTML(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function setText(id, value) {
    const el = $(id);
    if (el) el.innerText = value;
}

function showToast(title, text, ok = true) {
    const toast = $("toast");
    if (!toast) return;

    setText("toastTitle", title);
    setText("toastText", text);
    setText("toastIcon", ok ? "✓" : "✕");

    toast.classList.add("show");
    clearTimeout(window.toastTimer);
    window.toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
}

async function api(url, options = {}) {
    const response = await fetch(url, options);
    const type = response.headers.get("content-type") || "";
    let payload;

    try {
        payload = type.includes("application/json")
            ? await response.json()
            : { Message: await response.text() };
    } catch {
        payload = { Message: `HTTP ${response.status}` };
    }

    if (!response.ok) {
        throw new Error(
            payload?.Detail ||
            payload?.Error ||
            payload?.error ||
            payload?.Message ||
            `HTTP ${response.status}`
        );
    }

    return payload;
}

function getStatus(pc) {
    return pc.Status || "Pending";
}

function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? escapeHTML(value)
        : date.toLocaleString("vi-VN");
}

function statusBadge(status) {
    const value = status || "Pending";
    if (value === "Online") return `<span class="badge online">Online</span>`;
    if (value === "Offline") return `<span class="badge offline">Offline</span>`;
    if (value === "Timeout") return `<span class="badge timeout">Timeout</span>`;
    if (value === "Error") return `<span class="badge error">Lỗi kiểm tra</span>`;
    if (value === "NotChecked") return `<span class="badge not-checked">Chưa kiểm tra</span>`;
    return `<span class="badge pending">Đang kiểm tra</span>`;
}


const VIEW_CONFIG = {
    dashboard: {
        title: "Tổng quan hệ thống",
        hash: "#dashboard"
    },
    users: {
        title: "Người dùng Active Directory",
        hash: "#users"
    },
    computers: {
        title: "Máy tính trong Domain",
        hash: "#computers"
    },
    statistics: {
        title: "Thống kê hệ thống",
        hash: "#statistics"
    }
};

function normalizeView(view) {
    return Object.prototype.hasOwnProperty.call(VIEW_CONFIG, view)
        ? view
        : "dashboard";
}

function showView(view, options = {}) {
    const selectedView = normalizeView(view);
    const config = VIEW_CONFIG[selectedView];

    App.currentView = selectedView;
    localStorage.setItem("domain-current-view", selectedView);

    document.querySelectorAll(".app-view").forEach(section => {
        const visible = section.dataset.page === selectedView;
        section.hidden = !visible;
        section.classList.toggle("view-active", visible);
    });

    document.querySelectorAll(".nav-item[data-view]").forEach(button => {
        const active = button.dataset.view === selectedView;
        button.classList.toggle("active", active);
        button.setAttribute("aria-current", active ? "page" : "false");
    });

    setText("pageTitle", config.title);
    document.title = `${config.title} • VST Domain Manager V9.0`;

    if (!options.skipHistory && location.hash !== config.hash) {
        history.pushState({ view: selectedView }, "", config.hash);
    }

    if (selectedView === "computers") {
        requestAnimationFrame(() => {
            $("search")?.focus({ preventScroll: true });
        });
    }

    if (selectedView === "statistics") {
        updateStatistics();
    }

    if (selectedView === "users" && !App.adUsers.length) {
        loadAdUsers();
    }

    // Đóng menu trên màn hình nhỏ sau khi chọn trang.
    if (window.matchMedia("(max-width: 850px)").matches) {
        $("sidebar")?.classList.remove("mobile-open");
    }

    window.scrollTo({ top: 0, behavior: options.instant ? "auto" : "smooth" });
}

function initializeNavigation() {
    document.querySelectorAll(".nav-item[data-view]").forEach(button => {
        button.addEventListener("click", () => {
            showView(button.dataset.view);
        });
    });

    const viewFromHash = location.hash.replace("#", "");
    const savedView = localStorage.getItem("domain-current-view");
    const initialView = normalizeView(viewFromHash || savedView || "dashboard");

    showView(initialView, {
        skipHistory: true,
        instant: true
    });

    if (location.hash !== VIEW_CONFIG[initialView].hash) {
        history.replaceState(
            { view: initialView },
            "",
            VIEW_CONFIG[initialView].hash
        );
    }

    window.addEventListener("popstate", event => {
        const view = normalizeView(
            event.state?.view || location.hash.replace("#", "")
        );
        showView(view, {
            skipHistory: true,
            instant: true
        });
    });
}

function updateStatistics() {
    const total = App.computers.length;
    const online = App.computers.filter(pc => getStatus(pc) === "Online").length;
    const enabled = App.computers.filter(pc => pc.Enabled !== false).length;
    const disabled = Math.max(0, total - enabled);

    const win11 = App.computers.filter(
        pc => normalize(pc.OS).includes("windows 11")
    ).length;
    const win10 = App.computers.filter(
        pc => normalize(pc.OS).includes("windows 10")
    ).length;
    const server = App.computers.filter(
        pc => normalize(pc.OS).includes("server")
    ).length;
    const other = Math.max(0, total - win11 - win10 - server);

    const percent = value => total
        ? Math.round(value * 100 / total)
        : 0;

    setText("statsOnlineRate", percent(online) + "%");
    setText("statsOnlineDetail", `${online} / ${total} máy`);
    setText("statsDisabled", disabled);
    setText("statsDisabledRate", `${percent(disabled)}% tổng số máy`);
    setText("statsWindows11", win11);
    setText("statsWindows11Rate", `${percent(win11)}% tổng số máy`);
    setText("statsOsTotal", `${total} thiết bị`);

    setText("statsWin11Value", win11);
    setText("statsWin10Value", win10);
    setText("statsServerValue", server);
    setText("statsOtherValue", other);

    setBar("statsWin11Bar", win11, total);
    setBar("statsWin10Bar", win10, total);
    setBar("statsServerBar", server, total);
    setBar("statsOtherBar", other, total);

    const ouCounts = new Map();
    App.computers.forEach(pc => {
        const ou = String(pc.OU || "Chưa xác định").trim() || "Chưa xác định";
        ouCounts.set(ou, (ouCounts.get(ou) || 0) + 1);
    });

    const sortedOu = [...ouCounts.entries()]
        .sort((a, b) => b[1] - a[1]);

    setText("statsOuCount", sortedOu.length);

    const list = $("statsOuList");
    if (!list) return;

    if (!sortedOu.length) {
        list.innerHTML = '<div class="statistics-empty">Chưa có dữ liệu.</div>';
        return;
    }

    const max = sortedOu[0][1] || 1;
    list.innerHTML = sortedOu.slice(0, 8).map(([ou, count]) => `
        <div class="ou-stat-row" title="${escapeHTML(ou)}">
            <div>
                <span>${escapeHTML(ou)}</span>
                <b>${count}</b>
            </div>
            <div class="ou-stat-track">
                <i style="width:${Math.round(count * 100 / max)}%"></i>
            </div>
        </div>
    `).join("");
}

async function loadData(forceDirectoryRefresh = false) {
    if (App.loading) return;

    App.loading = true;
    setText(
        "progressText",
        forceDirectoryRefresh
            ? "Đang tải mới Active Directory..."
            : "Đang tải danh sách máy..."
    );

    try {
        const previous = new Map(
            App.computers.map(pc => [
                String(pc.Name || "").toLowerCase(),
                {
                    Status: pc.Status,
                    IP: pc.IP,
                    LastChecked: pc.LastChecked
                }
            ])
        );

        const url = forceDirectoryRefresh ? "/api?refresh=1" : "/api";
        const data = await api(url);
        App.computers = Array.isArray(data) ? data : [];

        App.computers.forEach(pc => {
            const old = previous.get(String(pc.Name || "").toLowerCase());

            // Giữ trạng thái lần quét gần nhất khi danh sách AD được tải lại.
            if (old) {
                pc.Status = old.Status || "NotChecked";
                pc.IP = old.IP || "";
                pc.LastChecked = old.LastChecked || "";
            } else {
                pc.Status = "NotChecked";
                pc.IP = "";
            }
        });

        App.lastDirectoryLoad = new Date();
        populateOUFilter();
        App.filtered = [...App.computers];
        sortData();
        updateDashboard();
        renderTable();

        setText(
            "progressText",
            `Đã tải ${App.computers.length} máy. Bắt đầu kiểm tra trạng thái...`
        );
        setText("lastUpdated", new Date().toLocaleString("vi-VN"));

        await startPing();
    } catch (error) {
        console.error(error);
        showToast(
            "Lỗi",
            error?.message || "Không tải được dữ liệu Active Directory",
            false
        );
        setText("progressText", "Tải dữ liệu thất bại");
    } finally {
        App.loading = false;
    }
}

async function refreshStatuses() {
    if (App.statusRefreshRunning || App.loading || !App.computers.length) {
        return;
    }

    App.statusRefreshRunning = true;

    try {
        setText(
            "progressText",
            `Đang làm mới trạng thái ${App.computers.length} máy...`
        );
        await startPing();
        setText("lastUpdated", new Date().toLocaleString("vi-VN"));
    } catch (error) {
        console.error(error);
        showToast(
            "Làm mới trạng thái thất bại",
            error?.message || "Không thể quét trạng thái máy",
            false
        );
    } finally {
        App.statusRefreshRunning = false;
    }
}

function applyFilters() {
    const keyword = normalize($("search")?.value);
    const status = $("statusFilter")?.value || "";
    const os = $("osFilter")?.value || "";
    const ou = $("ouFilter")?.value || "";

    App.filtered = App.computers.filter(pc => {
        const text = [
            pc.Name, pc.IP, pc.OS, pc.OU, pc.LastLogon, getStatus(pc)
        ].map(normalize).join(" ");

        const matchKeyword = !keyword || text.includes(keyword);
        const matchStatus = !status || getStatus(pc) === status;

        let matchOS = true;
        if (os === "Windows 11") matchOS = normalize(pc.OS).includes("windows 11");
        else if (os === "Windows 10") matchOS = normalize(pc.OS).includes("windows 10");
        else if (os === "Server") matchOS = normalize(pc.OS).includes("server");

        const matchOU = !ou || pc.OU === ou;

        return matchKeyword && matchStatus && matchOS && matchOU;
    });

    sortData();
    App.page = 1;
    renderTable();
}

function sortData() {
    const direction = App.sortAsc ? 1 : -1;
    const field = App.sortField;

    App.filtered.sort((a, b) => {
        let av = field === "Status" ? getStatus(a) : (a[field] ?? "");
        let bv = field === "Status" ? getStatus(b) : (b[field] ?? "");

        if (field === "LastLogon") {
            return ((new Date(av).getTime() || 0) - (new Date(bv).getTime() || 0)) * direction;
        }

        return String(av).localeCompare(String(bv), "vi", {
            numeric: true,
            sensitivity: "base"
        }) * direction;
    });
}

function renderTable() {
    const tbody = $("tbody");
    if (!tbody) return;

    App.pageSize = Number($("pageSize")?.value || App.pageSize);

    const totalPages = Math.max(1, Math.ceil(App.filtered.length / App.pageSize));
    if (App.page > totalPages) App.page = totalPages;

    const start = (App.page - 1) * App.pageSize;
    const pageData = App.filtered.slice(start, start + App.pageSize);

    if (!pageData.length) {
        tbody.innerHTML = `
            <tr>
                <td colspan="8" class="empty">
                    <b>Không tìm thấy máy tính phù hợp</b>
                </td>
            </tr>`;
        updatePager();
        return;
    }

    tbody.innerHTML = pageData.map(pc => {
        const name = escapeHTML(pc.Name);
        const checked = App.selected.has(pc.Name) ? "checked" : "";

        return `
            <tr data-name="${name}">
                <td class="check-col">
                    <input type="checkbox" class="row-check" data-name="${name}" ${checked}>
                </td>
                <td>
                    <div class="machine-name">
                        <div class="machine-icon">▣</div>
                        <div>
                            <b>${name}</b>
                            <small>${pc.Enabled === false ? "Disabled" : "Active"}</small>
                        </div>
                    </div>
                </td>
                <td id="status-${name}">${statusBadge(getStatus(pc))}</td>
                <td id="ip-${name}" class="ip-cell">${escapeHTML(pc.IP || "—")}</td>
                <td><span class="os-tag">${escapeHTML(pc.OS || "Chưa xác định")}</span></td>
                <td>${formatDate(pc.LastLogon)}</td>
                <td class="ou" title="${escapeHTML(pc.OU)}">${escapeHTML(pc.OU || "—")}</td>
                <td class="action-col">
                    <button type="button" class="more-btn" data-name="${name}" title="Thao tác">⋮</button>
                </td>
            </tr>`;
    }).join("");

    bindRowEvents();
    updatePager();
    syncSelectAll();
}

function updatePager() {
    const total = App.filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / App.pageSize));
    const start = total ? (App.page - 1) * App.pageSize + 1 : 0;
    const end = Math.min(App.page * App.pageSize, total);

    setText("resultInfo", `${start}-${end} / ${total} kết quả`);
    setText("pageInfo", `Trang ${App.page}/${totalPages}`);

    if ($("prev")) $("prev").disabled = App.page <= 1;
    if ($("next")) $("next").disabled = App.page >= totalPages;
}

function bindRowEvents() {
    document.querySelectorAll(".row-check").forEach(check => {
        check.addEventListener("change", () => {
            if (check.checked) App.selected.add(check.dataset.name);
            else App.selected.delete(check.dataset.name);
            syncSelectAll();
        });
    });

    document.querySelectorAll(".more-btn").forEach(button => {
        button.addEventListener("click", event => {
            event.stopPropagation();
            const pc = App.computers.find(x => x.Name === button.dataset.name);
            if (pc) showContextMenu(event.clientX, event.clientY, pc);
        });
    });

    document.querySelectorAll("#tbody tr[data-name]").forEach(row => {
        row.addEventListener("contextmenu", event => {
            event.preventDefault();
            const pc = App.computers.find(x => x.Name === row.dataset.name);
            if (pc) showContextMenu(event.clientX, event.clientY, pc);
        });

        row.addEventListener("dblclick", () => {
            const pc = App.computers.find(x => x.Name === row.dataset.name);
            if (pc) showComputerDetails(pc);
        });
    });
}

function syncSelectAll() {
    const selectAll = $("selectAll");
    if (!selectAll) return;

    const checks = [...document.querySelectorAll(".row-check")];
    const count = checks.filter(x => x.checked).length;

    selectAll.checked = checks.length > 0 && count === checks.length;
    selectAll.indeterminate = count > 0 && count < checks.length;
}

function populateOUFilter() {
    const select = $("ouFilter");
    if (!select) return;

    const current = select.value;
    const ous = [...new Set(App.computers.map(pc => pc.OU).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, "vi"));

    select.innerHTML = `<option value="">Tất cả OU</option>` +
        ous.map(ou => `<option value="${escapeHTML(ou)}">${escapeHTML(ou)}</option>`).join("");

    if (ous.includes(current)) select.value = current;
}

async function pingBatch(names, scanToken) {
    const result = await api("/pingbatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names })
    });

    if (scanToken !== App.scanToken) {
        return { processed: 0, online: 0, offline: 0, timeout: 0 };
    }

    const rows = Array.isArray(result)
        ? result
        : (Array.isArray(result?.Results) ? result.Results : []);

    const returnedNames = new Set();
    let online = 0;
    let offline = 0;

    rows.forEach(item => {
        const name = String(item?.Name || "");
        if (!name) return;

        returnedNames.add(name.toLowerCase());

        const pc = App.computers.find(
            x => String(x.Name).toLowerCase() === name.toLowerCase()
        );
        if (!pc) return;

        pc.Status = item.Status === "Online" ? "Online" : "Offline";
        pc.IP = item.IP || pc.IP || "";
        pc.LastChecked = new Date().toISOString();

        if (pc.Status === "Online") online++;
        else offline++;

        updateComputerStatusCell(pc);
    });

    // A server response must account for every requested computer.
    // Missing rows are marked Timeout rather than left permanently Pending.
    let timeout = 0;
    names.forEach(name => {
        if (returnedNames.has(String(name).toLowerCase())) return;

        const pc = App.computers.find(
            x => String(x.Name).toLowerCase() === String(name).toLowerCase()
        );
        if (!pc) return;

        pc.Status = "Timeout";
        pc.LastChecked = new Date().toISOString();
        timeout++;
        updateComputerStatusCell(pc);
    });

    return {
        processed: names.length,
        online,
        offline,
        timeout
    };
}

function updateComputerStatusCell(pc) {
    const statusCell = $("status-" + pc.Name);
    const ipCell = $("ip-" + pc.Name);

    if (statusCell) statusCell.innerHTML = statusBadge(pc.Status);
    if (ipCell) ipCell.innerText = pc.IP || "—";

    if (App.detailComputer?.Name === pc.Name) {
        const statusEl = $("detailStatus");
        if (statusEl) {
            statusEl.className = `detail-status ${String(pc.Status || "").toLowerCase()}`;
            statusEl.innerText = pc.Status === "Pending" ? "Đang kiểm tra" : pc.Status;
        }
    }
}

async function startPing() {
    if (!App.computers.length) return;

    // Each request is intentionally kept below 100 machines.
    // The previous UI sent 200 while the backend only handled 100,
    // leaving half of each batch permanently at “Đang kiểm tra”.
    const batchSize = 80;
    const concurrency = 4;
    const batches = [];
    const scanToken = ++App.scanToken;

    App.scanStats = {
        total: App.computers.length,
        completed: 0,
        online: 0,
        offline: 0,
        timeout: 0
    };

    App.computers.forEach(pc => {
        pc.Status = "Pending";
        pc.IP = "";
        updateComputerStatusCell(pc);
    });

    for (let i = 0; i < App.computers.length; i += batchSize) {
        batches.push(
            App.computers
                .slice(i, i + batchSize)
                .map(pc => pc.Name)
        );
    }

    let nextBatchIndex = 0;
    updateScanProgress(App.scanStats);

    async function worker() {
        while (scanToken === App.scanToken) {
            const index = nextBatchIndex++;
            if (index >= batches.length) return;

            const names = batches[index];

            try {
                const batch = await pingBatch(names, scanToken);

                if (scanToken !== App.scanToken) return;

                App.scanStats.completed += batch.processed;
                App.scanStats.online += batch.online;
                App.scanStats.offline += batch.offline;
                App.scanStats.timeout += batch.timeout;
            } catch (error) {
                console.error("Ping batch error:", error);

                names.forEach(name => {
                    const pc = App.computers.find(x => x.Name === name);
                    if (!pc || getStatus(pc) !== "Pending") return;

                    pc.Status = error?.name === "AbortError" ? "Timeout" : "Error";
                    pc.LastChecked = new Date().toISOString();
                    updateComputerStatusCell(pc);
                });

                App.scanStats.completed += names.length;
                if (error?.name === "AbortError") {
                    App.scanStats.timeout += names.length;
                } else {
                    App.scanStats.offline += names.length;
                }
            }

            App.scanStats.completed = Math.min(
                App.scanStats.completed,
                App.scanStats.total
            );

            updateScanProgress(App.scanStats);
            updateDashboard();
        }
    }

    await Promise.all(
        Array.from(
            { length: Math.min(concurrency, batches.length) },
            () => worker()
        )
    );

    if (scanToken !== App.scanToken) return;

    // Safety net: no machine may remain Pending after the scan finishes.
    let unresolved = 0;
    App.computers.forEach(pc => {
        if (getStatus(pc) === "Pending") {
            pc.Status = "Timeout";
            pc.LastChecked = new Date().toISOString();
            unresolved++;
            updateComputerStatusCell(pc);
        }
    });

    if (unresolved) {
        App.scanStats.timeout += unresolved;
        App.scanStats.completed = App.scanStats.total;
    }

    applyFilters();
    updateDashboard();
    updateScanProgress(App.scanStats, true);
    setText("lastUpdated", new Date().toLocaleString("vi-VN"));
}

function updateScanProgress(stats, finished = false) {
    const total = Number(stats?.total || 0);
    const done = Math.min(Number(stats?.completed || 0), total);
    const percent = total ? Math.round(done * 100 / total) : 0;
    const remaining = Math.max(0, total - done);

    setText("scanPercent", percent + "%");

    if (finished) {
        setText(
            "progressText",
            `Đã kiểm tra ${done}/${total} máy — Online: ${stats.online}, ` +
            `Offline: ${stats.offline}, Timeout: ${stats.timeout}`
        );
    } else {
        setText(
            "progressText",
            `Đang kiểm tra ${done}/${total} máy — Online: ${stats.online}, ` +
            `Offline: ${stats.offline}, Timeout: ${stats.timeout}, còn: ${remaining}`
        );
    }

    if ($("progressBar")) {
        $("progressBar").style.width = percent + "%";
    }
}

function showContextMenu(x, y, pc) {
    const menu = $("contextMenu");
    if (!menu) return;

    App.contextComputer = pc;
    menu.classList.add("show");
    menu.setAttribute("aria-hidden", "false");

    const left = Math.min(x, window.innerWidth - menu.offsetWidth - 12);
    const top = Math.min(y, window.innerHeight - menu.offsetHeight - 12);

    menu.style.left = Math.max(8, left) + "px";
    menu.style.top = Math.max(8, top) + "px";
}

function hideContextMenu() {
    const menu = $("contextMenu");
    if (!menu) return;
    menu.classList.remove("show");
    menu.setAttribute("aria-hidden", "true");
}

async function copyText(value, label) {
    if (!value) {
        showToast("Không thể sao chép", `${label} đang trống`, false);
        return;
    }

    try {
        await navigator.clipboard.writeText(value);
    } catch {
        const box = document.createElement("textarea");
        box.value = value;
        document.body.appendChild(box);
        box.select();
        document.execCommand("copy");
        box.remove();
    }

    showToast("Đã sao chép", `${label}: ${value}`);
}

async function runComputerAction(action, pc) {
    if (!pc) return;

    try {
        showToast("Đang thực hiện", `${pc.Name}`);

        if (action === "ping") {
            const rows = await pingBatch([pc.Name]);
            updateDashboard();
            applyFilters();
            showToast("Hoàn tất", rows ? `Đã kiểm tra ${pc.Name}` : `Không nhận được kết quả từ ${pc.Name}`);
            return;
        }

        const result = await api("/action", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                computer: pc.Name,
                action
            })
        });

        showToast("Thành công", result.message || result.Message || `Đã thực hiện trên ${pc.Name}`);
    } catch (error) {
        console.error(action, error);
        showToast("Thao tác thất bại", `Không thể thực hiện trên ${pc.Name}`, false);
    }
}

function setLoadState(id, state, text) {
    const el = $(id);
    if (!el) return;
    el.className = `load-state ${state}`;
    el.innerText = text;
}

function resetComputerDetailFields(pc) {
    setText("detailUser", "—");
    setText("detailIP", pc.IP || "—");
    setText("detailMAC", "—");
    setText("detailUptime", "—");
    setText("detailWindows", pc.OS || "—");
    setText("detailLastLogon", formatDate(pc.LastLogon));
    setText("detailDiagnosis", "Đang tải từng nhóm dữ liệu...");
    setText("detailModel", "—");
    setText("detailCPU", "—");
    setText("detailRAM", "—");
    setText("detailSerial", "—");
    setText("detailDiskCount", "");
    setText("detailAdapter", "—");
    setText("detailNetworkIP", pc.IP || "—");
    setText("detailNetworkMAC", "—");
    setText("detailGateway", "—");
    setText("detailDNS", "—");
    setText("detailDHCP", "—");
    setText("detailDHCPServer", "—");

    if ($("detailDisks")) {
        $("detailDisks").innerHTML = "<small>Đang chờ dữ liệu ổ đĩa...</small>";
    }

    ["basicLoadState", "hardwareLoadState", "networkLoadState", "networkTabLoadState", "disksLoadState"]
        .forEach(id => setLoadState(id, "idle", "Chờ"));

    if ($("detailErrorBox")) $("detailErrorBox").hidden = true;
    setText("diagnosticSummary", "Chưa chạy chẩn đoán.");
    const diagnosticSummary = $("diagnosticSummary");
    if (diagnosticSummary) diagnosticSummary.className = "diagnostic-summary";
    if ($("diagnosticResults")) $("diagnosticResults").innerHTML = "";
}

async function fetchComputerSection(path, computer, timeoutMs = 10000, extra = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await api(path, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-store"
            },
            body: JSON.stringify({ computer, ...extra }),
            signal: controller.signal,
            cache: "no-store"
        });
    } finally {
        clearTimeout(timer);
    }
}

function sectionErrorMessage(error) {
    if (error?.name === "AbortError") return "Hết thời gian chờ.";
    return error?.message || "Không thể kết nối.";
}

async function loadBasicSection(pc) {
    setLoadState("basicLoadState", "loading", "Đang tải");

    try {
        const data = await fetchComputerSection("/computer/basic", pc.Name, 11000);

        setText("detailUser", data.User || "—");
        setText("detailIP", data.IP || pc.IP || "—");
        setText("detailUptime", formatUptime(data.UptimeSeconds));
        setText("detailWindows", data.Windows || pc.OS || "—");

        setLoadState(
            "basicLoadState",
            data.Success ? "ok" : (data.Partial ? "partial" : "error"),
            data.Success ? "Xong" : (data.Partial ? "Một phần" : "Lỗi")
        );

        return data;
    } catch (error) {
        setLoadState("basicLoadState", "error", "Lỗi");
        return { Success: false, Error: sectionErrorMessage(error) };
    }
}

async function loadHardwareSection(pc) {
    setLoadState("hardwareLoadState", "loading", "Đang tải");

    try {
        const data = await fetchComputerSection("/computer/hardware", pc.Name, 15000);

        setText("detailModel", [data.Manufacturer, data.Model].filter(Boolean).join(" ") || "—");
        setText("detailCPU", data.CPU || "—");
        setText("detailRAM", data.RAMBytes ? formatBytes(data.RAMBytes) : "—");
        setText("detailSerial", data.Serial || "—");

        setLoadState(
            "hardwareLoadState",
            data.Success ? "ok" : (data.Partial ? "partial" : "error"),
            data.Success ? "Xong" : (data.Partial ? "Một phần" : "Lỗi")
        );

        return data;
    } catch (error) {
        setLoadState("hardwareLoadState", "error", "Lỗi");
        return { Success: false, Error: sectionErrorMessage(error) };
    }
}

async function loadNetworkSection(pc) {
    setLoadState("networkLoadState", "loading", "Đang tải");

    try {
        const data = await fetchComputerSection("/computer/network", pc.Name, 10000);

        setText("detailMAC", data.MAC || "—");
        setText("detailNetworkMAC", data.MAC || "—");
        setText("detailAdapter", data.Adapter || "—");
        setText("detailNetworkIP", data.IP || pc.IP || "—");
        setText("detailGateway", data.Gateway || "—");
        setText(
            "detailDNS",
            Array.isArray(data.DNS) && data.DNS.length
                ? data.DNS.join(", ")
                : "—"
        );
        setText("detailDHCP", data.DHCPEnabled ? "Đang bật" : "Tắt / IP tĩnh");
        setText("detailDHCPServer", data.DHCPServer || "—");
        if (data.IP) setText("detailIP", data.IP);

        setLoadState(
            "networkTabLoadState",
            data.Success ? "ok" : (data.Partial ? "partial" : "error"),
            data.Success ? "Xong" : (data.Partial ? "Một phần" : "Lỗi")
        );

        setLoadState(
            "networkLoadState",
            data.Success ? "ok" : (data.Partial ? "partial" : "error"),
            data.Success ? "Xong" : (data.Partial ? "Một phần" : "Lỗi")
        );

        return data;
    } catch (error) {
        setLoadState("networkLoadState", "error", "Lỗi");
        setLoadState("networkTabLoadState", "error", "Lỗi");
        return { Success: false, Error: sectionErrorMessage(error) };
    }
}

async function loadDisksSection(pc) {
    setLoadState("disksLoadState", "loading", "Đang tải");

    try {
        const data = await fetchComputerSection("/computer/disks", pc.Name, 11000);
        const disks = Array.isArray(data.Disks) ? data.Disks : [];

        setText("detailDiskCount", disks.length ? `${disks.length} ổ` : "");

        const diskBox = $("detailDisks");
        if (diskBox) {
            diskBox.innerHTML = disks.length
                ? disks.map(disk => {
                    const size = Number(disk.Size || 0);
                    const free = Number(disk.Free || 0);
                    const usedPercent = size ? Math.round((size - free) * 100 / size) : 0;
                    const warning = usedPercent >= 85 ? "warning" : "";

                    return `
                        <div class="disk-card">
                            <div>
                                <b>${escapeHTML(disk.Device || "Ổ đĩa")}</b>
                                <small>${formatBytes(free)} trống / ${formatBytes(size)}</small>
                            </div>
                            <div class="disk-meter">
                                <i class="${warning}" style="width:${Math.min(100, usedPercent)}%"></i>
                            </div>
                        </div>`;
                }).join("")
                : `<small>Không lấy được dữ liệu ổ đĩa.</small>`;
        }

        setLoadState(
            "disksLoadState",
            data.Success ? "ok" : (data.Partial ? "partial" : "error"),
            data.Success ? "Xong" : (data.Partial ? "Một phần" : "Lỗi")
        );

        return data;
    } catch (error) {
        if ($("detailDisks")) {
            $("detailDisks").innerHTML = `<small>${escapeHTML(sectionErrorMessage(error))}</small>`;
        }
        setLoadState("disksLoadState", "error", "Lỗi");
        return { Success: false, Error: sectionErrorMessage(error) };
    }
}



function serviceStatusClass(state) {
    const normalized = normalize(state);
    if (normalized === "running") return "running";
    if (normalized === "stopped") return "stopped";
    return "other";
}

function renderServices() {
    const tbody = $("servicesTableBody");
    if (!tbody) return;

    const query = normalize($("serviceSearch")?.value || "");
    const statusFilter = normalize($("serviceStatusFilter")?.value || "all");

    const filtered = App.services.filter(service => {
        const haystack = normalize(
            `${service.DisplayName || ""} ${service.Name || ""} ${service.Description || ""}`
        );
        const state = normalize(service.State);

        const matchesQuery = !query || haystack.includes(query);
        const matchesState = statusFilter === "all" || state === statusFilter;

        return matchesQuery && matchesState;
    });

    if (!filtered.length) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5" class="services-empty">
                    ${App.services.length
                        ? "Không có dịch vụ phù hợp bộ lọc."
                        : "Chưa có dữ liệu dịch vụ."}
                </td>
            </tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(service => {
        const name = String(service.Name || "");
        const state = String(service.State || "Unknown");
        const running = normalize(state) === "running";
        const stopped = normalize(state) === "stopped";
        const pending = App.serviceActionPending.has(name);

        return `
          <tr data-service-name="${escapeHTML(name)}">
            <td>
              <div class="service-name-cell">
                <b title="${escapeHTML(service.DisplayName || name)}">
                  ${escapeHTML(service.DisplayName || name)}
                </b>
                <small>${escapeHTML(name)}</small>
              </div>
            </td>
            <td>
              <span class="service-state ${serviceStatusClass(state)}">
                ${escapeHTML(state)}
              </span>
            </td>
            <td>${escapeHTML(service.StartMode || "—")}</td>
            <td>${Number(service.ProcessId || 0) || "—"}</td>
            <td>
              <div class="service-actions">
                <button
                  type="button"
                  class="service-action start"
                  data-service-action="start"
                  data-service-name="${escapeHTML(name)}"
                  ${running || pending ? "disabled" : ""}
                  title="Khởi động dịch vụ"
                >▶</button>
                <button
                  type="button"
                  class="service-action stop"
                  data-service-action="stop"
                  data-service-name="${escapeHTML(name)}"
                  ${stopped || pending ? "disabled" : ""}
                  title="Dừng dịch vụ"
                >■</button>
                <button
                  type="button"
                  class="service-action restart"
                  data-service-action="restart"
                  data-service-name="${escapeHTML(name)}"
                  ${stopped || pending ? "disabled" : ""}
                  title="Khởi động lại dịch vụ"
                >↻</button>
              </div>
            </td>
          </tr>`;
    }).join("");
}

async function loadServices(pc, force = false) {
    if (!pc) return;

    if (!force && App.detailLoadedTabs.has("services-data")) {
        renderServices();
        return;
    }

    App.detailLoadedTabs.add("services-data");
    setLoadState("servicesLoadState", "loading", "Đang tải");
    setText("servicesMessage", "Đang kết nối Service Control Manager...");

    try {
        const data = await fetchComputerSection(
            "/computer/services",
            pc.Name,
            20000
        );

        if (!data.Success) {
            throw new Error(data.Diagnosis || data.Error || "Không tải được Services.");
        }

        App.services = Array.isArray(data.Services) ? data.Services : [];
        setText("servicesTotal", data.Count ?? App.services.length);
        setText(
            "servicesRunning",
            data.Running ?? App.services.filter(s => normalize(s.State) === "running").length
        );
        setText(
            "servicesStopped",
            data.Stopped ?? App.services.filter(s => normalize(s.State) === "stopped").length
        );
        setText(
            "servicesMessage",
            `Đã tải ${App.services.length} dịch vụ từ ${pc.Name}.`
        );
        setLoadState("servicesLoadState", "ok", "Xong");
        renderServices();
    } catch (error) {
        App.services = [];
        setText("servicesTotal", "0");
        setText("servicesRunning", "0");
        setText("servicesStopped", "0");
        setText("servicesMessage", sectionErrorMessage(error));
        setLoadState("servicesLoadState", "error", "Lỗi");
        renderServices();
    }
}

async function runServiceAction(serviceName, action) {
    const pc = App.detailComputer;
    if (!pc || !serviceName || !action) return;

    const labels = {
        start: "khởi động",
        stop: "dừng",
        restart: "khởi động lại"
    };

    if (
        (action === "stop" || action === "restart") &&
        !window.confirm(
            `Xác nhận ${labels[action]} dịch vụ "${serviceName}" trên máy ${pc.Name}?`
        )
    ) {
        return;
    }

    App.serviceActionPending.add(serviceName);
    renderServices();
    setText(
        "servicesMessage",
        `Đang ${labels[action] || action} dịch vụ ${serviceName}...`
    );

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25000);

        let response;
        try {
            response = await fetch("/computer/service/action", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                cache: "no-store",
                body: JSON.stringify({
                    computer: pc.Name,
                    service: serviceName,
                    action
                }),
                signal: controller.signal
            });
        } finally {
            clearTimeout(timer);
        }

        const text = await response.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            throw new Error(text || `HTTP ${response.status}`);
        }

        if (!response.ok || !data.Success) {
            throw new Error(data.Diagnosis || data.Error || `HTTP ${response.status}`);
        }

        const item = App.services.find(
            service => service.Name === serviceName
        );
        if (item) {
            item.State = data.State || item.State;
            item.ProcessId = normalize(data.State) === "stopped"
                ? 0
                : item.ProcessId;
        }

        const running = App.services.filter(
            service => normalize(service.State) === "running"
        ).length;
        setText("servicesRunning", running);
        setText("servicesStopped", App.services.length - running);
        setText(
            "servicesMessage",
            `Đã ${labels[action] || action} ${serviceName}. Trạng thái: ${data.State || "đã cập nhật"}.`
        );
        setLoadState("servicesLoadState", "ok", "Đã cập nhật");

        // Tải lại để lấy PID/trạng thái chính xác sau thao tác.
        App.detailLoadedTabs.delete("services-data");
        await loadServices(pc, true);
    } catch (error) {
        setText(
            "servicesMessage",
            `Không thể ${labels[action] || action} ${serviceName}: ${sectionErrorMessage(error)}`
        );
        setLoadState("servicesLoadState", "error", "Thao tác lỗi");
    } finally {
        App.serviceActionPending.delete(serviceName);
        renderServices();
    }
}


function formatProcessMemory(value) {
    const number = Number(value || 0);
    if (number >= 1024) return `${(number / 1024).toFixed(2)} GB`;
    return `${number.toFixed(number < 10 ? 1 : 0)} MB`;
}

function renderProcesses() {
    const tbody = $("processesTableBody");
    if (!tbody) return;

    const query = normalize($("processSearch")?.value || "");
    const sortMode = $("processSort")?.value || "memory-desc";

    let rows = App.processes.filter(process => {
        const haystack = normalize(
            `${process.Name || ""} ${process.ProcessId || ""} ${process.ExecutablePath || ""} ${process.CommandLine || ""}`
        );
        return !query || haystack.includes(query);
    });

    rows = [...rows].sort((a, b) => {
        switch (sortMode) {
            case "cpu-desc":
                return Number(b.CPUPercent || 0) - Number(a.CPUPercent || 0);
            case "name-asc":
                return String(a.Name || "").localeCompare(String(b.Name || ""));
            case "pid-asc":
                return Number(a.ProcessId || 0) - Number(b.ProcessId || 0);
            default:
                return Number(b.MemoryMB || 0) - Number(a.MemoryMB || 0);
        }
    });

    if (!rows.length) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="services-empty">
                    ${App.processes.length
                        ? "Không có tiến trình phù hợp."
                        : "Chưa có dữ liệu tiến trình."}
                </td>
            </tr>`;
        return;
    }

    tbody.innerHTML = rows.map(process => {
        const pid = Number(process.ProcessId || 0);
        const name = String(process.Name || "Unknown");
        const pending = App.processActionPending.has(pid);
        const protectedNames = [
            "system",
            "system idle process",
            "registry",
            "smss.exe",
            "csrss.exe",
            "wininit.exe",
            "winlogon.exe",
            "services.exe",
            "lsass.exe"
        ];
        const protectedProcess =
            pid <= 4 ||
            protectedNames.includes(name.toLowerCase());

        return `
          <tr data-process-id="${pid}">
            <td>
              <div class="process-name-cell">
                <b title="${escapeHTML(name)}">${escapeHTML(name)}</b>
                <small title="${escapeHTML(process.ExecutablePath || process.CommandLine || "")}">
                  ${escapeHTML(process.ExecutablePath || "Không có đường dẫn")}
                </small>
              </div>
            </td>
            <td>${pid}</td>
            <td>
              <span class="process-cpu ${Number(process.CPUPercent || 0) >= 50 ? "high" : ""}">
                ${Number(process.CPUPercent || 0).toFixed(1)}%
              </span>
            </td>
            <td>${formatProcessMemory(process.MemoryMB)}</td>
            <td>${Number(process.SessionId || 0)}</td>
            <td>
              <button
                type="button"
                class="process-end-btn"
                data-process-action="terminate"
                data-process-id="${pid}"
                data-process-name="${escapeHTML(name)}"
                ${protectedProcess || pending ? "disabled" : ""}
                title="${protectedProcess ? "Tiến trình hệ thống được bảo vệ" : "Kết thúc tiến trình"}"
              >✕ End</button>
            </td>
          </tr>`;
    }).join("");
}

async function loadProcesses(pc, force = false) {
    if (!pc) return;

    if (!force && App.detailLoadedTabs.has("processes-data")) {
        renderProcesses();
        return;
    }

    App.detailLoadedTabs.add("processes-data");
    setLoadState("processesLoadState", "loading", "Đang tải");
    setText("processesMessage", "Đang đọc danh sách tiến trình...");

    try {
        const data = await fetchComputerSection(
            "/computer/processes",
            pc.Name,
            25000
        );

        if (!data.Success) {
            throw new Error(data.Diagnosis || data.Error || "Không tải được Processes.");
        }

        App.processes = Array.isArray(data.Processes) ? data.Processes : [];
        const topCPU = App.processes.reduce(
            (max, process) => Math.max(max, Number(process.CPUPercent || 0)),
            0
        );

        setText("processesTotal", data.Count ?? App.processes.length);
        setText(
            "processesMemory",
            formatProcessMemory(data.TotalMemoryMB || 0)
        );
        setText("processesTopCPU", `${topCPU.toFixed(1)}%`);
        setText(
            "processesMessage",
            `Đã tải ${App.processes.length} tiến trình từ ${pc.Name}.`
        );
        setLoadState("processesLoadState", "ok", "Xong");
        renderProcesses();
    } catch (error) {
        App.processes = [];
        setText("processesTotal", "0");
        setText("processesMemory", "0 MB");
        setText("processesTopCPU", "0%");
        setText("processesMessage", sectionErrorMessage(error));
        setLoadState("processesLoadState", "error", "Lỗi");
        renderProcesses();
    }
}

async function terminateProcess(processId, processName) {
    const pc = App.detailComputer;
    const pid = Number(processId || 0);
    if (!pc || pid <= 0) return;

    if (!window.confirm(
        `Xác nhận kết thúc "${processName}" (PID ${pid}) trên máy ${pc.Name}?\n\nDữ liệu chưa lưu của ứng dụng có thể bị mất.`
    )) {
        return;
    }

    App.processActionPending.add(pid);
    renderProcesses();
    setText(
        "processesMessage",
        `Đang kết thúc ${processName} (PID ${pid})...`
    );

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25000);

        let response;
        try {
            response = await fetch("/computer/process/terminate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                cache: "no-store",
                body: JSON.stringify({
                    computer: pc.Name,
                    processId: pid
                }),
                signal: controller.signal
            });
        } finally {
            clearTimeout(timer);
        }

        const text = await response.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            throw new Error(text || `HTTP ${response.status}`);
        }

        if (!response.ok || !data.Success) {
            throw new Error(data.Diagnosis || data.Error || `HTTP ${response.status}`);
        }

        App.processes = App.processes.filter(
            process => Number(process.ProcessId) !== pid
        );

        const totalMemory = App.processes.reduce(
            (sum, process) => sum + Number(process.MemoryMB || 0),
            0
        );
        const topCPU = App.processes.reduce(
            (max, process) => Math.max(max, Number(process.CPUPercent || 0)),
            0
        );

        setText("processesTotal", App.processes.length);
        setText("processesMemory", formatProcessMemory(totalMemory));
        setText("processesTopCPU", `${topCPU.toFixed(1)}%`);
        setText(
            "processesMessage",
            `Đã kết thúc ${data.ProcessName || processName} (PID ${pid}).`
        );
        setLoadState("processesLoadState", "ok", "Đã cập nhật");
    } catch (error) {
        setText(
            "processesMessage",
            `Không thể kết thúc ${processName}: ${sectionErrorMessage(error)}`
        );
        setLoadState("processesLoadState", "error", "Thao tác lỗi");
    } finally {
        App.processActionPending.delete(pid);
        renderProcesses();
    }
}


function softwareCsvValue(value) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function getFilteredSoftware() {
    const query = normalize($("softwareSearch")?.value || "");
    const architecture = $("softwareArchitectureFilter")?.value || "all";

    return App.software.filter(item => {
        const text = normalize(
            `${item.Name || ""} ${item.Version || ""} ` +
            `${item.Publisher || ""} ${item.InstallLocation || ""}`
        );
        return (
            (!query || text.includes(query)) &&
            (architecture === "all" || item.Architecture === architecture)
        );
    });
}

function renderSoftware() {
    const tbody = $("softwareTableBody");
    if (!tbody) return;

    const rows = getFilteredSoftware();
    setText("softwareVisible", rows.length);

    if (!rows.length) {
        tbody.innerHTML = `
          <tr>
            <td colspan="5" class="services-empty">
              ${App.software.length
                ? "Không có phần mềm phù hợp bộ lọc."
                : "Chưa có dữ liệu phần mềm."}
            </td>
          </tr>`;
        return;
    }

    tbody.innerHTML = rows.map(item => `
      <tr>
        <td>
          <div class="software-name-cell">
            <b title="${escapeHTML(item.Name || "")}">
              ${escapeHTML(item.Name || "Không rõ")}
            </b>
            <small title="${escapeHTML(item.InstallLocation || "")}">
              ${escapeHTML(item.InstallLocation || "Không có thư mục cài đặt")}
            </small>
          </div>
        </td>
        <td>${escapeHTML(item.Version || "—")}</td>
        <td>${escapeHTML(item.Publisher || "—")}</td>
        <td>${escapeHTML(item.InstallDate || "—")}</td>
        <td>
          <span class="software-arch ${item.Architecture === "64-bit" ? "x64" : "x86"}">
            ${escapeHTML(item.Architecture || "—")}
          </span>
        </td>
      </tr>`).join("");
}

async function loadSoftware(pc, force = false) {
    if (!pc) return;
    if (!force && App.detailLoadedTabs.has("software-data")) {
        renderSoftware();
        return;
    }

    App.detailLoadedTabs.add("software-data");
    setLoadState("softwareLoadState", "loading", "Đang tải");
    setText("softwareMessage", "Đang đọc Registry phần mềm...");

    try {
        const data = await fetchComputerSection(
            "/computer/software",
            pc.Name,
            40000
        );

        if (!data.Success) {
            throw new Error(data.Diagnosis || data.Error || "Không tải được phần mềm.");
        }

        App.software = Array.isArray(data.Software) ? data.Software : [];
        setText("softwareTotal", data.Count ?? App.software.length);
        setText("softwarePublishers", data.Publishers ?? 0);
        setText(
            "softwareMessage",
            `Đã tải ${App.software.length} phần mềm từ ${pc.Name}.`
        );
        setLoadState("softwareLoadState", "ok", "Xong");
        renderSoftware();
    } catch (error) {
        App.software = [];
        setText("softwareTotal", "0");
        setText("softwarePublishers", "0");
        setText("softwareVisible", "0");
        setText("softwareMessage", sectionErrorMessage(error));
        setLoadState("softwareLoadState", "error", "Lỗi");
        renderSoftware();
    }
}

function exportSoftwareCsv() {
    if (!App.detailComputer || !App.software.length) {
        setText("softwareMessage", "Chưa có dữ liệu để xuất.");
        return;
    }

    const rows = getFilteredSoftware();
    const csv = [
        ["Computer","Name","Version","Publisher","InstallDate","Architecture","InstallLocation"]
            .map(softwareCsvValue).join(","),
        ...rows.map(item => [
            App.detailComputer.Name,
            item.Name,
            item.Version,
            item.Publisher,
            item.InstallDate,
            item.Architecture,
            item.InstallLocation
        ].map(softwareCsvValue).join(","))
    ].join("\r\n");

    const blob = new Blob(["\ufeff" + csv], {
        type: "text/csv;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `InstalledSoftware_${App.detailComputer.Name}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    setText("softwareMessage", `Đã xuất ${rows.length} dòng ra CSV.`);
}


function selectedEventLevels() {
    return Array.from(
        document.querySelectorAll(".event-level-filters input:checked")
    ).map(input => Number(input.value));
}

function getFilteredEvents() {
    const query = normalize($("eventSearch")?.value || "");

    return App.events.filter(item => {
        if (!query) return true;

        const text = normalize(
            `${item.Id || ""} ${item.ProviderName || ""} ` +
            `${item.LevelName || ""} ${item.Message || ""} ` +
            `${item.TimeCreated || ""}`
        );

        return text.includes(query);
    });
}

function eventLevelClass(level) {
    if (Number(level) === 1) return "critical";
    if (Number(level) === 2) return "error";
    if (Number(level) === 3) return "warning";
    if (Number(level) === 4) return "information";
    return "unknown";
}

function eventMessagePreview(message) {
    const text = String(message || "").replace(/\s+/g, " ").trim();
    return text.length > 150 ? `${text.slice(0, 150)}…` : text;
}

function renderEvents() {
    const tbody = $("eventsTableBody");
    if (!tbody) return;

    const rows = getFilteredEvents();
    setText("eventsVisible", rows.length);

    if (!rows.length) {
        tbody.innerHTML = `
          <tr>
            <td colspan="5" class="services-empty">
              ${App.events.length
                ? "Không có Event phù hợp từ khóa."
                : "Chưa có dữ liệu Event Log."}
            </td>
          </tr>`;
        return;
    }

    tbody.innerHTML = rows.map((item, index) => `
      <tr class="event-row" data-event-index="${App.events.indexOf(item)}">
        <td class="event-time">${escapeHTML(item.TimeCreated || "—")}</td>
        <td>
          <span class="event-level-badge ${eventLevelClass(item.Level)}">
            ${escapeHTML(item.LevelName || "Unknown")}
          </span>
        </td>
        <td><b>${escapeHTML(item.Id ?? "—")}</b></td>
        <td class="event-provider" title="${escapeHTML(item.ProviderName || "")}">
          ${escapeHTML(item.ProviderName || "—")}
        </td>
        <td class="event-preview" title="Nhấp để xem đầy đủ">
          ${escapeHTML(eventMessagePreview(item.Message) || "—")}
        </td>
      </tr>`).join("");
}

function showEventDetail(item) {
    if (!item) return;

    App.selectedEvent = item;
    setText("eventDetailTitle", `${item.LevelName || "Event"} · ID ${item.Id ?? "—"}`);
    setText(
        "eventDetailMeta",
        `${item.TimeCreated || "—"} · ${item.ProviderName || "Không rõ nguồn"}`
    );
    setText("eventDetailLog", $("eventLogName")?.value || "—");
    setText("eventDetailRecord", item.RecordId ?? "—");
    setText("eventDetailMachine", item.MachineName || App.detailComputer?.Name || "—");
    setText("eventDetailUser", item.UserId || "—");
    setText("eventDetailMessage", item.Message || "Không có nội dung.");
    $("eventDetailBox").hidden = false;
    $("eventDetailBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideEventDetail() {
    App.selectedEvent = null;
    if ($("eventDetailBox")) $("eventDetailBox").hidden = true;
}

async function loadEvents(pc, force = false) {
    if (!pc) return;

    const logName = $("eventLogName")?.value || "System";
    const hours = Number($("eventTimeRange")?.value || 24);
    const levels = selectedEventLevels();
    const cacheKey = `events-data-${logName}-${hours}-${levels.join("-")}`;

    if (!levels.length) {
        App.events = [];
        setText("eventsMessage", "Hãy chọn ít nhất một mức độ Event.");
        setLoadState("eventsLoadState", "error", "Thiếu bộ lọc");
        renderEvents();
        return;
    }

    if (!force && App.detailLoadedTabs.has(cacheKey)) {
        renderEvents();
        return;
    }

    App.detailLoadedTabs.add(cacheKey);
    setLoadState("eventsLoadState", "loading", "Đang tải");
    setText(
        "eventsMessage",
        `Đang đọc ${logName} Log trong ${hours} giờ gần nhất...`
    );
    hideEventDetail();

    try {
        const response = await fetch("/computer/events", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                computer: pc.Name,
                logName,
                hours,
                levels,
                maxEvents: 300
            })
        });

        const data = await response.json();

        if (!response.ok || !data.Success) {
            throw new Error(data.Diagnosis || data.Error || "Không tải được Event Log.");
        }

        App.events = Array.isArray(data.Events) ? data.Events : [];
        setText("eventsTotal", data.Count ?? App.events.length);
        setText("eventsCritical", data.Critical ?? 0);
        setText("eventsError", data.ErrorCount ?? 0);
        setText("eventsWarning", data.Warning ?? 0);
        setText(
            "eventsMessage",
            `Đã tải ${App.events.length} Event từ ${logName} Log của ${pc.Name}.`
        );
        setLoadState("eventsLoadState", "ok", "Xong");
        renderEvents();
    } catch (error) {
        App.events = [];
        setText("eventsTotal", "0");
        setText("eventsCritical", "0");
        setText("eventsError", "0");
        setText("eventsWarning", "0");
        setText("eventsVisible", "0");
        setText("eventsMessage", sectionErrorMessage(error));
        setLoadState("eventsLoadState", "error", "Lỗi");
        renderEvents();
    }
}

function reloadEventsFromFilters() {
    if (!App.detailComputer) return;
    loadEvents(App.detailComputer, true);
}

function exportEventsCsv() {
    if (!App.detailComputer || !App.events.length) {
        setText("eventsMessage", "Chưa có Event Log để xuất.");
        return;
    }

    const rows = getFilteredEvents();
    const csv = [
        [
            "Computer",
            "LogName",
            "TimeCreated",
            "Level",
            "EventId",
            "Provider",
            "RecordId",
            "UserId",
            "Message"
        ].map(softwareCsvValue).join(","),
        ...rows.map(item => [
            App.detailComputer.Name,
            $("eventLogName")?.value || "",
            item.TimeCreated,
            item.LevelName,
            item.Id,
            item.ProviderName,
            item.RecordId,
            item.UserId,
            item.Message
        ].map(softwareCsvValue).join(","))
    ].join("\r\n");

    const blob = new Blob(["\ufeff" + csv], {
        type: "text/csv;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const logName = $("eventLogName")?.value || "Events";
    link.href = url;
    link.download = `${logName}_Events_${App.detailComputer.Name}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    setText("eventsMessage", `Đã xuất ${rows.length} Event ra CSV.`);
}


function remoteBoolText(value) {
    return value ? "OK" : "Không";
}

function renderRemoteSessions() {
    const body = $("remoteSessionsBody");
    const select = $("remoteMessageSession");
    if (!body || !select) return;

    setText("remoteSessionCount", App.remoteSessions.length);
    select.innerHTML = '<option value="-1">Tất cả session</option>' +
        App.remoteSessions.map(item =>
            `<option value="${Number(item.SessionId)}">${escapeHTML(item.UserName || "Unknown")} · ID ${Number(item.SessionId)}</option>`
        ).join("");

    if (!App.remoteSessions.length) {
        body.innerHTML = '<tr><td colspan="5" class="services-empty">Không có session hoặc không đọc được dữ liệu.</td></tr>';
        return;
    }

    body.innerHTML = App.remoteSessions.map(item => `
      <tr>
        <td><b>${escapeHTML(item.UserName || "—")}</b><small>${escapeHTML(item.SessionName || "")}</small></td>
        <td>${Number(item.SessionId)}</td>
        <td>${escapeHTML(item.State || "—")}</td>
        <td>${escapeHTML(item.IdleTime || "—")}</td>
        <td><button type="button" class="remote-row-action danger" data-logoff-session="${Number(item.SessionId)}" data-logoff-user="${escapeHTML(item.UserName || "")}">Logoff</button></td>
      </tr>`).join("");
}

function renderRemotePrinters() {
    const body = $("remotePrintersBody");
    if (!body) return;

    setText("remotePrinterCount", App.remotePrinters.length);
    if (!App.remotePrinters.length) {
        body.innerHTML = '<tr><td colspan="4" class="services-empty">Không có máy in hoặc không đọc được dữ liệu.</td></tr>';
        return;
    }

    body.innerHTML = App.remotePrinters.map(item => `
      <tr>
        <td><b>${escapeHTML(item.Name || "—")}</b></td>
        <td>${escapeHTML(item.DriverName || "—")}</td>
        <td>${escapeHTML(item.PortName || "—")}</td>
        <td>${item.Default ? '<span class="remote-ok">Có</span>' : "Không"}</td>
      </tr>`).join("");
}

async function remotePost(path, payload) {
    const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || data.Success === false) {
        throw new Error(data.Diagnosis || data.Error || "Thao tác thất bại.");
    }
    return data;
}

async function loadRemoteTools(pc, force = false) {
    if (!pc) return;
    if (!force && App.detailLoadedTabs.has("remote-data")) return;
    App.detailLoadedTabs.add("remote-data");

    setText("remoteMessage", `Đang kiểm tra ${pc.Name}...`);
    ["remotePing", "remoteSMB", "remoteRPC", "remoteWinRM", "remoteWMI", "remoteUser"].forEach(id => setText(id, "Đang tải"));
    setText("remoteResponse", "—");

    const statusPromise = remotePost("/computer/remote/status", { computer: pc.Name })
        .then(data => {
            setText("remotePing", data.Online ? "Online" : "Không phản hồi");
            setText("remoteResponse", data.ResponseMs == null ? "—" : `${data.ResponseMs} ms`);
            setText("remoteSMB", remoteBoolText(data.SMB));
            setText("remoteRPC", remoteBoolText(data.RPC));
            setText("remoteWinRM", remoteBoolText(data.WinRM));
            setText("remoteWMI", remoteBoolText(data.WMI));
            setText("remoteUser", data.LoggedOnUser || "Không xác định");
            return data;
        });

    const sessionsPromise = remotePost("/computer/remote/sessions", { computer: pc.Name })
        .then(data => {
            App.remoteSessions = Array.isArray(data.Sessions) ? data.Sessions : [];
            renderRemoteSessions();
            return data;
        })
        .catch(error => {
            App.remoteSessions = [];
            renderRemoteSessions();
            return { error: error.message };
        });

    const printersPromise = remotePost("/computer/remote/printers", { computer: pc.Name })
        .then(data => {
            App.remotePrinters = Array.isArray(data.Printers) ? data.Printers : [];
            renderRemotePrinters();
            return data;
        })
        .catch(error => {
            App.remotePrinters = [];
            renderRemotePrinters();
            return { error: error.message };
        });

    try {
        const [status, sessions, printers] = await Promise.all([statusPromise, sessionsPromise, printersPromise]);
        const notes = [];
        if (sessions.error) notes.push(`Session: ${sessions.error}`);
        if (printers.error) notes.push(`Printer: ${printers.error}`);
        setText("remoteMessage", notes.length
            ? `Đã kiểm tra kết nối. ${notes.join(" · ")}`
            : `Đã tải Remote Tools của ${pc.Name}.`);
    } catch (error) {
        setText("remoteMessage", sectionErrorMessage(error));
    }
}

async function openRemoteTool(tool) {
    if (!App.detailComputer) return;
    try {
        const data = await remotePost("/computer/remote/open", {
            computer: App.detailComputer.Name,
            tool
        });
        setText("remoteMessage", data.Message);
    } catch (error) {
        setText("remoteMessage", sectionErrorMessage(error));
    }
}

async function runRemotePower(action) {
    if (!App.detailComputer) return;
    const delay = Number($("remotePowerDelay")?.value || 30);
    const actionName = action === "restart" ? "khởi động lại" : action === "shutdown" ? "tắt máy" : "hủy lệnh tắt/khởi động lại";

    if (!confirm(`Xác nhận ${actionName} máy ${App.detailComputer.Name}?`)) return;

    try {
        const data = await remotePost("/computer/remote/power", {
            computer: App.detailComputer.Name,
            action,
            delaySeconds: delay,
            comment: "Thao tác từ DomainManager"
        });
        setText("remoteMessage", data.Message);
    } catch (error) {
        setText("remoteMessage", sectionErrorMessage(error));
    }
}

async function logoffRemoteSession(sessionId, username) {
    if (!App.detailComputer) return;
    if (!confirm(`Logoff ${username || "session"} (ID ${sessionId}) trên ${App.detailComputer.Name}?`)) return;

    try {
        const data = await remotePost("/computer/remote/session-action", {
            computer: App.detailComputer.Name,
            sessionId,
            action: "logoff"
        });
        setText("remoteMessage", data.Message);
        App.detailLoadedTabs.delete("remote-data");
        setTimeout(() => loadRemoteTools(App.detailComputer, true), 700);
    } catch (error) {
        setText("remoteMessage", sectionErrorMessage(error));
    }
}

async function sendRemotePopup() {
    if (!App.detailComputer) return;
    const message = $("remoteMessageText")?.value.trim() || "";
    const sessionId = Number($("remoteMessageSession")?.value || -1);

    if (!message) {
        setText("remoteMessage", "Hãy nhập nội dung thông báo.");
        return;
    }

    try {
        const data = await remotePost("/computer/remote/message", {
            computer: App.detailComputer.Name,
            sessionId,
            message,
            timeoutSeconds: 60
        });
        setText("remoteMessage", data.Message);
        $("remoteMessageText").value = "";
    } catch (error) {
        setText("remoteMessage", sectionErrorMessage(error));
    }
}

async function copyRemoteComputerName() {
    if (!App.detailComputer) return;
    try {
        await navigator.clipboard.writeText(App.detailComputer.Name);
        setText("remoteMessage", `Đã copy ${App.detailComputer.Name}.`);
    } catch {
        setText("remoteMessage", `Tên máy: ${App.detailComputer.Name}`);
    }
}

function activateDetailTab(tabName) {
    const selected = ["overview", "network", "services", "processes", "software", "events", "remote", "diagnostic"].includes(tabName)
        ? tabName
        : "overview";

    document.querySelectorAll(".detail-tab").forEach(button => {
        const active = button.dataset.detailTab === selected;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
    });

    document.querySelectorAll(".detail-tab-panel").forEach(panel => {
        const active = panel.dataset.detailPanel === selected;
        panel.hidden = !active;
        panel.classList.toggle("active", active);
    });

    if (!App.detailComputer) return;

    if (selected === "network" && !App.detailLoadedTabs.has("network")) {
        App.detailLoadedTabs.add("network");
        loadNetworkSection(App.detailComputer);
    }

    if (selected === "services") {
        loadServices(App.detailComputer);
    }

    if (selected === "processes") {
        loadProcesses(App.detailComputer);
    }

    if (selected === "software") {
        loadSoftware(App.detailComputer);
    }

    if (selected === "events") {
        loadEvents(App.detailComputer);
    }

    if (selected === "remote") {
        loadRemoteTools(App.detailComputer);
    }
}

function initializeDetailTabs() {
    document.querySelectorAll(".detail-tab").forEach(button => {
        button.addEventListener("click", () => {
            activateDetailTab(button.dataset.detailTab);
        });
    });

    $("serviceSearch")?.addEventListener("input", renderServices);
    $("serviceStatusFilter")?.addEventListener("change", renderServices);

    $("reloadServices")?.addEventListener("click", () => {
        if (!App.detailComputer) return;
        App.detailLoadedTabs.delete("services-data");
        loadServices(App.detailComputer, true);
    });

    $("servicesTableBody")?.addEventListener("click", event => {
        const button = event.target.closest("[data-service-action]");
        if (!button || button.disabled) return;

        runServiceAction(
            button.dataset.serviceName,
            button.dataset.serviceAction
        );
    });

    $("processSearch")?.addEventListener("input", renderProcesses);
    $("processSort")?.addEventListener("change", renderProcesses);

    $("reloadProcesses")?.addEventListener("click", () => {
        if (!App.detailComputer) return;
        App.detailLoadedTabs.delete("processes-data");
        loadProcesses(App.detailComputer, true);
    });

    $("processesTableBody")?.addEventListener("click", event => {
        const button = event.target.closest("[data-process-action='terminate']");
        if (!button || button.disabled) return;

        terminateProcess(
            Number(button.dataset.processId),
            button.dataset.processName
        );
    });

    $("softwareSearch")?.addEventListener("input", renderSoftware);
    $("softwareArchitectureFilter")?.addEventListener("change", renderSoftware);
    $("reloadSoftware")?.addEventListener("click", () => {
        if (!App.detailComputer) return;
        App.detailLoadedTabs.delete("software-data");
        loadSoftware(App.detailComputer, true);
    });
    $("exportSoftwareCsv")?.addEventListener("click", exportSoftwareCsv);

    $("eventSearch")?.addEventListener("input", renderEvents);

    $("eventLogName")?.addEventListener("change", reloadEventsFromFilters);
    $("eventTimeRange")?.addEventListener("change", reloadEventsFromFilters);

    document.querySelectorAll(".event-level-filters input").forEach(input => {
        input.addEventListener("change", reloadEventsFromFilters);
    });

    $("reloadEvents")?.addEventListener("click", reloadEventsFromFilters);
    $("exportEventsCsv")?.addEventListener("click", exportEventsCsv);
    $("closeEventDetail")?.addEventListener("click", hideEventDetail);

    $("eventsTableBody")?.addEventListener("click", event => {
        const row = event.target.closest("[data-event-index]");
        if (!row) return;
        showEventDetail(App.events[Number(row.dataset.eventIndex)]);
    });

    $("reloadRemote")?.addEventListener("click", () => {
        if (!App.detailComputer) return;
        App.detailLoadedTabs.delete("remote-data");
        loadRemoteTools(App.detailComputer, true);
    });

    document.querySelectorAll("[data-remote-open]").forEach(button => {
        button.addEventListener("click", () => openRemoteTool(button.dataset.remoteOpen));
    });

    document.querySelectorAll("[data-power-action]").forEach(button => {
        button.addEventListener("click", () => runRemotePower(button.dataset.powerAction));
    });

    $("copyRemoteName")?.addEventListener("click", copyRemoteComputerName);
    $("sendRemoteMessage")?.addEventListener("click", sendRemotePopup);

    $("remoteSessionsBody")?.addEventListener("click", event => {
        const button = event.target.closest("[data-logoff-session]");
        if (!button) return;
        logoffRemoteSession(
            Number(button.dataset.logoffSession),
            button.dataset.logoffUser
        );
    });

}

async function showComputerDetails(pc, forceRefresh = false) {
    if (!pc) return;

    App.detailComputer = pc;
    App.detailLoadedTabs = new Set();
    App.services = [];
    App.serviceActionPending = new Set();
    App.processes = [];
    App.processActionPending = new Set();
    App.software = [];
    App.events = [];
    App.selectedEvent = null;
    App.remoteSessions = [];
    App.remotePrinters = [];
    setText("remoteMessage", "Chọn tab Remote để kiểm tra máy đích.");
    setText("remoteSessionCount", "0");
    setText("remotePrinterCount", "0");
    if ($("remoteSessionsBody")) $("remoteSessionsBody").innerHTML = "";
    if ($("remotePrintersBody")) $("remotePrintersBody").innerHTML = "";
    setText("eventsTotal", "0");
    setText("eventsCritical", "0");
    setText("eventsError", "0");
    setText("eventsWarning", "0");
    setText("eventsVisible", "0");
    setText("eventsMessage", "Chọn tab Events để tải nhật ký.");
    if ($("eventsTableBody")) $("eventsTableBody").innerHTML = "";
    if ($("eventDetailBox")) $("eventDetailBox").hidden = true;
    setLoadState("eventsLoadState", "idle", "Chưa tải");
    setText("softwareTotal", "0");
    setText("softwarePublishers", "0");
    setText("softwareVisible", "0");
    setText("softwareMessage", "Chọn tab Software để tải danh sách.");
    if ($("softwareTableBody")) $("softwareTableBody").innerHTML = "";
    setLoadState("softwareLoadState", "idle", "Chưa tải");
    setText("processesTotal", "0");
    setText("processesMemory", "0 MB");
    setText("processesTopCPU", "0%");
    setText("processesMessage", "Chọn tab Processes để tải danh sách.");
    if ($("processesTableBody")) $("processesTableBody").innerHTML = "";
    setLoadState("processesLoadState", "idle", "Chưa tải");
    setText("servicesTotal", "0");
    setText("servicesRunning", "0");
    setText("servicesStopped", "0");
    setText("servicesMessage", "Chọn tab Services để tải danh sách.");
    if ($("servicesTableBody")) $("servicesTableBody").innerHTML = "";
    setLoadState("servicesLoadState", "idle", "Chưa tải");
    activateDetailTab("overview");
    App.detailRequestId = (App.detailRequestId || 0) + 1;
    const requestId = App.detailRequestId;

    const drawer = $("computerDrawer");
    const backdrop = $("computerDrawerBackdrop");

    drawer?.classList.add("show");
    backdrop?.classList.add("show");
    drawer?.setAttribute("aria-hidden", "false");
    backdrop?.setAttribute("aria-hidden", "false");

    setText("detailName", pc.Name || "—");
    resetComputerDetailFields(pc);

    const status = getStatus(pc);
    const statusEl = $("detailStatus");
    if (statusEl) {
        statusEl.className = `detail-status ${normalize(status)}`;
        statusEl.innerText = status === "Pending" ? "Đang kiểm tra" : status;
    }

    if ($("detailLoading")) $("detailLoading").hidden = true;
    if ($("detailContent")) $("detailContent").hidden = false;

    setText("detailIP", pc.IP || "—");
    setText("detailWindows", pc.OS || "—");
    setText("detailLastLogon", formatDate(pc.LastLogon));

    if (!forceRefresh) {
        setText(
            "detailDiagnosis",
            "Đang tải nhanh thông tin chung. Bấm ↻ để tải đầy đủ phần cứng và ổ đĩa."
        );

        ["hardwareLoadState", "disksLoadState"]
            .forEach(id => setLoadState(id, "idle", "Chưa tải"));

        // Tự tải nhóm nhẹ nhất để khi mở máy đã có User, Uptime và Windows.
        loadBasicSection(pc).then(result => {
            if (requestId !== App.detailRequestId) return;
            setText(
                "detailDiagnosis",
                result.Success
                    ? "Thông tin chung đã sẵn sàng. Chọn Network hoặc Chẩn đoán để kiểm tra thêm."
                    : "Không lấy được thông tin chung. Có thể chạy Diagnostic để tìm nguyên nhân."
            );
        });

        return;
    }

    const refreshBtn = $("detailRefresh");
    refreshBtn?.classList.add("loading");
    const errors = [];

    try {
        const sections = [
            ["Thông tin chung", loadBasicSection],
            ["Phần cứng", loadHardwareSection],
            ["Network", loadNetworkSection],
            ["Ổ đĩa", loadDisksSection]
        ];

        let successCount = 0;
        for (const [label, loader] of sections) {
            const result = await loader(pc);
            if (requestId !== App.detailRequestId) return;
            if (result.Success) successCount++;
            else if (result.Error) errors.push(`${label}: ${result.Error}`);
        }

        setText(
            "detailDiagnosis",
            successCount === 4
                ? "Đã lấy đầy đủ 4 nhóm dữ liệu."
                : `Đã lấy được ${successCount}/4 nhóm dữ liệu. Diagnostic hoạt động độc lập.`
        );
    } finally {
        refreshBtn?.classList.remove("loading");

        const errorBox = $("detailErrorBox");
        if (errorBox) {
            errorBox.hidden = errors.length === 0;
            setText("detailErrorText", errors.join(" | "));
        }
    }
}


function toggleComputerDrawerExpanded(forceState = null) {
    const drawer = $("computerDrawer");
    const button = $("detailExpand");
    if (!drawer) return;

    const expanded = forceState === null
        ? !drawer.classList.contains("expanded")
        : Boolean(forceState);

    drawer.classList.toggle("expanded", expanded);
    document.body.classList.toggle("computer-drawer-expanded", expanded);

    if (button) {
        button.innerText = expanded ? "⤢" : "⛶";
        button.title = expanded ? "Thu nhỏ Computer Manager" : "Mở toàn màn hình";
        button.setAttribute("aria-label", button.title);
    }
}

function closeComputerDetails() {
    toggleComputerDrawerExpanded(false);
    $("computerDrawer")?.classList.remove("show");
    $("computerDrawerBackdrop")?.classList.remove("show");
    $("computerDrawer")?.setAttribute("aria-hidden", "true");
    $("computerDrawerBackdrop")?.setAttribute("aria-hidden", "true");
    App.detailComputer = null;
}

function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!value) return "0 GB";
    return `${(value / 1073741824).toFixed(1)} GB`;
}

function formatUptime(seconds) {
    const value = Number(seconds || 0);
    if (!value) return "—";

    const days = Math.floor(value / 86400);
    const hours = Math.floor((value % 86400) / 3600);
    const minutes = Math.floor((value % 3600) / 60);

    const parts = [];
    if (days) parts.push(`${days} ngày`);
    if (hours) parts.push(`${hours} giờ`);
    if (!days && minutes) parts.push(`${minutes} phút`);
    return parts.join(" ") || "Dưới 1 phút";
}


function diagnosticStatusLabel(status) {
    switch (String(status || "").toLowerCase()) {
        case "ok": return "THÀNH CÔNG";
        case "warning": return "CẢNH BÁO";
        case "info": return "THÔNG TIN";
        default: return "THẤT BẠI";
    }
}

const DIAGNOSTIC_TESTS = [
    { id: "dns", name: "DNS Resolve", group: "Kết nối" },
    { id: "ping", name: "Ping ICMP", group: "Kết nối" },
    { id: "rpc", name: "RPC Endpoint", group: "Kết nối" },
    { id: "smb", name: "SMB", group: "Kết nối" },
    { id: "winrm_http", name: "WinRM HTTP", group: "Tùy chọn" },
    { id: "winrm_https", name: "WinRM HTTPS", group: "Tùy chọn" },
    { id: "admin_share", name: "Admin Share C$", group: "Quản trị" },
    { id: "wmi", name: "WMI/DCOM", group: "Quản trị" },
    { id: "cim", name: "CIM DCOM", group: "Quản trị" },
    { id: "wsman", name: "PowerShell Remoting", group: "Tùy chọn" },
    { id: "winmgmt", name: "Dịch vụ Winmgmt", group: "Dịch vụ" },
    { id: "eventlog", name: "Remote Event Log", group: "Dịch vụ" }
];

function splitDiagnosticDetail(rawDetail) {
    const value = String(rawDetail || "—");
    const separator = value.indexOf("||");

    if (separator < 0) {
        return { summary: value, technical: "" };
    }

    return {
        summary: value.slice(0, separator).trim() || "Không có thông tin.",
        technical: value.slice(separator + 2).trim()
    };
}

function normalizeDiagnosticStatus(value) {
    const status = String(value || "fail").toLowerCase();
    return ["ok", "warning", "info", "fail"].includes(status) ? status : "fail";
}

function renderDiagnosticProgress(results, runningId = "") {
    const box = $("diagnosticResults");
    if (!box) return;

    box.innerHTML = DIAGNOSTIC_TESTS.map(test => {
        const result = results[test.id];
        const running = test.id === runningId;
        const status = result ? normalizeDiagnosticStatus(result.Status) : "info";
        const label = result
            ? diagnosticStatusLabel(status)
            : (running ? "ĐANG CHẠY" : "ĐANG CHỜ");

        const parsed = splitDiagnosticDetail(
            result
                ? result.Detail
                : (running ? "Đang thực hiện kiểm tra..." : "Chưa chạy.")
        );

        const technical = parsed.technical
            ? `<details class="diagnostic-technical">
                    <summary>Xem chi tiết kỹ thuật</summary>
                    <pre>${escapeHTML(parsed.technical)}</pre>
               </details>`
            : "";

        return `
            <div class="diagnostic-item ${running ? "is-running" : ""}">
                <div class="test-name">
                    ${escapeHTML(test.name)}
                    <small>${escapeHTML(test.group)}</small>
                </div>
                <span class="test-status ${escapeHTML(status)}">${label}</span>
                <div class="test-detail">${escapeHTML(parsed.summary)}${technical}</div>
            </div>`;
    }).join("");
}

function updateDiagnosticSummary(results, finished = false) {
    const summary = $("diagnosticSummary");
    if (!summary) return;

    const completed = DIAGNOSTIC_TESTS
        .map(test => results[test.id])
        .filter(Boolean);

    const counts = completed.reduce((acc, item) => {
        const status = normalizeDiagnosticStatus(item.Status);
        acc[status] = (acc[status] || 0) + 1;
        return acc;
    }, { ok: 0, warning: 0, info: 0, fail: 0 });

    const total = DIAGNOSTIC_TESTS.length;
    const done = completed.length;
    const remaining = Math.max(0, total - done);

    summary.className = finished
        ? `diagnostic-summary ${counts.fail ? "error" : (counts.warning ? "warning" : "ok")}`
        : "diagnostic-summary";

    if (!finished) {
        summary.innerText =
            `Đã hoàn thành ${done}/${total}: ${counts.ok} thành công, ` +
            `${counts.warning} cảnh báo, ${counts.fail} thất bại` +
            (remaining ? `, còn ${remaining} kiểm tra.` : ".");
        return;
    }

    const optionalWarnings = ["winrm_http", "winrm_https", "wsman"]
        .filter(id => normalizeDiagnosticStatus(results[id]?.Status) === "warning")
        .length;

    let note = "";
    if (!counts.fail && optionalWarnings) {
        note = " Máy tính vẫn có thể quản trị qua WMI/DCOM; WinRM là tùy chọn.";
    } else if (counts.fail === 1 && normalizeDiagnosticStatus(results.admin_share?.Status) === "fail") {
        note = " Lỗi C$ thường liên quan quyền quản trị hoặc chia sẻ quản trị, không ảnh hưởng WMI/DCOM.";
    }

    summary.innerText =
        `Hoàn tất đủ ${done}/${total} kiểm tra: ${counts.ok} thành công, ` +
        `${counts.warning} cảnh báo, ${counts.fail} thất bại.${note}`;
}

async function runComputerDiagnostic() {
    const pc = App.detailComputer;
    if (!pc) return;

    const button = $("runDiagnostic");
    const results = {};

    if (button) {
        button.disabled = true;
        button.innerText = "Đang kiểm tra...";
    }

    renderDiagnosticProgress(results);
    updateDiagnosticSummary(results);

    try {
        for (const test of DIAGNOSTIC_TESTS) {
            renderDiagnosticProgress(results, test.id);

            try {
                const data = await fetchComputerSection(
                    "/computer/diagnostic/test",
                    pc.Name,
                    13000,
                    { test: test.id }
                );

                results[test.id] = {
                    Status: normalizeDiagnosticStatus(data.Status),
                    Detail: data.Detail || "Không có thông tin."
                };
            } catch (error) {
                results[test.id] = {
                    Status: "fail",
                    Detail: error?.name === "AbortError"
                        ? "Máy chủ không phản hồi sau 13 giây.||Xem file logs\\server.log để biết chi tiết."
                        : `Không thể chạy phép thử.||${error?.message || "Lỗi không xác định."}`
                };
            }

            renderDiagnosticProgress(results);
            updateDiagnosticSummary(results);
        }

        updateDiagnosticSummary(results, true);
    } finally {
        if (button) {
            button.disabled = false;
            button.innerText = "Chạy lại";
        }
    }
}

function initializeComputerDrawer() {
    $("detailClose")?.addEventListener("click", closeComputerDetails);
    $("detailExpand")?.addEventListener("click", () => toggleComputerDrawerExpanded());
    $("runDiagnostic")?.addEventListener("click", runComputerDiagnostic);
    $("detailRefresh")?.addEventListener("click", () => {
        if (App.detailComputer) showComputerDetails(App.detailComputer, true);
    });
    $("computerDrawerBackdrop")?.addEventListener("click", closeComputerDetails);

    document.querySelectorAll("[data-detail-action]").forEach(button => {
        button.addEventListener("click", async () => {
            const pc = App.detailComputer;
            if (!pc) return;

            const action = button.dataset.detailAction;

            if (action === "restart" || action === "shutdown") {
                requestDangerAction(action, pc);
                return;
            }

            await runComputerAction(action, pc);

            if (action === "ping") {
                const status = getStatus(pc);
                const statusEl = $("detailStatus");
                if (statusEl) {
                    statusEl.className = `detail-status ${normalize(status)}`;
                    statusEl.innerText = status;
                }
                setText("detailIP", pc.IP || "—");
            }
        });
    });
}

function requestDangerAction(action, pc) {
    if (!$("confirmModal")) {
        if (confirm(`${action === "restart" ? "Khởi động lại" : "Tắt"} máy ${pc.Name}?`)) {
            runComputerAction(action, pc);
        }
        return;
    }

    setText("confirmTitle", action === "restart" ? "Khởi động lại máy" : "Tắt máy");
    setText("confirmText", `Bạn đang thực hiện thao tác trên máy ${pc.Name}.`);
    $("confirmInput").value = "";
    $("acceptConfirm").disabled = true;
    $("confirmModal").classList.add("show");
    $("confirmModal").setAttribute("aria-hidden", "false");
    App.pendingAction = { action, pc };
    $("confirmInput").focus();
}

function closeConfirmModal() {
    $("confirmModal")?.classList.remove("show");
    $("confirmModal")?.setAttribute("aria-hidden", "true");
    App.pendingAction = null;
}

function updateDashboard() {
    const total = App.computers.length;
    const online = App.computers.filter(pc => getStatus(pc) === "Online").length;
    const offline = App.computers.filter(pc => getStatus(pc) === "Offline").length;
    const pending = Math.max(0, total - online - offline);
    const enabled = App.computers.filter(pc => pc.Enabled !== false).length;
    const disabled = total - enabled;
    const onlinePercent = total ? Math.round(online * 100 / total) : 0;
    const offlinePercent = total ? Math.round(offline * 100 / total) : 0;

    const win11 = App.computers.filter(pc => normalize(pc.OS).includes("windows 11")).length;
    const win10 = App.computers.filter(pc => normalize(pc.OS).includes("windows 10")).length;
    const server = App.computers.filter(pc => normalize(pc.OS).includes("server")).length;
    const otherOs = Math.max(0, total - win11 - win10 - server);

    setText("total", total);
    setText("online", online);
    setText("offline", offline);
    setText("pending", pending);
    setText("onlineRate", `${onlinePercent}% tổng số máy`);
    setText("offlineRate", `${offlinePercent}% tổng số máy`);
    setText("legendOnline", online);
    setText("legendOffline", offline);
    setText("legendPending", pending);
    setText("donutPercent", onlinePercent + "%");
    setText("enabled", enabled);
    setText("disabled", disabled);
    setText("win11", win11);
    setText("win10", win10);
    setText("server", server);
    setText("otherOs", otherOs);
    setText("osTotal", `${total} thiết bị`);
    setText("healthText", disabled ? `${disabled} tài khoản máy đã bị Disabled.` : "Tất cả tài khoản máy đang hoạt động.");

    const donut = $("statusDonut");
    if (donut) {
        const a = total ? online * 360 / total : 0;
        const b = total ? offline * 360 / total : 0;
        donut.style.background = `conic-gradient(var(--green) 0deg ${a}deg,var(--red) ${a}deg ${a+b}deg,var(--orange) ${a+b}deg 360deg)`;
    }

    setBar("win11Bar", win11, total);
    setBar("win10Bar", win10, total);
    setBar("serverBar", server, total);
    setBar("otherOsBar", otherOs, total);
    setBar("enabledBar", enabled, total);
    updateStatistics();
}

function setBar(id, value, total) {
    const el = $(id);
    if (el) el.style.width = (total ? Math.round(value * 100 / total) : 0) + "%";
}

function exportCSV() {
    const rows = [["Tên máy", "Trạng thái", "Địa chỉ IP", "Hệ điều hành", "Last Logon", "OU"]];

    App.filtered.forEach(pc => {
        rows.push([pc.Name || "", getStatus(pc), pc.IP || "", pc.OS || "", pc.LastLogon || "", pc.OU || ""]);
    });

    const csv = "\uFEFF" + rows.map(row =>
        row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")
    ).join("\r\n");

    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `DomainManager_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);

    showToast("Xuất dữ liệu", `Đã xuất ${App.filtered.length} máy`);
}

function initializeTableEvents() {
    $("search")?.addEventListener("input", applyFilters);
    $("statusFilter")?.addEventListener("change", applyFilters);
    $("osFilter")?.addEventListener("change", applyFilters);
    $("ouFilter")?.addEventListener("change", applyFilters);

    $("pageSize")?.addEventListener("change", () => {
        App.pageSize = Number($("pageSize").value);
        App.page = 1;
        renderTable();
    });

    $("clearFilters")?.addEventListener("click", () => {
        $("search").value = "";
        $("statusFilter").value = "";
        $("osFilter").value = "";
        $("ouFilter").value = "";
        applyFilters();
    });

    $("prev")?.addEventListener("click", () => {
        if (App.page > 1) {
            App.page--;
            renderTable();
        }
    });

    $("next")?.addEventListener("click", () => {
        const totalPages = Math.ceil(App.filtered.length / App.pageSize);
        if (App.page < totalPages) {
            App.page++;
            renderTable();
        }
    });

    $("selectAll")?.addEventListener("change", event => {
        document.querySelectorAll(".row-check").forEach(check => {
            check.checked = event.target.checked;
            if (check.checked) App.selected.add(check.dataset.name);
            else App.selected.delete(check.dataset.name);
        });
    });

    document.querySelectorAll("th[data-sort]").forEach(th => {
        th.addEventListener("click", () => {
            const field = th.dataset.sort;
            if (App.sortField === field) App.sortAsc = !App.sortAsc;
            else {
                App.sortField = field;
                App.sortAsc = true;
            }
            sortData();
            renderTable();
        });
    });
}

function initializeContextMenu() {
    $("contextMenu")?.querySelectorAll("[data-action]").forEach(button => {
        button.addEventListener("click", async () => {
            const action = button.dataset.action;
            const pc = App.contextComputer;
            hideContextMenu();
            if (!pc) return;

            if (action === "details") return showComputerDetails(pc);
            if (action === "copy-name") return copyText(pc.Name, "Tên máy");
            if (action === "copy-ip") return copyText(pc.IP, "Địa chỉ IP");
            if (action === "restart" || action === "shutdown") return requestDangerAction(action, pc);

            await runComputerAction(action, pc);
        });
    });

    document.addEventListener("click", hideContextMenu);
    document.addEventListener("scroll", hideContextMenu, true);
    window.addEventListener("resize", hideContextMenu);
}

function initializeConfirmModal() {
    $("confirmInput")?.addEventListener("input", event => {
        const expected = App.pendingAction?.pc?.Name || "";
        $("acceptConfirm").disabled =
            normalize(event.target.value) !== normalize(expected);
    });

    $("cancelConfirm")?.addEventListener("click", closeConfirmModal);

    $("acceptConfirm")?.addEventListener("click", async () => {
        const pending = App.pendingAction;
        closeConfirmModal();
        if (pending) await runComputerAction(pending.action, pending.pc);
    });

    $("confirmModal")?.addEventListener("click", event => {
        if (event.target === $("confirmModal")) closeConfirmModal();
    });
}

function initializeInterface() {
    $("refreshBtn")?.addEventListener("click", () => loadData(true));
    $("exportBtn")?.addEventListener("click", exportCSV);
    $("statisticsExportBtn")?.addEventListener("click", exportCSV);

    const autoRefresh = $("autoRefresh");
    if (autoRefresh) {
        autoRefresh.checked =
            localStorage.getItem("domain-auto-refresh") === "1";

        const configureAutoRefresh = enabled => {
            clearInterval(App.refreshTimer);
            App.refreshTimer = null;
            localStorage.setItem("domain-auto-refresh", enabled ? "1" : "0");

            if (enabled) {
                App.refreshTimer = setInterval(
                    refreshStatuses,
                    5 * 60 * 1000
                );
            }
        };

        configureAutoRefresh(autoRefresh.checked);

        autoRefresh.addEventListener("change", event => {
            configureAutoRefresh(event.target.checked);

            if (event.target.checked) {
                showToast(
                    "Tự làm mới",
                    "Mỗi 5 phút chỉ quét trạng thái, không tải lại AD"
                );
            } else {
                showToast("Tự làm mới", "Đã tắt");
            }
        });
    }

    $("sidebarToggle")?.addEventListener("click", () => {
        const sidebar = $("sidebar");
        if (!sidebar) return;

        if (window.matchMedia("(max-width: 850px)").matches) {
            sidebar.classList.toggle("mobile-open");
        } else {
            sidebar.classList.toggle("collapsed");
            const collapsed = sidebar.classList.contains("collapsed");
            localStorage.setItem(
                "domain-sidebar-collapsed",
                collapsed ? "1" : "0"
            );
            const toggle = $("sidebarToggle");
            if (toggle) {
                toggle.title = collapsed ? "Mở rộng menu" : "Thu gọn menu";
                toggle.setAttribute("aria-label", toggle.title);
            }
        }
    });

    // V10.3.2: mở đầy đủ sidebar khi tải phiên bản mới.
    // Trạng thái cũ đã ẩn cả nút mở lại sau khi menu bị thu gọn.
    localStorage.removeItem("domain-sidebar-collapsed");
    $("sidebar")?.classList.remove("collapsed");

    const savedTheme = localStorage.getItem("domain-theme");
    if (savedTheme === "dark") document.body.classList.add("dark");

    const updateThemeIcon = () => {
        if ($("themeBtn")) $("themeBtn").innerText =
            document.body.classList.contains("dark") ? "☀" : "☾";
    };

    updateThemeIcon();

    $("themeBtn")?.addEventListener("click", () => {
        document.body.classList.toggle("dark");
        localStorage.setItem("domain-theme",
            document.body.classList.contains("dark") ? "dark" : "light");
        updateThemeIcon();
    });

    const updateClock = () => {
        const now = new Date();
        setText("clockTime", now.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }));
        setText("clockDate", now.toLocaleDateString("vi-VN"));
    };

    updateClock();
    setInterval(updateClock, 1000);

    document.addEventListener("keydown", event => {
        if (event.ctrlKey && event.key.toLowerCase() === "k") {
            event.preventDefault();
            showView("computers");
            setTimeout(() => {
                $("search")?.focus();
                $("search")?.select();
            }, 80);
        }

        if (event.key === "Escape") {
            hideContextMenu();
            closeConfirmModal();
            const drawer = $("computerDrawer");
            if (drawer?.classList.contains("expanded")) {
                toggleComputerDrawerExpanded(false);
            } else {
                closeComputerDetails();
            }
        }
    });
}



// ==========================================================
// V11.2 - ACTIVE DIRECTORY USER PROFESSIONAL
// ==========================================================
function adUserStatus(user) {
    if (user.Locked) return '<span class="badge error">Bị khóa</span>';
    return user.Enabled ? '<span class="badge online">Enabled</span>' : '<span class="badge offline">Disabled</span>';
}

function updateAdUserSummary(users) {
    setText('adUserCount', users.length);
    setText('adUserEnabled', users.filter(u => u.Enabled).length);
    setText('adUserDisabled', users.filter(u => !u.Enabled).length);
    setText('adUserLocked', users.filter(u => u.Locked).length);
}

function getOuPathFromDn(dn) {
    const matches = [...String(dn || '').matchAll(/(?:^|,)OU=([^,]+)/gi)].map(match => match[1].replace(/\\,/g, ','));
    return matches.reverse().join(' / ');
}

function renderAdOuTree() {
    const tree = $('adOuTree');
    if (!tree) return;
    const counts = new Map();
    App.adUsers.forEach(user => {
        const path = getOuPathFromDn(user.DistinguishedName) || '(Users mặc định)';
        counts.set(path, (counts.get(path) || 0) + 1);
    });
    const rows = [...counts.entries()].sort((a,b) => a[0].localeCompare(b[0], 'vi'));
    tree.innerHTML = `<button class="ad-ou-item ${App.adSelectedOu === '' ? 'active' : ''}" data-ou-path=""><span>▣</span><b>Tất cả người dùng</b><em>${App.adUsers.length}</em></button>` + rows.map(([path,count]) => {
        const depth = path === '(Users mặc định)' ? 0 : Math.max(0, path.split(' / ').length - 1);
        const label = path === '(Users mặc định)' ? path : path.split(' / ').at(-1);
        return `<button class="ad-ou-item ${App.adSelectedOu === path ? 'active' : ''}" data-ou-path="${escapeHTML(path)}" style="--ou-depth:${depth}"><span>⌗</span><b title="${escapeHTML(path)}">${escapeHTML(label)}</b><em>${count}</em></button>`;
    }).join('');
    tree.querySelectorAll('[data-ou-path]').forEach(button => button.addEventListener('click', () => {
        App.adSelectedOu = button.dataset.ouPath || '';
        App.selectedAdUser = null;
        renderAdOuTree();
        renderAdUsers();
        renderEmptyAdUserDetail();
    }));
}

function getFilteredAdUsers() {
    const status = $('adUserStatusFilter')?.value || '';
    const term = normalize($('adUserSearch')?.value || '');
    return App.adUsers.filter(user => {
        if (status === 'enabled' && !user.Enabled) return false;
        if (status === 'disabled' && user.Enabled) return false;
        if (status === 'locked' && !user.Locked) return false;
        if (status === 'expired' && !user.PasswordExpired) return false;
        if (status === 'never' && user.LastLogon) return false;
        const ouPath = getOuPathFromDn(user.DistinguishedName) || '(Users mặc định)';
        if (App.adSelectedOu && ouPath !== App.adSelectedOu) return false;
        if (term) {
            const haystack = normalize([user.SamAccountName,user.DisplayName,user.Email,user.UserPrincipalName,user.Department,user.Title,user.Telephone,user.Mobile,user.Office,user.Company,user.Description,ouPath].join(' '));
            if (!haystack.includes(term)) return false;
        }
        return true;
    });
}

function renderAdUsers() {
    const body = $('adUsersBody');
    if (!body) return;
    const users = getFilteredAdUsers();
    body.innerHTML = users.length ? users.map(user => `
      <tr data-ad-sam="${escapeHTML(user.SamAccountName)}" class="${App.selectedAdUser?.SamAccountName === user.SamAccountName ? 'selected' : ''}">
        <td><b>${escapeHTML(user.SamAccountName)}</b><small>${escapeHTML(user.UserPrincipalName || '')}</small></td>
        <td>${escapeHTML(user.DisplayName || '—')}</td><td>${escapeHTML(user.Department || '—')}</td><td>${escapeHTML(user.Email || '—')}</td>
        <td>${adUserStatus(user)}</td><td>${formatDate(user.LastLogon)}</td>
      </tr>`).join('') : '<tr><td colspan="6" class="empty">Không có tài khoản phù hợp.</td></tr>';
    body.querySelectorAll('tr[data-ad-sam]').forEach(row => {
        row.addEventListener('click', () => selectAdUser(row.dataset.adSam));
        row.addEventListener('dblclick', () => { selectAdUser(row.dataset.adSam); $('adUserDetail')?.scrollIntoView({behavior:'smooth', block:'nearest'}); });
        row.addEventListener('contextmenu', event => { event.preventDefault(); selectAdUser(row.dataset.adSam); showAdUserContextMenu(event.clientX, event.clientY); });
    });
    const status = $('adUsersStatus');
    if (status && App.adUsers.length) status.innerHTML = `<div><span>Đang hiển thị ${users.length} / ${App.adUsers.length} tài khoản</span><small>${escapeHTML(App.adSelectedOu || 'Toàn bộ Domain')}</small></div>`;
}

function renderEmptyAdUserDetail() {
    const box = $('adUserDetail');
    if (box) box.innerHTML = '<div class="ad-user-empty"><b>Chọn một tài khoản</b><p>Thông tin và thao tác quản trị sẽ hiển thị tại đây.</p></div>';
}

function managerNameFromDn(dn) {
    const match = String(dn || '').match(/^CN=((?:\\.|[^,])*)/i);
    return match ? match[1].replace(/\\,/g, ',').replace(/\\([\\#+<>;=" ])/g, '$1') : (dn || '—');
}

function adFlag(label, on, kind='ok') {
    return `<span class="ad-flag ${on ? kind : 'muted'}">${on ? '✓' : '—'} ${escapeHTML(label)}</span>`;
}

function selectedAdUserText(user) {
    const ouPath = getOuPathFromDn(user.DistinguishedName) || '(Users mặc định)';
    return [`Tài khoản: ${user.SamAccountName || ''}`,`Họ tên: ${user.DisplayName || ''}`,`UPN: ${user.UserPrincipalName || ''}`,`Email: ${user.Email || ''}`,`Điện thoại: ${user.Telephone || user.Mobile || ''}`,`Phòng ban: ${user.Department || ''}`,`Chức danh: ${user.Title || ''}`,`Đơn vị: ${user.Company || ''}`,`Văn phòng: ${user.Office || ''}`,`OU: ${ouPath}`,`Trạng thái: ${user.Enabled ? 'Enabled' : 'Disabled'}${user.Locked ? ' / Locked' : ''}`,`Last Logon: ${formatDate(user.LastLogon)}`].join('\n');
}

async function copySelectedAdUser() {
    const user = App.selectedAdUser;
    if (!user) return showToast('Copy thông tin', 'Chưa chọn tài khoản.', false);
    try { await navigator.clipboard.writeText(selectedAdUserText(user)); showToast('Copy thông tin', `Đã copy ${user.SamAccountName}.`); }
    catch { showToast('Copy thông tin', 'Trình duyệt không cho phép copy.', false); }
}

function selectAdUser(sam) {
    App.selectedAdUser = App.adUsers.find(u => u.SamAccountName === sam) || null;
    const copyBtn = $('adUserCopyBtn'); if (copyBtn) copyBtn.disabled = !App.selectedAdUser; const permissionBtn=$('adPermissionBtn'); if(permissionBtn) permissionBtn.disabled=!App.selectedAdUser;
    renderAdUsers();
    const user = App.selectedAdUser, box = $('adUserDetail');
    if (!box || !user) return;
    const ouPath = getOuPathFromDn(user.DistinguishedName) || '(Users mặc định)';
    box.innerHTML = `<div class="ad-user-profile"><div class="ad-user-avatar">${escapeHTML((user.DisplayName || user.SamAccountName || '?').charAt(0).toUpperCase())}</div><div><h3>${escapeHTML(user.DisplayName || user.SamAccountName)}</h3><p>${escapeHTML(user.SamAccountName)}${user.UserPrincipalName ? ` · ${escapeHTML(user.UserPrincipalName)}` : ''}</p>${adUserStatus(user)}</div></div>
      <div class="ad-user-flags">${adFlag('Đang hoạt động',user.Enabled,'ok')}${adFlag('Bị khóa',user.Locked,'warn')}${adFlag('Mật khẩu không hết hạn',user.PasswordNeverExpires,'info')}${adFlag('Mật khẩu hết hạn',user.PasswordExpired,'danger')}</div>
      <dl class="ad-user-fields"><div><dt>Email</dt><dd>${escapeHTML(user.Email || '—')}</dd></div><div><dt>Điện thoại</dt><dd>${escapeHTML(user.Telephone || user.Mobile || '—')}</dd></div><div><dt>Chức danh</dt><dd>${escapeHTML(user.Title || '—')}</dd></div><div><dt>Phòng ban</dt><dd>${escapeHTML(user.Department || '—')}</dd></div><div><dt>Công ty / đơn vị</dt><dd>${escapeHTML(user.Company || '—')}</dd></div><div><dt>Văn phòng</dt><dd>${escapeHTML(user.Office || '—')}</dd></div><div><dt>Quản lý</dt><dd>${escapeHTML(managerNameFromDn(user.Manager))}</dd></div><div><dt>OU</dt><dd>${escapeHTML(ouPath)}</dd></div><div><dt>Đăng nhập cuối</dt><dd>${formatDate(user.LastLogon)}</dd></div><div><dt>Đổi mật khẩu cuối</dt><dd>${formatDate(user.PasswordLastSet)}</dd></div><div><dt>Ngày tạo</dt><dd>${formatDate(user.Created)}</dd></div>${user.Description ? `<div><dt>Mô tả</dt><dd>${escapeHTML(user.Description)}</dd></div>` : ''}<div><dt>DN</dt><dd class="dn">${escapeHTML(user.DistinguishedName || '—')}</dd></div></dl>
      <div class="ad-user-actions"><h4>Thao tác tài khoản</h4>${user.Locked ? '<button data-ad-action="unlock" class="primary-btn">🔓 Mở khóa</button>' : ''}${user.Enabled ? '<button data-ad-action="disable" class="danger-btn">⊘ Vô hiệu hóa</button>' : '<button data-ad-action="enable" class="primary-btn">✓ Kích hoạt</button>'}<button data-ad-action="reset-password" class="secondary-btn">🔑 Đặt lại mật khẩu</button><button data-ad-copy class="secondary-btn">⧉ Copy thông tin</button></div>`;
    box.querySelectorAll('[data-ad-action]').forEach(btn => btn.addEventListener('click', () => runAdUserAction(btn.dataset.adAction)));
    box.querySelector('[data-ad-copy]')?.addEventListener('click', copySelectedAdUser);
}

async function loadAdUsers() {
    const status = $('adUsersStatus');
    if (status) status.innerHTML = '<div><span>Đang truy vấn Active Directory...</span><small>Vui lòng chờ</small></div>';
    try {
        const result = await api('/ad/users', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({search:'', limit:2000})});
        if (!result.Success) throw new Error(result.Error || 'Không tải được người dùng.');
        App.adUsers = Array.isArray(result.Users) ? result.Users : [];
        App.selectedAdUser = null;
        App.adSelectedOu = '';
        updateAdUserSummary(App.adUsers);
        renderAdOuTree();
        renderAdUsers();
        renderEmptyAdUserDetail();
        if (status) status.innerHTML = `<div><span>Đã tải ${App.adUsers.length} tài khoản</span><small>${escapeHTML(result.Base || '')}</small></div>`;
    } catch (error) {
        if (status) status.innerHTML = `<div><span>Không tải được dữ liệu</span><small>${escapeHTML(error.message)}</small></div>`;
        showToast('Active Directory', error.message, false);
    }
}

function csvCell(value) { return `"${String(value ?? '').replaceAll('"','""')}"`; }
function exportAdUsersCsv() {
    const users = getFilteredAdUsers();
    if (!users.length) return showToast('Xuất CSV', 'Không có dữ liệu để xuất.', false);
    const header = ['Tai khoan','Ho ten','Email','Phong ban','Chuc danh','Trang thai','Bi khoa','OU','Dang nhap cuoi','Distinguished Name'];
    const rows = users.map(u => [u.SamAccountName,u.DisplayName,u.Email,u.Department,u.Title,u.Enabled?'Enabled':'Disabled',u.Locked?'Yes':'No',getOuPathFromDn(u.DistinguishedName),u.LastLogon,u.DistinguishedName]);
    const csv = '\ufeff' + [header,...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `AD_Users_${new Date().toISOString().slice(0,10)}.csv`; link.click(); URL.revokeObjectURL(link.href);
    showToast('Xuất CSV', `Đã xuất ${users.length} tài khoản.`);
}

let adPasswordResolver = null;
function passwordScore(value) {
    let score = 0; if (value.length >= 8) score++; if (value.length >= 12) score++; if (/[a-z]/.test(value)&&/[A-Z]/.test(value)) score++; if (/\d/.test(value)) score++; if (/[^A-Za-z0-9]/.test(value)) score++; return Math.min(4, score);
}
function updateAdPasswordStrength() {
    const value = $('adPasswordNew')?.value || '', score = passwordScore(value), labels=['Rất yếu','Yếu','Trung bình','Mạnh','Rất mạnh'];
    const box=$('adPasswordStrength'); if (!box) return; box.dataset.score=String(score); box.querySelector('span').textContent=value ? labels[score] : 'Chưa nhập mật khẩu';
}
function generateAdPassword() {
    const upper='ABCDEFGHJKLMNPQRSTUVWXYZ', lower='abcdefghijkmnopqrstuvwxyz', nums='23456789', symbols='!@#$%*-_';
    const all=upper+lower+nums+symbols, pick=s=>s[Math.floor(Math.random()*s.length)]; let chars=[pick(upper),pick(lower),pick(nums),pick(symbols)];
    while(chars.length<14) chars.push(pick(all)); chars.sort(()=>Math.random()-.5); return chars.join('');
}
function closeAdPasswordModal(result=null) { const modal=$('adPasswordModal'); if(modal) modal.hidden=true; const resolve=adPasswordResolver; adPasswordResolver=null; if(resolve) resolve(result); }
function openAdPasswordModal(user) {
    $('adPasswordUser').textContent=`Tài khoản: ${user.SamAccountName} — ${user.DisplayName || ''}`; $('adPasswordNew').value=''; $('adPasswordConfirm').value=''; $('adPasswordMustChange').checked=true; $('adPasswordUnlock').checked=!!user.Locked; $('adPasswordError').hidden=true; $('adPasswordModal').hidden=false; updateAdPasswordStrength(); setTimeout(()=>$('adPasswordNew')?.focus(),50);
    return new Promise(resolve=>{adPasswordResolver=resolve;});
}
function submitAdPasswordModal() {
    const password=$('adPasswordNew').value, confirmPassword=$('adPasswordConfirm').value, error=$('adPasswordError');
    if(password.length<8){error.textContent='Mật khẩu phải có ít nhất 8 ký tự.';error.hidden=false;return;} if(password!==confirmPassword){error.textContent='Hai mật khẩu chưa trùng nhau.';error.hidden=false;return;}
    error.hidden=true; closeAdPasswordModal({password,mustChangePassword:$('adPasswordMustChange').checked,unlockAfter:$('adPasswordUnlock').checked});
}
function showAdUserContextMenu(x,y) { const menu=$('adUserContextMenu'), user=App.selectedAdUser; if(!menu||!user)return; menu.querySelector('[data-ad-menu="unlock"]').disabled=!user.Locked; menu.querySelector('[data-ad-menu="enable"]').disabled=user.Enabled; menu.querySelector('[data-ad-menu="disable"]').disabled=!user.Enabled; menu.hidden=false; const r=menu.getBoundingClientRect(); menu.style.left=`${Math.min(x,innerWidth-r.width-8)}px`; menu.style.top=`${Math.min(y,innerHeight-r.height-8)}px`; }
function hideAdUserContextMenu(){const menu=$('adUserContextMenu');if(menu)menu.hidden=true;}

async function runAdUserAction(action) {
    const user = App.selectedAdUser; if (!user) return;
    let password = '', mustChangePassword = true, unlockAfter = false;
    if (action === 'reset-password') {
        const data = await openAdPasswordModal(user); if (!data) return; ({password,mustChangePassword,unlockAfter}=data);
    } else if (action === 'unlock' && !user.Locked) return showToast('Quản lý người dùng','Tài khoản không bị khóa.');
    else if (action === 'enable' && user.Enabled) return;
    else if (action === 'disable' && !user.Enabled) return;
    else if (!confirm(`Xác nhận thao tác “${action}” với tài khoản ${user.SamAccountName}?`)) return;
    try {
        const result = await api('/ad/user/action', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({samAccountName:user.SamAccountName, action, password, mustChangePassword})});
        if (!result.Success) throw new Error(result.Error || 'Thao tác không thành công.');
        if (action==='reset-password' && unlockAfter && user.Locked) await api('/ad/user/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({samAccountName:user.SamAccountName,action:'unlock'})});
        showToast('Quản lý người dùng', result.Message || 'Thao tác thành công.'); await loadAdUsers();
    } catch (error) {
        const diagnosis = error.data?.Diagnosis || error.message;
        showToast('Không thực hiện được', diagnosis, false);
        const panel=$('adPermissionPanel');
        if(panel){ panel.hidden=false; panel.innerHTML=`<div class="permission-error"><strong>Không thể thực hiện thao tác</strong><p>${escapeHTML(diagnosis)}</p>${error.data?.Operator?`<small>Tài khoản chạy: ${escapeHTML(error.data.Operator)}</small>`:''}</div>`; panel.scrollIntoView({behavior:'smooth',block:'nearest'}); }
    }
}


async function checkAdPermission() {
    const user=App.selectedAdUser; if(!user) return;
    const panel=$('adPermissionPanel');
    if(panel){panel.hidden=false;panel.innerHTML='<div class="permission-loading">Đang kiểm tra tài khoản và nhóm bảo mật...</div>';}
    try{
        const result=await api('/ad/permission',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({samAccountName:user.SamAccountName})});
        if(!result.Success) throw new Error(result.Error||'Không kiểm tra được quyền.');
        const roles=result.Roles||{};
        const row=(label,value)=>`<div><span>${escapeHTML(label)}</span><b class="${value?'permission-yes':'permission-no'}">${value?'✓ Có':'— Không'}</b></div>`;
        panel.innerHTML=`<div class="permission-head"><div><small>PERMISSION ANALYZER</small><h3>Quyền quản trị hiện tại</h3></div><button class="icon-btn" data-close-permission>×</button></div><div class="permission-identity"><span>Tài khoản chạy DomainManager</span><strong>${escapeHTML(result.Identity||'—')}</strong></div><div class="permission-grid">${row('Domain Admins',roles.DomainAdmins)}${row('Enterprise Admins',roles.EnterpriseAdmins)}${row('Account Operators',roles.AccountOperators)}${row('Local Administrators',roles.Administrators)}</div><div class="permission-target"><span>Đối tượng</span><b>${escapeHTML(result.TargetSamAccountName||'—')}</b><small>${escapeHTML(result.TargetDistinguishedName||'')}</small></div><p class="permission-note">${escapeHTML(result.Note||'')}</p>`;
        panel.querySelector('[data-close-permission]')?.addEventListener('click',()=>panel.hidden=true);
    }catch(error){panel.innerHTML=`<div class="permission-error"><strong>Không kiểm tra được quyền</strong><p>${escapeHTML(error.message)}</p></div>`;}
}

function initializeAdUsers() {
    $('adUsersRefresh')?.addEventListener('click', loadAdUsers);
    $('adUserSearch')?.addEventListener('input', renderAdUsers);
    $('adUserStatusFilter')?.addEventListener('change', renderAdUsers);
    $('adUserExportBtn')?.addEventListener('click', exportAdUsersCsv);
    $('adUserCopyBtn')?.addEventListener('click', copySelectedAdUser);
    $('adPermissionBtn')?.addEventListener('click', checkAdPermission);
    $('adOuClear')?.addEventListener('click', () => { App.adSelectedOu=''; renderAdOuTree(); renderAdUsers(); });
    $('adPasswordClose')?.addEventListener('click',()=>closeAdPasswordModal(null));
    $('adPasswordCancel')?.addEventListener('click',()=>closeAdPasswordModal(null));
    $('adPasswordSubmit')?.addEventListener('click',submitAdPasswordModal);
    $('adPasswordGenerate')?.addEventListener('click',()=>{const p=generateAdPassword();$('adPasswordNew').value=p;$('adPasswordConfirm').value=p;updateAdPasswordStrength();});
    $('adPasswordToggle')?.addEventListener('click',()=>{const a=$('adPasswordNew'),b=$('adPasswordConfirm'),type=a.type==='password'?'text':'password';a.type=type;b.type=type;});
    $('adPasswordNew')?.addEventListener('input',updateAdPasswordStrength);
    $('adPasswordConfirm')?.addEventListener('keydown',e=>{if(e.key==='Enter')submitAdPasswordModal();});
    $('adPasswordModal')?.addEventListener('click',e=>{if(e.target.id==='adPasswordModal')closeAdPasswordModal(null);});
    $('adUserContextMenu')?.querySelectorAll('[data-ad-menu]').forEach(btn=>btn.addEventListener('click',()=>{const action=btn.dataset.adMenu;hideAdUserContextMenu();if(action==='copy')copySelectedAdUser();else if(action==='properties')$('adUserDetail')?.scrollIntoView({behavior:'smooth',block:'nearest'});else runAdUserAction(action);}));
    document.addEventListener('click',hideAdUserContextMenu);
    document.addEventListener('scroll',hideAdUserContextMenu,true);
}

function initializeApplication() {
    initializeNavigation();
    initializeDetailTabs();
    initializeTableEvents();
    initializeContextMenu();
    initializeConfirmModal();
    initializeComputerDrawer();
    initializeAdUsers();
    initializeInterface();
    loadData();
}

document.addEventListener("DOMContentLoaded", initializeApplication);
