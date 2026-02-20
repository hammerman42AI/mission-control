import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { spawn } from 'node:child_process';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8888;

// OpenClaw Gateway Config
const GATEWAY_PORT = process.env.OPENCLAW_GATEWAY_PORT || 18789;
const GATEWAY_HTTP_URL = `http://127.0.0.1:${GATEWAY_PORT}`;
const GATEWAY_WS_URL = `ws://127.0.0.1:${GATEWAY_PORT}`;

// Dynamic Token Discovery: Read from Source of Truth
function getLiveGatewayToken() {
  try {
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    if (!fs.existsSync(configPath)) return null;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.gateway?.auth?.token || null;
  } catch (e) {
    console.error('Failed to read live gateway token:', e.message);
    return null;
  }
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const extname = path.extname(filePath);
  const contentType = MIME_TYPES[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404);
        res.end('File not found');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${error.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

const io = new Server(server);

const MODELS = {
  celebrimbor: "minimax-m2.5:cloud",
  samwise: "gemini-3-flash",
  legolas: "gemini-3-flash",
  elrond: "mxbai-embed-large"
};

const COLORS = {
  celebrimbor: "var(--accent-cyan)",
  samwise: "#00ff88",
  legolas: "var(--accent-red)",
  elrond: "var(--accent-gold)"
};

// State
const state = {
  ringOfPower: { totalTokens: 0, hourlyRate: 0, costEstimate: "0.00", corruptionLevel: 0 },
  vitals: { load: 0 },
  workforce: {
    celebrimbor: { task: "Idle", ping: false, model: MODELS.celebrimbor },
    samwise: { task: "Idle", ping: false, model: MODELS.samwise },
    legolas: { task: "Idle", ping: false, model: MODELS.legolas },
    elrond: { task: "Idle", ping: false, model: MODELS.elrond }
  },
  gandalf: {
    command: "Monitoring System Pulse...",
    assignment: "Observing Council of Elrond",
    ping: false
  },
  pipeline: { active: null },
  skills: [],
  approvalPending: null,
  approvals: []
};

const agentMap = {
  'auditor': 'celebrimbor',
  'main': 'samwise'
};

const broadcast = () => io.emit('telemetry', state);

// --- Gateway WS RPC (minimal) ---
let gw;
let gwConnected = false;
let rpcId = 1;
const rpcPending = new Map();

function gwSend(obj) {
  if (!gwConnected) throw new Error('Gateway WS not connected');
  gw.send(JSON.stringify(obj));
}

async function gwRequest(method, params = {}) {
  const id = rpcId++;
  const payload = { id, method, params };
  return await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      rpcPending.delete(id);
      reject(new Error(`Gateway RPC timeout: ${method}`));
    }, 10000);
    rpcPending.set(id, { resolve, reject, t, method });
    gwSend(payload);
  });
}

function approvalsUpsert(item) {
  const id = item?.id;
  if (!id) return;
  const idx = state.approvals.findIndex(a => a.id === id);
  if (idx >= 0) state.approvals[idx] = { ...state.approvals[idx], ...item };
  else state.approvals.unshift(item);
  state.approvals = state.approvals.slice(0, 20);

  // Back-compat: keep single pending approval for existing UI
  state.approvalPending = state.approvals[0] || null;
}

function approvalsRemove(id) {
  state.approvals = state.approvals.filter(a => a.id !== id);
  state.approvalPending = state.approvals[0] || null;
}

function connectGatewayWs() {
  const token = getLiveGatewayToken();
  if (!token) {
    console.log('Gateway token not found in config. Retrying in 5s...');
    setTimeout(connectGatewayWs, 5000);
    return;
  }

  const url = `${GATEWAY_WS_URL}/?token=${encodeURIComponent(token)}`;
  gw = new WebSocket(url);

  gw.onopen = () => {
    gwConnected = true;
    console.log('Connected to OpenClaw Gateway WS');
  };

  gw.onclose = () => {
    gwConnected = false;
    console.log('Gateway WS closed; retrying in 1s');
    setTimeout(connectGatewayWs, 1000);
  };

  gw.onerror = (err) => {
    console.error('Gateway WS error:', err);
  };

  gw.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }

    // RPC response
    if (msg && typeof msg.id === 'number' && (msg.ok !== undefined || msg.result !== undefined || msg.error !== undefined)) {
      const p = rpcPending.get(msg.id);
      if (!p) return;
      clearTimeout(p.t);
      rpcPending.delete(msg.id);
      if (msg.ok === false || msg.error) p.reject(new Error(msg.error?.message || msg.error || 'RPC error'));
      else p.resolve(msg.result ?? msg);
      return;
    }

    // Broadcast event envelope (best-effort)
    const event = msg?.event || msg?.type;
    const data = msg?.data || msg?.payload || msg;

    if (event === 'exec.approval.requested') {
      const req = data?.request || data;
      approvalsUpsert({
        id: data?.id || req?.id,
        command: req?.command,
        request: req,
        receivedAt: Date.now()
      });
      state.pipeline.active = 'assignment';
      state.gandalf.assignment = "GATE OF BREE: Waiting for Hammer's Mark...";
      state.gandalf.ping = true;
      broadcast();
      return;
    }

    if (event === 'exec.approval.resolved') {
      approvalsRemove(data?.id);
      state.gandalf.assignment = `Gate of Bree resolved: ${data?.decision || 'ok'}`;
      broadcast();
      return;
    }
  };
}

