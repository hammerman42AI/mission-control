import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { spawn } from 'node:child_process';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8888;

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

const STAGES = ['consultation', 'assignment', 'execution', 'reflection', 'delivery'];

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
  skills: []
};

const broadcast = () => io.emit('telemetry', state);

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
        const msg = log["0"] || log["2"] || log.msg || "";
        const subsystem = log.subsystem || "";
        const metaName = log._meta?.name || "";
        
        // Derive Agent/Council ID
        let councilId = 'celebrimbor'; // default
        if (metaName.includes('main') || msg.includes('main')) councilId = 'samwise';
        if (metaName.includes('auditor')) councilId = 'celebrimbor';

        // --- GATE OF BREE (Approvals) ---
        if (subsystem === 'gateway/exec-approvals' || msg.includes('Approval required')) {
            state.pipeline.active = 'assignment';
            state.gandalf.assignment = "GATE OF BREE: Waiting for Hammer's Mark...";
            state.gandalf.ping = true;
            broadcast();
            return;
        }

        // --- SKILL EXECUTION ---
        let toolName = null;
        if (msg.includes('Calling tool')) {
            const match = msg.match(/Calling tool (\w+)/);
            toolName = match ? match[1] : 'tool';
        } else if (msg.includes('[tools]')) {
            const match = msg.match(/\[tools\] (\w+)/);
            toolName = match ? match[1] : 'tool';
        } else if (log.kind === 'tool_start') {
            toolName = log.tool || 'process';
        }

        if (toolName) {
            state.pipeline.active = 'execution';
            state.workforce[councilId].task = `Executing ${toolName}...`;
            state.workforce[councilId].ping = true;
            state.gandalf.assignment = `${councilId.toUpperCase()} is busy at the Forge.`;

            state.skills.unshift({
                user: councilId,
                skill: toolName,
                target: log["1"] ? (typeof log["1"] === 'string' ? log["1"] : JSON.stringify(log["1"])).substring(0, 40) : 'active pulse',
                summary: `System action: ${toolName}`,
                model: MODELS[councilId],
                time: new Date().toLocaleTimeString(),
                color: COLORS[councilId]
            });
            if (state.skills.length > 10) state.skills.pop();

            setTimeout(() => {
                state.workforce[councilId].ping = false;
                state.pipeline.active = 'reflection';
                broadcast();
            }, 3000);
            broadcast();
            return;
        }

        // --- PIPELINE STAGES ---
        if (msg.includes('Received message') || msg.includes('user_message') || log.kind === 'user_message') {
            state.pipeline.active = 'consultation';
            state.gandalf.command = "Hammer has spoken. Consulting the Council...";
            broadcast();
        }

        if (msg.includes('Run completed') || msg.includes('run_finish') || log.kind === 'run_finish') {
            state.pipeline.active = 'delivery';
            setTimeout(() => {
                state.pipeline.active = null;
                state.gandalf.assignment = "Observing Council of Elrond";
                broadcast();
            }, 5000);
            broadcast();
        }

    } catch (e) {
        // Simple string parsing fallback
        if (line.includes('Calling tool')) {
            state.pipeline.active = 'execution';
            broadcast();
        }
    }
};

if (fs.existsSync(logPath)) {
    const tail = spawn('tail', ['-f', '-n', '50', logPath]);
    tail.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach(processLogLine);
    });
}

io.on('connection', (socket) => {
  console.log('Client connected to REAL Mission Control');
  broadcast();
  
  socket.on('manual-mission', (mission) => {
      state.pipeline.active = 'consultation';
      state.gandalf.command = mission.command;
      broadcast();
  });

  // Approval Handlers
  socket.on('approve-action', (data) => {
    // To be implemented: Link back to openclaw gateway approvals
    console.log('Dashboard Approval Received:', data);
  });
});

server.listen(PORT, () => {
  console.log(`REAL Mission Control running at: http://localhost:${PORT}`);
});
