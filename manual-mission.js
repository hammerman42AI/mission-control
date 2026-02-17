import { io } from 'socket.io-client';

const socket = io('http://localhost:8888');

socket.on('connect', () => {
  console.log('Connected. Sending manual mission...');
  socket.emit('manual-mission', {
    agentId: 'legolas',
    command: 'Legolas, go and look for current threats (KEV additions, in-the-wild 0days, ransomware campaigns). Provide links.'
  });
  setTimeout(() => process.exit(0), 500);
});