connectGatewayWs();

// --- Real Data Ingestion ---

// 1. System Vitals
setInterval(() => {
  const load = os.loadavg()[0];
  const cpuCount = os.cpus().length;
  state.vitals.load = Math.min(100, Math.round((load / cpuCount) * 100));
  broadcast();
}, 5000);

// 2. OpenClaw Status (Tokens)
const updateTokens = () => {
  const proc = spawn('openclaw', ['status', '--json']);
  let data = '';
  proc.stdout.on('data', (chunk) => data += chunk);
  proc.on('close', () => {
    try {
        const status = JSON.parse(data);
        let total = 0;
        if (status.sessions) {
            status.sessions.forEach(s => {
                total += (s.tokens?.total || 0);
            });
        }
        state.ringOfPower.totalTokens = total;
        state.ringOfPower.corruptionLevel = Math.min(100, (total / 1000000) * 100);
    } catch (e) {}
    broadcast();
  });
};
setInterval(updateTokens, 60000);
updateTokens();

// 3. Log Tailing (Robust Parsing)
const logPath = `/tmp/openclaw/openclaw-${new Date().toISOString().split('T')[0]}.log`;

const processLogLine = (line) => {
    if (!line.trim()) return;
    try {
        const log = JSON.parse(line);

        // Extract message text
        let msg = '';
        if (typeof log["1"] === 'string') msg = log["1"];
        else if (typeof log["0"] === 'string') msg = log["0"];
        else if (typeof log.msg === 'string') msg = log.msg;

        // Extract subsystem (may be nested JSON string in log["0"])
        let subsystem = log.subsystem || "";
        if (!subsystem && typeof log["0"] === 'string' && log["0"].startsWith('{')) {
            try {
                const inner = JSON.parse(log["0"]);
                subsystem = inner.subsystem || "";
            } catch {}
        }

        const metaName = log._meta?.name || "";

        // DEBUG: surface key log lines so we know ingestion works
        if (msg && (msg.includes('embedded run tool') || msg.includes('Received message') || msg.includes('run_finish'))) {
            console.log('[MissionControl][log]', msg);
        }
        
        // Derive Agent/Council ID
        let councilId = 'celebrimbor'; // default
        if (metaName.includes('main') || msg.includes('main') || msg.includes('sessionId=5166e84b') || log.sessionId === '5166e84b-c182-419d-8a96-9e275fc464b7') councilId = 'samwise';
        if (metaName.includes('auditor')) councilId = 'celebrimbor';
        if (msg.includes('subagent') || log.sessionId?.includes('subagent')) councilId = 'legolas';

        // TOOL EXECUTION STATE UPDATES
        let toolName = null;
        const match = msg.match(/tool=(\w+)/);
        if (match) toolName = match[1];

        if (msg.includes('embedded run tool start')) {
            state.pipeline.active = 'execution';
            state.workforce[councilId].task = toolName ? `Executing ${toolName}...` : 'Executing task...';
            state.workforce[councilId].ping = true;

            state.gandalf.assignment = `${councilId.toUpperCase()} is busy at the Forge.`;

            state.skills.unshift({
                user: councilId,
                skill: toolName || 'tool',
                target: 'active pulse',
                summary: `System action: ${toolName || 'tool'}`,
                model: MODELS[councilId],
                time: new Date().toLocaleTimeString(),
                color: COLORS[councilId]
            });
            if (state.skills.length > 10) state.skills.pop();

            broadcast();
            return;
        }

        if (msg.includes('embedded run tool end')) {
            state.workforce[councilId].task = 'Idle';
            state.workforce[councilId].ping = false;
            state.pipeline.active = 'reflection';

            // allow UI to show reflection briefly, then clear
            setTimeout(() => {
                state.pipeline.active = null;
                state.gandalf.assignment = 'Observing Council of Elrond';
                broadcast();
            }, 3000);

            broadcast();
            return;
        }

        // --- GATE OF BREE (Approvals) ---
        // Format: {"subsystem":"gateway/exec-approvals","id":"...","command":"..."}
        if (subsystem === 'gateway/exec-approvals' && (log.id || log.requestId)) {
            state.approvalPending = {
                id: log.id || log.requestId,
                command: log.command || log.msg || "Restricted System Action"
            };
            state.pipeline.active = 'assignment';
            state.gandalf.assignment = "GATE OF BREE: Waiting for Hammer's Mark...";
            state.gandalf.ping = true;
            broadcast();
            return;
        }

        // Catch textual approval requirements
        if (msg.includes('Approval required') || msg.includes('Permission requested')) {
             // If we didn't get an ID from structured log, try to find it in text
             const idMatch = msg.match(/ID: ([\w-]+)/) || msg.match(/id: ([\w-]+)/);
             if (idMatch) {
                 state.approvalPending = {
                     id: idMatch[1],
                     command: msg
                 };
             }
             state.pipeline.active = 'assignment';
             state.gandalf.assignment = "GATE OF BREE: Pending User Approval...";
             state.gandalf.ping = true;
             broadcast();
             return;
        }

        // --- SKILL EXECUTION (unified) ---
        // (removed in favor of simpler embedded-run handling above)

        // --- PIPELINE STAGES ---
        if (msg.includes('Received message') || msg.includes('user_message') || log.kind === 'user_message') {
            state.pipeline.active = 'consultation';
            state.gandalf.command = "Hammer has spoken. Consulting the Council...";
            broadcast();
        }

        if (msg.includes('Run completed') || msg.includes('run_finish') || log.kind === 'run_finish') {
            state.pipeline.active = 'delivery';
            state.approvalPending = null; // Clear any stale approvals
            setTimeout(() => {
                state.pipeline.active = null;
                state.gandalf.assignment = "Observing Council of Elrond";
                broadcast();
            }, 5000);
            broadcast();
        }

    } catch (e) {}
};

if (fs.existsSync(logPath)) {
  console.log('[MissionControl] Starting Node log watcher on', logPath);

  let offset = 0;
  try {
    const stat = fs.statSync(logPath);
    offset = stat.size; // start at EOF, like tail -f
  } catch (e) {
    console.error('[MissionControl] Failed to stat log file:', e.message);
  }

  const readNewData = () => {
    fs.stat(logPath, (err, stat) => {
      if (err) {
        console.error('[MissionControl] log stat error:', err.message);
        return;
      }
      if (stat.size <= offset) return; // nothing new

      const length = stat.size - offset;
      const buffer = Buffer.alloc(length);
      fs.open(logPath, 'r', (openErr, fd) => {
        if (openErr) {
          console.error('[MissionControl] log open error:', openErr.message);
          return;
        }
        fs.read(fd, buffer, 0, length, offset, (readErr, bytesRead) => {
          fs.close(fd, () => {});
          if (readErr || !bytesRead) return;
          offset += bytesRead;
          const chunk = buffer.toString('utf8', 0, bytesRead);
          console.log('[MissionControl][chunk]', JSON.stringify(chunk.slice(0, 200)));
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            console.log('[MissionControl][line]', line.slice(0, 200));
            processLogLine(line);
          }
        });
      });
    });
  };

  // Poll every 1s for new data (tail -f style)
  setInterval(readNewData, 1000);
} else {
  console.warn('[MissionControl] Log file not found:', logPath);
}

io.on('connection', (socket) => {
  console.log('Client connected to REAL Mission Control');
  broadcast();
  
  socket.on('manual-mission', (mission) => {
      state.pipeline.active = 'consultation';
      state.gandalf.command = mission.command;
      broadcast();
  });

  // --- GATE OF BREE DECISION HANDLER ---
  socket.on('approve-decision', async (data) => {
    console.log('Gate of Bree Decision:', data);
    const { id, allow } = data;
    
    try {
        const decision = allow ? 'allow-once' : 'deny';
        const result = await gwRequest('exec.approval.resolve', { id, decision });
        console.log('Gateway exec.approval.resolve result:', result);

        approvalsRemove(id);
        state.gandalf.assignment = allow ? "Hammer's Mark received (allow-once). Proceeding." : "Entry denied. Task aborted.";
        broadcast();

    } catch (e) {
        console.error('Failed to resolve exec approval via gateway WS:', e);
        state.gandalf.assignment = `Gate of Bree error: ${String(e)}`;
        broadcast();
    }
  });
});

server.listen(PORT, () => {
  console.log(`REAL Mission Control running at: http://localhost:${PORT}`);
});
